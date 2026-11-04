import { afterEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "./rateLimiter.js";

function fakeClock() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    advance: (ms: number) => (now += ms),
    clock: {
      now: () => now,
      // Time only passes once the sleeper resumes, as with a real timer.
      sleep: async (ms: number) => {
        sleeps.push(ms);
        await Promise.resolve();
        now += ms;
      },
    },
  };
}

describe("rate limiter", () => {
  it("lets the first request through and spaces later ones by 60s / rpm", async () => {
    const { clock, sleeps } = fakeClock();
    const acquire = createRateLimiter(5, clock); // one request every 12s
    await acquire();
    await acquire();
    await acquire();
    expect(sleeps).toEqual([12_000, 12_000]);
  });

  it("does not wait when enough time has passed", async () => {
    const { clock, sleeps, advance } = fakeClock();
    const acquire = createRateLimiter(10, clock);
    await acquire();
    advance(30_000);
    await acquire();
    expect(sleeps).toEqual([]);
  });

  it("queues concurrent callers instead of letting them burst", async () => {
    const { clock, sleeps } = fakeClock();
    const acquire = createRateLimiter(6, clock); // every 10s
    await Promise.all([acquire(), acquire(), acquire()]);
    expect(sleeps).toEqual([10_000, 20_000]);
  });

  it("sleeps only the remainder of the interval", async () => {
    const { clock, sleeps, advance } = fakeClock();
    const acquire = createRateLimiter(5, clock); // every 12s
    await acquire();
    advance(5_000);
    await acquire();
    expect(sleeps).toEqual([7_000]);
  });

  it("keeps spacing requests after an idle gap", async () => {
    const { clock, sleeps, advance } = fakeClock();
    const acquire = createRateLimiter(5, clock); // every 12s
    await acquire();
    advance(60_000);
    await acquire();
    await acquire();
    await acquire();
    expect(sleeps).toEqual([12_000, 12_000]);
  });

  it("does not let one limiter delay another", async () => {
    const { clock, sleeps } = fakeClock();
    const first = createRateLimiter(5, clock);
    const second = createRateLimiter(5, clock);
    await first();
    await second();
    expect(sleeps).toEqual([]);
  });

  describe("with the default clock", () => {
    afterEach(() => vi.useRealTimers());

    it("resumes callers in order, one interval apart", async () => {
      vi.useFakeTimers();
      const start = Date.now();
      const acquire = createRateLimiter(60); // every 1s
      const resumed: { label: string; at: number }[] = [];
      const run = (label: string) => acquire().then(() => resumed.push({ label, at: Date.now() - start }));
      const all = Promise.all([run("a"), run("b"), run("c")]);
      await vi.advanceTimersByTimeAsync(2_000);
      await all;
      expect(resumed).toEqual([
        { label: "a", at: 0 },
        { label: "b", at: 1_000 },
        { label: "c", at: 2_000 },
      ]);
    });
  });

  // Planned change (see "Rate limiter" in ISSUES.md): the invalid rows fail until the input is checked.
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s requests per minute", (rpm) => {
    expect(() => createRateLimiter(rpm, fakeClock().clock)).toThrow(new RangeError(`requestsPerMinute must be a finite number greater than 0, got ${rpm}`));
  });

  it("accepts fewer than one request per minute", async () => {
    const { clock, sleeps } = fakeClock();
    const acquire = createRateLimiter(0.5, clock); // every 2 minutes
    await acquire();
    await acquire();
    expect(sleeps).toEqual([120_000]);
  });
});
