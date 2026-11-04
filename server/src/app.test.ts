import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestApp } from "./test-utils.js";

function makeApp(search: () => Promise<never[]> = async () => []) {
  return makeTestApp({ searchProvider: { search } }).app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("error handling", () => {
  it("returns unexpected errors to the client as a 500 and logs them", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = makeApp(async () => {
      throw new Error("secret internal detail");
    });
    const res = await app.request("/api/search?query=x");
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "secret internal detail" });
    expect(log).toHaveBeenCalledOnce();
  });

  it("returns a malformed JSON body as a 400 without logging it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await makeApp().request("/api/papers/from-search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(log).not.toHaveBeenCalled();
  });

  it("does not route a thrown non-Error value through the error handler", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    // makeApp types `search` as returning never[], so the throw needs a cast.
    const app = makeApp((async () => {
      throw "boom";
    }) as () => Promise<never[]>);
    // Hono only calls onError for Error instances, so the raw value escapes app.request.
    await expect(app.request("/api/search?query=x")).rejects.toBe("boom");
    expect(log).not.toHaveBeenCalled();
  });
});

describe("not found", () => {
  it.each([
    ["an unknown path", "GET", "/api/nope"],
    ["a wrong method on a known route", "DELETE", "/api/search"],
    ["a path without the /api prefix", "GET", "/papers"],
  ])("returns a JSON 404 for %s", async (_name, method, path) => {
    const res = await makeApp().request(path, { method });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});
