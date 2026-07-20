import { describe, it, expect } from "vitest";
import {
  classifyPort25,
  fcrdnsVerdict,
  dkimKeyMatch,
  parsePostfixQueue,
  queueVerdict,
  dominantDeferral,
  sortByPriority,
  blacklistVerdict,
  spfLookupCount,
  spfVerdict,
  dmarcPolicyVerdict,
  mxTargetVerdict,
  parseSmtpDialogue,
  smtpBannerVerdict,
} from "../health-checks";
import type { Indicator } from "../health-types";

describe("classifyPort25", () => {
  it("classifies open/blocked/partial", () => {
    expect(classifyPort25(["open", "open"])).toBe("open");
    expect(classifyPort25(["blocked", "blocked"])).toBe("blocked");
    expect(classifyPort25(["open", "blocked"])).toBe("partial");
    expect(classifyPort25([])).toBe("blocked");
  });
});

describe("fcrdnsVerdict", () => {
  it("confirms only when PTR forward-resolves back to the IP", () => {
    expect(fcrdnsVerdict("1.2.3.4", ["mail.x.com"], ["1.2.3.4"])).toBe("confirmed");
    expect(fcrdnsVerdict("1.2.3.4", ["mail.x.com"], ["9.9.9.9"])).toBe("mismatch");
    expect(fcrdnsVerdict("1.2.3.4", [], [])).toBe("missing");
  });

  it("reports 'proxied' (not a mismatch) when a correct PTR is masked by a proxy", () => {
    // PTR is set, but the host forward-resolves to proxy IPs — reverse DNS itself is fine.
    expect(fcrdnsVerdict("1.2.3.4", ["mail.x.com"], ["104.21.17.99"], true)).toBe("proxied");
    // No PTR at all still wins, even if the forward set is proxied.
    expect(fcrdnsVerdict("1.2.3.4", [], ["104.21.17.99"], true)).toBe("missing");
    // A genuine mismatch (non-proxy IPs) is unaffected.
    expect(fcrdnsVerdict("1.2.3.4", ["mail.x.com"], ["9.9.9.9"], false)).toBe("mismatch");
  });
});

describe("dkimKeyMatch", () => {
  const key = "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ";
  it("matches a published key equal to Mailcow's", () => {
    const r = dkimKeyMatch([`v=DKIM1; k=rsa; p=${key}`], key);
    expect(r).toEqual({ published: true, matches: true });
  });
  it("flags a published-but-mismatched key (rotated, not republished)", () => {
    const r = dkimKeyMatch([`v=DKIM1; k=rsa; p=${key}`], "DIFFERENTKEY123");
    expect(r).toEqual({ published: true, matches: false });
  });
  it("reports missing when no p= key is present", () => {
    expect(dkimKeyMatch([`v=DKIM1; k=rsa; p=`], key)).toEqual({ published: false, matches: false });
    expect(dkimKeyMatch([], key)).toEqual({ published: false, matches: false });
  });
  it("tolerates chunked/whitespaced TXT and quotes", () => {
    const r = dkimKeyMatch([`"v=DKIM1; k=rsa; p=MIGfMA0GCS" "qGSIb3DQEBAQUAA4GNADCBiQKBgQ"`], key);
    expect(r.matches).toBe(true);
  });
});

describe("parsePostfixQueue", () => {
  const NOW = Date.UTC(2026, 6, 11, 15, 0, 0); // 2026-07-11 15:00 UTC

  it("returns zero for an empty queue", () => {
    const s = parsePostfixQueue("Mail queue is empty", NOW);
    expect(s.count).toBe(0);
    expect(s.oldestAgeMinutes).toBeNull();
  });

  it("counts entries, ages the oldest, and classifies deferrals", () => {
    const out = [
      "-Queue ID-  --Size-- ----Arrival Time---- -Sender/Recipient-------",
      "A1B2C3D4E5     1234 Sat Jul 11 14:30:00  sender@x.com",
      "(connect to gmail-smtp-in.l.google.com[1.2.3.4]:25: Connection timed out)",
      "                                         to@gmail.com",
      "",
      "F6G7H8I9J0!    2048 Sat Jul 11 12:00:00  sender@x.com",
      "(host mx.example.com[5.6.7.8] said: 550 5.7.1 blocked using spamhaus)",
      "                                         to@example.com",
      "",
      "-- 3 Kbytes in 2 Requests.",
    ].join("\n");
    const s = parsePostfixQueue(out, NOW);
    expect(s.count).toBe(2);
    expect(s.oldestAgeMinutes).toBe(180); // 12:00 -> 15:00 = 180 min
    expect(s.deferrals.timeout).toBe(1);
    expect(s.deferrals.rejected).toBe(1);
  });
});

