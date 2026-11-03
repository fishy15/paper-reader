import { describe, expect, it, vi } from "vitest";
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
    await app.request("/api/search?query=%20%20bert%20&limit=5");
    expect(search).toHaveBeenCalledWith("bert", 5);
  });

  it("rejects a missing or blank query and out-of-range limits", async () => {
    const search = vi.fn(async () => []);
    const { app } = makeTestApp({ searchProvider: { search } });
    for (const qs of ["", "?query=", "?query=%20", "?query=a&limit=0", "?query=a&limit=51", "?query=a&limit=1.5", "?query=a&limit=x"]) {
      const res = await app.request(`/api/search${qs}`);
      expect(res.status, qs).toBe(400);
      expect(await res.json()).toEqual({ error: expect.stringContaining("Invalid request") });
    }
    expect(search).not.toHaveBeenCalled();
  });

  it("maps provider errors to their status", async () => {
    for (const status of [429, 502] as const) {
      const { app } = makeTestApp({
        searchProvider: { search: async () => Promise.reject(new SearchProviderError("upstream", status)) },
      });
      const res = await app.request("/api/search?query=a");
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: "upstream" });
    }
  });

  it("does not swallow unexpected errors", async () => {
    const { app } = makeTestApp({ searchProvider: { search: async () => Promise.reject(new Error("boom")) } });
    const res = await app.request("/api/search?query=a");
    expect(res.status).toBe(500);
  });
});
