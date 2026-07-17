import { describe, it, expect } from "vitest";
import {
  parseDockerPs,
  containersVerdict,
  parseListeningPorts,
  listenersVerdict,
  parseUfwStatus,
  firewallVerdict,
  summarizeMailLog,
  ipv6DeliveryVerdict,
  parseContainerApi,
  REQUIRED_CONTAINERS,
} from "../health-checks";

// Real-shaped `docker ps -a --format '{{.Names}}\t{{.State}}\t{{.Status}}'` output. Mailcow's
// compose prefixes container names, so matching must be by substring.
const DOCKER_PS_HEALTHY = [
  "mailcowdockerized-postfix-mailcow-1\trunning\tUp 2 hours (healthy)",
  "mailcowdockerized-dovecot-mailcow-1\trunning\tUp 2 hours (healthy)",
  "mailcowdockerized-nginx-mailcow-1\trunning\tUp 2 hours",
  "mailcowdockerized-rspamd-mailcow-1\trunning\tUp 2 hours (healthy)",
  "mailcowdockerized-mysql-mailcow-1\trunning\tUp 2 hours (healthy)",
  "mailcowdockerized-redis-mailcow-1\trunning\tUp 2 hours (healthy)",
].join("\n");

describe("parseDockerPs / containersVerdict", () => {
  it("reads a healthy stack as ok", () => {
    const rows = parseDockerPs(DOCKER_PS_HEALTHY);
    expect(rows).toHaveLength(6);
    const v = containersVerdict(rows);
    expect(v).toEqual({ status: "ok", missing: [], stopped: [], unhealthy: [] });
  });

  it("flags a stopped container as fail and an unhealthy one as warn", () => {
    const stopped = parseDockerPs(
      DOCKER_PS_HEALTHY.replace(
        "mailcowdockerized-postfix-mailcow-1\trunning\tUp 2 hours (healthy)",
        "mailcowdockerized-postfix-mailcow-1\texited\tExited (1) 5 minutes ago",
      ),
    );
    const sv = containersVerdict(stopped);
    expect(sv.status).toBe("fail");
    expect(sv.stopped).toContain("postfix");

    const unhealthy = parseDockerPs(
      DOCKER_PS_HEALTHY.replace("Up 2 hours (healthy)", "Up 2 hours (unhealthy)"),
    );
    const uv = containersVerdict(unhealthy);
    expect(uv.status).toBe("warn");
    expect(uv.unhealthy).toContain("postfix");
  });

  it("reports every core service missing when nothing is running", () => {
    const v = containersVerdict([]);
    expect(v.status).toBe("fail");
    expect(v.missing).toEqual(REQUIRED_CONTAINERS);
  });

  it("ignores blank lines and malformed rows", () => {
    expect(parseDockerPs("\n\n   \n")).toEqual([]);
  });
});