describe("queueVerdict / dominantDeferral", () => {
  it("ok when empty, warn/fail past thresholds", () => {
    expect(
      queueVerdict({
        count: 0,
        oldestAgeMinutes: null,
        deferrals: { timeout: 0, rejected: 0, other: 0 },
      }),
    ).toBe("ok");
    expect(
      queueVerdict({
        count: 60,
        oldestAgeMinutes: 10,
        deferrals: { timeout: 0, rejected: 0, other: 0 },
      }),
    ).toBe("warn");
    expect(
      queueVerdict({
        count: 60,
        oldestAgeMinutes: 500,
        deferrals: { timeout: 0, rejected: 0, other: 0 },
      }),
    ).toBe("fail");
  });
  it("warns on a small but stuck queue that keeps deferring", () => {
    // Real case: 26 messages, oldest 6h, dominated by connection timeouts. Under both hard
    // thresholds, but mail is plainly not being delivered — must not read as healthy.
    expect(
      queueVerdict({
        count: 26,
        oldestAgeMinutes: 360,
        deferrals: { timeout: 24, rejected: 0, other: 2 },
      }),
    ).toBe("warn");
    // Even a couple of messages that have been failing for an hour is worth flagging.
    expect(
      queueVerdict({
        count: 2,
        oldestAgeMinutes: 90,
        deferrals: { timeout: 2, rejected: 0, other: 0 },
      }),
    ).toBe("warn");
  });

  it("fails (not warns) once mail has been stuck for a day or more", () => {
    // Real case: 31 messages, oldest 78h. Under the count threshold, but mail this old is on a
    // countdown to bouncing — reporting it as a mere warning understates it.
    expect(
      queueVerdict({
        count: 31,
        oldestAgeMinutes: 78 * 60,
        deferrals: { timeout: 24, rejected: 0, other: 7 },
      }),
    ).toBe("fail");
    // Even a single message stuck over a day is a failure.
    expect(
      queueVerdict({
        count: 1,
        oldestAgeMinutes: 1500,
        deferrals: { timeout: 1, rejected: 0, other: 0 },
      }),
    ).toBe("fail");
  });

  it("stays ok for a young queue that is simply in flight", () => {
    // Fresh mail with no deferral reasons is normal throughput, not a problem.
    expect(
      queueVerdict({
        count: 5,
        oldestAgeMinutes: 2,
        deferrals: { timeout: 0, rejected: 0, other: 0 },
      }),
    ).toBe("ok");
    // Deferrals that are still young (greylisting clears on retry) stay ok.
    expect(
      queueVerdict({
        count: 3,
        oldestAgeMinutes: 10,
        deferrals: { timeout: 1, rejected: 0, other: 0 },
      }),
    ).toBe("ok");
  });

  it("picks the dominant deferral reason", () => {
    expect(
      dominantDeferral({
        count: 3,
        oldestAgeMinutes: 1,
        deferrals: { timeout: 2, rejected: 1, other: 0 },
      }),
    ).toBe("timeout");
    expect(
      dominantDeferral({
        count: 0,
        oldestAgeMinutes: null,
        deferrals: { timeout: 0, rejected: 0, other: 0 },
      }),
    ).toBeNull();
  });
});

describe("blacklistVerdict", () => {
  const MAJOR = ["zen.spamhaus.org", "b.barracudacentral.org", "bl.spamcop.net"];
  it("clean → ok", () => expect(blacklistVerdict([], MAJOR)).toBe("ok"));
  it("major listing → fail", () =>
    expect(blacklistVerdict(["zen.spamhaus.org"], MAJOR)).toBe("fail"));
  it("secondary-only → warn", () =>
    expect(blacklistVerdict(["dnsbl.sorbs.net", "psbl.surriel.com"], MAJOR)).toBe("warn"));
  it("major + secondary → fail (major wins)", () =>
    expect(blacklistVerdict(["dnsbl.sorbs.net", "bl.spamcop.net"], MAJOR)).toBe("fail"));
});

