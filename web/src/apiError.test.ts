import { describe, expect, it } from "vitest";
import { ApiError, isAbort } from "./apiError.js";

describe("isAbort", () => {
  it("matches anything named AbortError, even if it isn't an Error", () => {
    expect(isAbort(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isAbort({ name: "AbortError" })).toBe(true);
  });

  it("rejects other errors", () => {
    expect(isAbort(new ApiError("nope"))).toBe(false);
    expect(isAbort(new TypeError("Failed to fetch"))).toBe(false);
    expect(isAbort({ name: 1 })).toBe(false);
  });

  it.each([null, undefined, "AbortError", 0])("returns false instead of throwing for %j", (value) => {
    expect(isAbort(value)).toBe(false);
  });
});
