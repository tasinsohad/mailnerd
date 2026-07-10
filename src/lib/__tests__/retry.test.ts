import { describe, it, expect } from "vitest";
import { retryDelayMs, retryTransient } from "../retry";

describe("retryDelayMs", () => {
  it("stays within [exp/2, exp) and never exceeds the cap", () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const d = retryDelayMs(attempt, 500, 8000);
      const exp = Math.min(8000, 500 * 2 ** attempt);
      expect(d).toBeGreaterThanOrEqual(Math.floor(exp / 2));
      expect(d).toBeLessThan(exp);
      expect(d).toBeLessThanOrEqual(8000);
    }
  });
});

describe("retryTransient", () => {
  it("retries a throwing call until it succeeds", async () => {
    let calls = 0;
    const res = await retryTransient(
      async () => {
        calls++;
        if (calls < 3) throw new Error("boom");
        return "ok";
      },
      () => false,
      { attempts: 4, base: 0 },
    );
    expect(res).toBe("ok");
    expect(calls).toBe(3);
  });

  it("retries while `retryable(result)` is true, then returns the good result", async () => {
    const statuses = [503, 429, 200];
    let i = 0;
    const res = await retryTransient(
      async () => ({ status: statuses[i++] }),
      (r) => r.status >= 500 || r.status === 429,
      { attempts: 4, base: 0 },
    );
    expect(res.status).toBe(200);
    expect(i).toBe(3);
  });

  it("returns the last (still-retryable) result after exhausting attempts", async () => {
    let calls = 0;
    const res = await retryTransient(
      async () => {
        calls++;
        return { status: 503 };
      },
      (r) => r.status >= 500,
      { attempts: 3, base: 0 },
    );
    expect(res.status).toBe(503);
    expect(calls).toBe(3);
  });

  it("throws the last error if every attempt throws", async () => {
    let calls = 0;
    await expect(
      retryTransient(
        async () => {
          calls++;
          throw new Error(`fail ${calls}`);
        },
        () => false,
        { attempts: 3, base: 0 },
      ),
    ).rejects.toThrow("fail 3");
    expect(calls).toBe(3);
  });

  it("does not retry a non-retryable result", async () => {
    let calls = 0;
    const res = await retryTransient(
      async () => {
        calls++;
        return { status: 400 };
      },
      (r) => r.status >= 500,
      { attempts: 4, base: 0 },
    );
    expect(res.status).toBe(400);
    expect(calls).toBe(1);
  });
});
