import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { createDb, IN_MEMORY_DB } from "../db/client.js";
import { createSemanticScholarProvider, SearchProviderError } from "./semanticScholar.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fixture = {
  total: 4,
  data: [
    {
      paperId: "p1",
      title: "Attention Is All You Need",
      abstract: "The dominant sequence transduction models...",
      year: 2017,
      url: "https://www.semanticscholar.org/paper/p1",
      authors: [{ authorId: "1", name: "Ashish Vaswani" }, { authorId: "2", name: null }],
      openAccessPdf: { url: "https://arxiv.org/pdf/1706.03762", status: "GREEN" },
    },
    { paperId: "p2", title: "No metadata", abstract: null, year: null, url: null, authors: [], openAccessPdf: null },
    { paperId: "p3", title: null, authors: [] },
    { paperId: "p4", title: "Bad links", url: "not a url", authors: [], openAccessPdf: { url: "" } },
  ],
};

describe("semantic scholar provider", () => {
  it("normalizes results, dropping untitled papers and invalid URLs", async () => {
    const fetchFn = vi.fn(async () => json(fixture));
    const provider = createSemanticScholarProvider({ fetchFn });
    const results = await provider.search("attention", 10);

    expect(results.map((r) => r.externalId)).toEqual(["p1", "p2", "p4"]);
    expect(results[0]).toEqual({
      externalId: "p1",
      title: "Attention Is All You Need",
      authors: ["Ashish Vaswani"],
      year: 2017,
      abstract: "The dominant sequence transduction models...",
      url: "https://www.semanticscholar.org/paper/p1",
      pdfUrl: "https://arxiv.org/pdf/1706.03762",
    });
    expect(results[1]).toMatchObject({ year: null, abstract: null, url: null, pdfUrl: null });
    expect(results[2]).toMatchObject({ url: null, pdfUrl: null });
  });

  it("handles a response with no data field", async () => {
    const provider = createSemanticScholarProvider({ fetchFn: async () => json({ total: 0, offset: 0 }) });
    expect(await provider.search("zzzz", 5)).toEqual([]);
  });

  it("sends the api key and query parameters", async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({ data: [] }));
    await createSemanticScholarProvider({ apiKey: "secret", fetchFn }).search("a b", 7);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toContain("query=a+b");
    expect(String(url)).toContain("limit=7");
    expect(init?.headers).toEqual({ "x-api-key": "secret" });
  });

  it("retries once on 429 then succeeds", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 429))
      .mockResolvedValueOnce(json({ data: [] }));
    const provider = createSemanticScholarProvider({ fetchFn, retryDelayMs: 0 });
    expect(await provider.search("x", 5)).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("reports a rate limit after the retry also fails", async () => {
    const provider = createSemanticScholarProvider({ fetchFn: async () => json({}, 429), retryDelayMs: 0 });
    await expect(provider.search("x", 5)).rejects.toMatchObject({ status: 429 });
  });

  it("reports malformed responses and network errors as 502", async () => {
    const malformed = createSemanticScholarProvider({ fetchFn: async () => json({ data: "nope" }) });
    await expect(malformed.search("x", 5)).rejects.toBeInstanceOf(SearchProviderError);
    const down = createSemanticScholarProvider({
      fetchFn: async () => {
        throw new Error("offline");
      },
    });
    await expect(down.search("x", 5)).rejects.toMatchObject({ status: 502 });
  });
});

describe("search route", () => {
  const makeApp = (search: (query: string, limit: number) => Promise<never[]>) =>
    createApp({ db: createDb(IN_MEMORY_DB), searchProvider: { search } });

  it("passes the query to the provider and validates input", async () => {
    const search = vi.fn(async () => []);
    const app = makeApp(search);
    expect((await app.request("/api/search?query=attention")).status).toBe(200);
    expect(search).toHaveBeenCalledWith("attention", 20);
    expect((await app.request("/api/search?query=")).status).toBe(400);
    expect((await app.request("/api/search")).status).toBe(400);
    expect((await app.request("/api/search?query=a&limit=500")).status).toBe(400);
  });

  it("maps provider errors to their status", async () => {
    const app = makeApp(async () => {
      throw new SearchProviderError("slow down", 429);
    });
    const res = await app.request("/api/search?query=x");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "slow down" });
  });
});
