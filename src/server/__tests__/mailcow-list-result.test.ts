import { describe, it, expect } from "vitest";
import { mailcowListResult } from "../mailcow-helpers";

// Mailcow serialises an EMPTY collection as the literal object `{}` with HTTP 200:
//   json_api.php -> if (!empty($domains)) { ... } else { echo '{}'; }
// That branch is only reachable AFTER the api-table key lookup AND the IP allow-list both pass, so
// `200 {}` means "the API works and there are no rows yet" — always true on a freshly provisioned
// server. Treating it as a failure deadlocked provisioning: no domains -> {} -> abort before
// add/domain -> still no domains, forever. These tests pin that distinction down.
describe("mailcowListResult", () => {
  it("returns the rows for a normal array response", () => {
    const rows = [{ domain_name: "a.com" }, { domain_name: "b.com" }];
    expect(mailcowListResult(200, rows)).toEqual(rows);
  });

  it("treats HTTP 200 {} as a VALID EMPTY list (the bug that blocked provisioning)", () => {
    expect(mailcowListResult(200, {})).toEqual([]);
  });

  it("accepts an empty array too", () => {
    expect(mailcowListResult(200, [])).toEqual([]);
  });

  it("rejects a Mailcow error body — it's a NON-empty object, not an empty list", () => {
    expect(mailcowListResult(200, { type: "error", msg: "authentication failed" })).toBeNull();
    expect(mailcowListResult(401, { type: "error", msg: "authentication failed" })).toBeNull();
  });

  it("rejects an empty object on a NON-200 status", () => {
    expect(mailcowListResult(500, {})).toBeNull();
    expect(mailcowListResult(403, {})).toBeNull();
  });

  it("rejects HTML / string bodies (nginx or an error page)", () => {
    expect(mailcowListResult(200, "<html>...</html>")).toBeNull();
  });

  it("rejects null / undefined bodies", () => {
    expect(mailcowListResult(200, null)).toBeNull();
    expect(mailcowListResult(200, undefined)).toBeNull();
  });
});
