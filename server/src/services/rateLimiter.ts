/** Resolves when the caller may make its next request. */
export type Acquire = () => Promise<void>;

/**
 * Spaces requests at least 60s / `requestsPerMinute` apart. Slots are reserved synchronously,
 * so concurrent callers queue up in order instead of bursting.
 */
export function createRateLimiter(
  requestsPerMinute: number,
  clock: { now(): number; sleep(ms: number): Promise<void> } = {
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
): Acquire {
  const interval = 60_000 / requestsPerMinute;
  let nextSlot = 0;
  return async () => {
    const now = clock.now();
    const start = Math.max(now, nextSlot);
    nextSlot = start + interval;
    if (start > now) await clock.sleep(start - now);
  };
}
