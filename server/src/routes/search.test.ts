import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "@paper-reader/shared";
import { SearchProviderError } from "../services/semanticScholar.js";
import { makeTestApp } from "../test-utils.js";

const result: SearchResult = {
  title: "A Paper",
  authors: ["Someone"],
  year: 2020,
  abstract: null,
  url: null,
  externalId: "s2-1",
  pdfUrl: null,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("search route", () => {
  it("returns the provider's results, defaulting the limit to 20", async () => {
    const search = vi.fn(async () => [result]);
    const { app } = makeTestApp({ searchProvider: { search } });
    const res = await app.request("/api/search?query=transformers");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([result]);
    expect(search).toHaveBeenCalledWith("transformers", 20);
  });

  it("trims the query and passes an explicit limit", async () => {
    const search = vi.fn(async () => []);
    const { app } = makeTestApp({ searchProvider: { search } });
    const res = await app.request("/api/search?query=%20%20bert%20&limit=5");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(search).toHaveBeenCalledWith("bert", 5);
  });

  it.each([
    ["no query at all", "", "query"],
    ["an empty query", "?query=", "query"],
    ["a blank query", "?query=%20", "query"],
    ["limit 0", "?query=a&limit=0", "limit"],
    ["limit 51", "?query=a&limit=51", "limit"],
    ["a fractional limit", "?query=a&limit=1.5", "limit"],
    ["a non-numeric limit", "?query=a&limit=x", "limit"],
  ])("rejects %s and names the field", async (_name, qs, field) => {
    const search = vi.fn(async () => []);
    const { app } = makeTestApp({ searchProvider: { search } });
    const res = await app.request(`/api/search${qs}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.stringMatching(new RegExp(`^Invalid request \\(.*${field}:`)) });
    expect(search).not.toHaveBeenCalled();
  });

  it.each([1, 50])("accepts the boundary limit %i", async (limit) => {
    const search = vi.fn(async () => []);
    const { app } = makeTestApp({ searchProvider: { search } });
    const res = await app.request(`/api/search?query=a&limit=${limit}`);
    expect(res.status).toBe(200);
    expect(search).toHaveBeenCalledWith("a", limit);
  });

  // Pins today's z.coerce.number() behavior (it uses Number()).
  it.each([
    ["an empty limit", "limit=", 400, undefined],
    ["a repeated limit", "limit=3&limit=4", 400, undefined],
    ["a leading space", "limit=%205", 200, 5],
    ["a trailing .0", "limit=5.0", 200, 5],
    ["exponent notation", "limit=1e1", 200, 10],
    ["hex notation", "limit=0x10", 200, 16],
  ])("handles limit format: %s", async (_name, qs, status, expectedLimit) => {
    const search = vi.fn(async () => []);
    const { app } = makeTestApp({ searchProvider: { search } });
    const res = await app.request(`/api/search?query=a&${qs}`);
    expect(res.status).toBe(status);
    if (expectedLimit === undefined) expect(search).not.toHaveBeenCalled();
    else expect(search).toHaveBeenCalledWith("a", expectedLimit);
  });

  it.each([
    ["an encoded ampersand and space", "a%26b%20c", "a&b c"],
    ["an encoded plus", "c%2B%2B", "c++"],
    ["inner spaces", "a%20%20b", "a  b"],
    ["unicode", encodeURIComponent("café 論文"), "café 論文"],
    // An unencoded + is a space, and the ends are trimmed, so clients must send %2B.
    ["a raw plus", "c++", "c"],
  ])("delivers the query decoded: %s", async (_name, raw, expected) => {
    const search = vi.fn(async () => []);
    const { app } = makeTestApp({ searchProvider: { search } });
    const res = await app.request(`/api/search?query=${raw}`);
    expect(res.status).toBe(200);
    expect(search).toHaveBeenCalledWith(expected, 20);
  });

  it.each([429, 502] as const)("maps a provider error to status %i", async (status) => {
    const { app } = makeTestApp({
      searchProvider: { search: async () => Promise.reject(new SearchProviderError("upstream", status)) },
    });
    const res = await app.request("/api/search?query=a");
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: "upstream" });
  });

  it("does not swallow unexpected errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("boom");
    const { app } = makeTestApp({ searchProvider: { search: async () => Promise.reject(boom) } });
    const res = await app.request("/api/search?query=a");
    expect(res.status).toBe(500);
    expect(log).toHaveBeenCalledWith(boom);
  });
});