describe("parseListeningPorts / listenersVerdict", () => {
  const SS = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      100    0.0.0.0:25         0.0.0.0:*    users:(("docker-proxy",pid=111,fd=4))
LISTEN 0      100    0.0.0.0:465        0.0.0.0:*    users:(("docker-proxy",pid=112,fd=4))
LISTEN 0      100    [::]:587           [::]:*
LISTEN 0      128    127.0.0.1:22       0.0.0.0:*`;

  it("extracts the local listening ports", () => {
    const ports = parseListeningPorts(SS);
    expect(ports).toContain(25);
    expect(ports).toContain(465);
    expect(ports).toContain(587);
    expect(ports).toContain(22);
    // The peer address (0.0.0.0:*) must not be parsed as a port.
    expect(ports.every((p) => p > 0 && p <= 65535)).toBe(true);
  });

  it("passes when 25/465/587 all listen, and names the missing ones otherwise", () => {
    expect(listenersVerdict(parseListeningPorts(SS))).toEqual({ status: "ok", missing: [] });
    const without = SS.split("\n")
      .filter((l) => !l.includes(":465") && !l.includes(":587"))
      .join("\n");
    const v = listenersVerdict(parseListeningPorts(without));
    expect(v.status).toBe("fail");
    expect(v.missing).toEqual([465, 587]);
  });
});

describe("parseUfwStatus / firewallVerdict", () => {
  it("treats an inactive firewall as not blocking anything", () => {
    const parsed = parseUfwStatus("Status: inactive");
    expect(parsed.active).toBe(false);
    expect(firewallVerdict(parsed)).toEqual({ status: "ok", blocked: [] });
  });

  it("passes when every mail port is allowed", () => {
    const out = `Status: active

To                         Action      From
--                         ------      ----
25/tcp                     ALLOW       Anywhere
465/tcp                    ALLOW       Anywhere
587/tcp                    ALLOW       Anywhere
80/tcp                     ALLOW       Anywhere
443/tcp                    ALLOW       Anywhere
993/tcp                    ALLOW       Anywhere
995/tcp                    ALLOW       Anywhere`;
    const parsed = parseUfwStatus(out);
    expect(parsed.active).toBe(true);
    expect(firewallVerdict(parsed)).toEqual({ status: "ok", blocked: [] });
  });

  it("names the ports an active firewall is blocking", () => {
    const out = `Status: active

To                         Action      From
--                         ------      ----
80/tcp                     ALLOW       Anywhere
443/tcp                    ALLOW       Anywhere`;
    const v = firewallVerdict(parseUfwStatus(out));
    expect(v.status).toBe("fail");
    expect(v.blocked).toEqual([25, 465, 587, 993, 995]);
  });
});

describe("summarizeMailLog", () => {
  it("counts and classifies delivery errors, keeping sample lines", () => {
    const log = [
      "Jul 16 02:00:01 mail postfix/smtp[1]: A1: to=<a@x.com>, status=deferred (connect to mx.x.com[1.2.3.4]:25: Connection timed out)",
      "Jul 16 02:00:02 mail postfix/smtp[2]: B2: to=<b@y.com>, status=deferred (Host not found)",
      "Jul 16 02:00:03 mail postfix/smtp[3]: C3: to=<c@z.com>, status=bounced (host z said: 550 5.7.26 unauthenticated)",
      "Jul 16 02:00:04 mail postfix/smtp[4]: D4: to=<d@w.com>, status=sent (250 ok)",
    ].join("\n");
    const s = summarizeMailLog(log);
    expect(s.deferred).toBe(2);
    expect(s.bounced).toBe(1);
    expect(s.timeouts).toBe(1);
    expect(s.hostNotFound).toBe(1);
    expect(s.blocked).toBe(1);
    expect(s.samples.length).toBeGreaterThan(0);
    // status=sent must not be reported as an error.
    expect(s.samples.some((l) => l.includes("status=sent"))).toBe(false);
  });

  it("reports a clean log as all-zero", () => {
    const s = summarizeMailLog("Jul 16 02:00:04 mail postfix/smtp[4]: D4: status=sent (250 ok)");
    expect(s.deferred + s.bounced + s.timeouts + s.hostNotFound + s.blocked).toBe(0);
    expect(s.samples).toEqual([]);
  });

  it("splits timeouts by address family from the bracketed address", () => {
    const log = [
      "Jul 17 01:00:01 mail postfix/smtp[1]: A1: to=<a@gmail.com>, status=deferred (connect to gmail-smtp-in.l.google.com[2a00:1450:400c:c0b::1a]:25: Connection timed out)",
      "Jul 17 01:00:02 mail postfix/smtp[2]: B2: to=<b@gmail.com>, status=deferred (connect to alt1.gmail-smtp-in.l.google.com[2a00:1450:4025:401::1b]:25: Connection timed out)",
      "Jul 17 01:00:03 mail postfix/smtp[3]: C3: to=<c@x.com>, status=deferred (connect to mx.x.com[203.0.113.7]:25: Connection timed out)",
    ].join("\n");
    const s = summarizeMailLog(log);
    expect(s.ipv6Timeouts).toBe(2);
    expect(s.ipv4Timeouts).toBe(1);
  });
});

describe("parseContainerApi", () => {
  it("reads a real container list", () => {
    const json = {
      "postfix-mailcow": { type: "info", container: "postfix-mailcow", state: "running" },
      "dovecot-mailcow": { type: "info", container: "dovecot-mailcow", state: "running" },
      "nginx-mailcow": { type: "info", container: "nginx-mailcow", state: "exited" },
    };
    expect(parseContainerApi(json)).toEqual({ kind: "containers", running: 2, total: 3 });
  });

  it("does NOT report an API error as '0/2 containers running'", () => {
    // Mailcow rejects a bad key/allow-list with {"type":"error","msg":"..."}. Object.values()'d
    // naively that's 2 entries with 0 running — which reported a healthy server as CRITICAL.
    expect(parseContainerApi({ type: "error", msg: "authentication failed" })).toEqual({
      kind: "apiError",
      message: "authentication failed",
    });
    expect(parseContainerApi([{ type: "danger", msg: "api key invalid" }])).toEqual({
      kind: "apiError",
      message: "api key invalid",
    });
  });

  it("treats anything without container state fields as unexpected, not as containers", () => {
    expect(parseContainerApi({ foo: "bar", baz: "qux" })).toEqual({ kind: "unexpected" });
    expect(parseContainerApi("<html>login</html>")).toEqual({ kind: "unexpected" });
    expect(parseContainerApi(null)).toEqual({ kind: "unexpected" });
    expect(parseContainerApi({})).toEqual({ kind: "unexpected" });
  });
});

describe("ipv6DeliveryVerdict", () => {
  it("identifies broken IPv6 when v6 times out but IPv4 port 25 works", () => {
    // The exact reported shape: port 25 reachable, queue full of timeouts — all on IPv6.
    expect(ipv6DeliveryVerdict({ ipv6Timeouts: 24, ipv4Timeouts: 0 }, true)).toBe("broken-ipv6");
    expect(ipv6DeliveryVerdict({ ipv6Timeouts: 20, ipv4Timeouts: 2 }, true)).toBe("broken-ipv6");
  });

  it("does NOT blame IPv6 when outbound port 25 is actually blocked", () => {
    // A real provider block times out on everything — misreading that as an IPv6 fault would
    // send the user to change Postfix config for nothing.
    expect(ipv6DeliveryVerdict({ ipv6Timeouts: 24, ipv4Timeouts: 24 }, false)).toBe("ok");
    expect(ipv6DeliveryVerdict({ ipv6Timeouts: 5, ipv4Timeouts: 0 }, false)).toBe("ok");
  });

  it("does NOT blame IPv6 when IPv4 is failing just as much", () => {
    expect(ipv6DeliveryVerdict({ ipv6Timeouts: 5, ipv4Timeouts: 9 }, true)).toBe("ok");
    expect(ipv6DeliveryVerdict({ ipv6Timeouts: 5, ipv4Timeouts: 5 }, true)).toBe("ok");
  });

  it("stays ok when there are no IPv6 timeouts at all", () => {
    expect(ipv6DeliveryVerdict({ ipv6Timeouts: 0, ipv4Timeouts: 0 }, true)).toBe("ok");
    expect(ipv6DeliveryVerdict({ ipv6Timeouts: 0, ipv4Timeouts: 12 }, true)).toBe("ok");
  });
});
