import { describe, it, expect } from "vitest";
import { wipeOncePerServer } from "../wipe-plan";

// "Wipe & re-provision" across several domains wipes a shared server once: the first domain on it
// reinstalls, the others join the fresh Mailcow.

describe("wipeOncePerServer", () => {
  it("reinstalls the first domain per server and reuses for the others, reinstalls first", () => {
    expect(
      wipeOncePerServer([
        { id: "a", ipAddress: "1.2.3.4" },
        { id: "b", ipAddress: "5.6.7.8" },
        { id: "c", ipAddress: "1.2.3.4" },
        { id: "d", ipAddress: "5.6.7.8" },
      ]),
    ).toEqual([
      { id: "a", serverChoice: "reinstall" },
      { id: "b", serverChoice: "reinstall" },
      { id: "c", serverChoice: "reuse" },
      { id: "d", serverChoice: "reuse" },
    ]);
  });

  it("compares IPs trimmed and lowercased, like the server lock", () => {
    expect(
      wipeOncePerServer([
        { id: "a", ipAddress: " Mail.Example.com " },
        { id: "b", ipAddress: "mail.example.com" },
      ]),
    ).toEqual([
      { id: "a", serverChoice: "reinstall" },
      { id: "b", serverChoice: "reuse" },
    ]);
  });

  it("treats each domain without an IP as its own server", () => {
    expect(
      wipeOncePerServer([
        { id: "a", ipAddress: null },
        { id: "b" },
        { id: "c", ipAddress: "  " },
      ]).map((t) => t.serverChoice),
    ).toEqual(["reinstall", "reinstall", "reinstall"]);
  });
});
