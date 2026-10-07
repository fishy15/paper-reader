import { describe, expect, it, vi } from "vitest";
import { makeTestApp } from "./test-utils.js";

function makeApp(search: () => Promise<never[]> = async () => []) {
  return makeTestApp({ searchProvider: { search } }).app;
}

describe("error handling", () => {
  it("returns unexpected errors to the client as a 500 and logs them", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = makeApp(async () => {
      throw new Error("secret internal detail");
    });
    const res = await app.request("/api/search?query=x");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "secret internal detail" });
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});
