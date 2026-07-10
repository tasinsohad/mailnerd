import { describe, it, expect } from "vitest";
import {
  classifyPort25,
  fcrdnsVerdict,
  dkimKeyMatch,
  parsePostfixQueue,
  queueVerdict,
  dominantDeferral,
  sortByPriority,
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
    expect(queueVerdict({ count: 0, oldestAgeMinutes: null, deferrals: { timeout: 0, rejected: 0, other: 0 } })).toBe("ok");
    expect(queueVerdict({ count: 60, oldestAgeMinutes: 10, deferrals: { timeout: 0, rejected: 0, other: 0 } })).toBe("warn");
    expect(queueVerdict({ count: 60, oldestAgeMinutes: 500, deferrals: { timeout: 0, rejected: 0, other: 0 } })).toBe("fail");
  });
  it("picks the dominant deferral reason", () => {
    expect(dominantDeferral({ count: 3, oldestAgeMinutes: 1, deferrals: { timeout: 2, rejected: 1, other: 0 } })).toBe("timeout");
    expect(dominantDeferral({ count: 0, oldestAgeMinutes: null, deferrals: { timeout: 0, rejected: 0, other: 0 } })).toBeNull();
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
