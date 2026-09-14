// Caps how many server setups run at once inside the app process. The BullMQ worker already enforces
// PROVISION_CONCURRENCY when Redis is up; the in-process fallback had no cap, so "Provision servers"
// across a job would start every domain's 20–40 min SSH deploy simultaneously.
//
// Leaf module (no imports) so a unit test can load it without the SSH/DB stack behind queue.ts.

export function createSlotLimiter(limit: number) {
  // NaN or <1 (a typo'd PROVISION_CONCURRENCY) must still mean a cap, not "unlimited".
  const max = Math.max(1, Math.floor(limit) || 1);
  let active = 0;
  const waiting: Array<() => void> = [];

  return {
    isFull: () => active >= max,

    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active < max) {
        active++;
      } else {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      try {
        return await task();
      } finally {
        // Hand the slot straight to the next waiter rather than releasing it, so a caller arriving
        // in between can't also claim it and push the count past the cap.
        const next = waiting.shift();
        if (next) next();
        else active--;
      }
    },
  };
}
