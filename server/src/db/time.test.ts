import { describe, expect, it } from "vitest";
import { toIsoUtc } from "./time.js";

describe("toIsoUtc", () => {
  it("converts a SQLite timestamp to ISO 8601 UTC", () => {
    expect(toIsoUtc("2026-10-08 12:00:00")).toBe("2026-10-08T12:00:00Z");
  });

  it("produces something Date parses as that UTC instant", () => {
    expect(new Date(toIsoUtc("2026-10-08 12:00:00")).toISOString()).toBe("2026-10-08T12:00:00.000Z");
  });
});
