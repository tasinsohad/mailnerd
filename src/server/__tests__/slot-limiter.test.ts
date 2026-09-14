import { describe, it, expect } from "vitest";
import { createSlotLimiter } from "../slot-limiter";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createSlotLimiter", () => {
  it("never runs more than `limit` tasks at once, and runs them all", async () => {
    const limiter = createSlotLimiter(3);
    let active = 0;
    let peak = 0;

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        limiter.run(async () => {
          active++;
          peak = Math.max(peak, active);
          for (let t = 0; t < (i % 4) + 1; t++) await tick();
          active--;
          return i;
        }),
      ),
    );

    expect(peak).toBe(3);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("reports full only while every slot is taken", async () => {
    const limiter = createSlotLimiter(1);
    expect(limiter.isFull()).toBe(false);

    let release!: () => void;
    const running = limiter.run(() => new Promise<void>((r) => (release = r)));
    expect(limiter.isFull()).toBe(true);

    release();
    await running;
    expect(limiter.isFull()).toBe(false);
  });

  it("frees the slot when a task throws, so the next one still starts", async () => {
    const limiter = createSlotLimiter(1);
    const failed = limiter.run(async () => {
      throw new Error("ssh refused");
    });
    const next = limiter.run(async () => "ran");

    await expect(failed).rejects.toThrow("ssh refused");
    await expect(next).resolves.toBe("ran");
  });

  it("treats a nonsense limit as 1 rather than unlimited", () => {
    const limiter = createSlotLimiter(Number("abc"));
    void limiter.run(() => new Promise(() => {}));
    expect(limiter.isFull()).toBe(true);
  });
});