describe("spfLookupCount / spfVerdict", () => {
  it("counts DNS-lookup mechanisms only", () => {
    expect(spfLookupCount("v=spf1 include:a.com include:b.com mx a ip4:1.2.3.0/24 ~all")).toBe(4);
    expect(spfLookupCount("v=spf1 ip4:1.2.3.4 ip6:::1 -all")).toBe(0);
    expect(spfLookupCount("v=spf1 redirect=_spf.example.com")).toBe(1);
  });
  it("missing / multiple → fail", () => {
    expect(spfVerdict([]).status).toBe("fail");
    expect(spfVerdict(["v=spf1 -all", "v=spf1 ~all"]).status).toBe("fail");
  });
  it(">10 lookups → warn (permerror)", () => {
    const rec = "v=spf1 " + Array.from({ length: 11 }, (_, i) => `include:d${i}.com`).join(" ") + " ~all";
    expect(spfVerdict([rec]).status).toBe("warn");
  });
  it("+all / ?all → warn", () => {
    expect(spfVerdict(["v=spf1 include:a.com +all"]).status).toBe("warn");
    expect(spfVerdict(["v=spf1 all"]).status).toBe("warn"); // bare all = +all
  });
  it("clean ~all/-all → ok", () => {
    expect(spfVerdict(["v=spf1 include:a.com ~all"]).status).toBe("ok");
    expect(spfVerdict(["v=spf1 mx -all"]).status).toBe("ok");
  });
});

describe("dmarcPolicyVerdict", () => {
  it("p=none → warn (monitor only)", () =>
    expect(dmarcPolicyVerdict("v=DMARC1; p=none; rua=mailto:x@y.com").status).toBe("warn"));
  it("p=quarantine / p=reject → ok", () => {
    expect(dmarcPolicyVerdict("v=DMARC1; p=quarantine").status).toBe("ok");
    expect(dmarcPolicyVerdict("v=DMARC1; p=reject; rua=mailto:x@y.com").status).toBe("ok");
  });
  it("no policy / not DMARC → fail", () => {
    expect(dmarcPolicyVerdict("v=DMARC1; rua=mailto:x@y.com").status).toBe("fail");
    expect(dmarcPolicyVerdict("v=spf1 -all").status).toBe("fail");
  });
});

describe("mxTargetVerdict", () => {
  it("IP literal → warn", () => expect(mxTargetVerdict("1.2.3.4", true).status).toBe("warn"));
  it("hostname without A → warn", () =>
    expect(mxTargetVerdict("mail.example.com", false).status).toBe("warn"));
  it("resolvable hostname → ok", () =>
    expect(mxTargetVerdict("mail.example.com", true).status).toBe("ok"));
});

describe("parseSmtpDialogue / smtpBannerVerdict", () => {
  it("extracts banner host + STARTTLS cap", () => {
    const raw = "220 mail.example.com ESMTP Postfix\r\n250-mail.example.com\r\n250-PIPELINING\r\n250-STARTTLS\r\n250 8BITMIME\r\n221 Bye\r\n";
    const d = parseSmtpDialogue(raw);
    expect(d.bannerHost).toBe("mail.example.com");
    expect(d.caps).toContain("STARTTLS");
  });
  it("banner FQDN → ok; localhost/IP → warn", () => {
    expect(smtpBannerVerdict("mail.example.com").status).toBe("ok");
    expect(smtpBannerVerdict("localhost").status).toBe("warn");
    expect(smtpBannerVerdict("127.0.0.1").status).toBe("warn");
    expect(smtpBannerVerdict("").status).toBe("warn");
  });
});

describe("sortByPriority", () => {
  it("orders port25 and blacklist ahead of queue and tls", () => {
    const ind: Indicator[] = [
      { id: "tls", label: "TLS", status: "fail", detail: "" },
      { id: "queue", label: "Queue", status: "warn", detail: "" },
      { id: "port25", label: "Port 25", status: "fail", detail: "" },
      { id: "blacklist", label: "Blacklist", status: "fail", detail: "" },
    ];
    expect(sortByPriority(ind).map((i) => i.id)).toEqual(["port25", "blacklist", "queue", "tls"]);
  });
});
