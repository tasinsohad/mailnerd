import { describe, it, expect } from "vitest";
import { safeRedirectPath } from "../safe-redirect";

describe("safeRedirectPath", () => {
  it("keeps same-site paths, including the query string", () => {
    expect(safeRedirectPath("/domains/abc?tab=logs")).toBe("/domains/abc?tab=logs");
  });

  it("sends anything that could leave the site to the home page", () => {
    for (const target of ["https://evil.com", "//evil.com", "/\\evil.com", "/\t/evil.com", "evil.com", "", undefined, 42]) {
      expect(safeRedirectPath(target)).toBe("/");
    }
  });
});
