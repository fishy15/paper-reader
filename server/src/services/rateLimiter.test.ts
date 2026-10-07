import { describe, expect, it } from "vitest";
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
});
