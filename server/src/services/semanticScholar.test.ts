import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "@paper-reader/shared";
import { createSemanticScholarProvider, SearchProviderError } from "./semanticScholar.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fixture = {
  total: 7,
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
    {
      paperId: "p5",
      title: "arXiv only",
      authors: [],
      openAccessPdf: null,
      externalIds: { ArXiv: "1706.03762", CorpusId: 13756489, DOI: "10.1/x" },
    },
    {
      paperId: "p6",
      title: "Open access wins over arXiv",
      authors: [],
      openAccessPdf: { url: "https://example.org/paper.pdf" },
      externalIds: { ArXiv: "1706.03762" },
    },
    { paperId: "p7", title: "No arXiv id", authors: [], externalIds: { CorpusId: 1 } },
  ],
};

type FetchArgs = Parameters<typeof fetch>;

/** A fetch that never answers and rejects with the signal's reason once it aborts. */
const hangUntilAborted = (_url: FetchArgs[0], init?: FetchArgs[1]) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

/** A 200 response whose body fails to read with the given error. */
const brokenBody = (error: unknown) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(error);
      },
    }),
    { status: 200 },
  );

const arxivUrl = (id: string) => `https://arxiv.org/pdf/${id}`;

describe("semantic scholar provider", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes results, dropping untitled papers and invalid URLs", async () => {
    const provider = createSemanticScholarProvider({ fetchFn: async () => json(fixture) });
    const expected: SearchResult[] = [
      {
        externalId: "p1",
        title: "Attention Is All You Need",
        authors: ["Ashish Vaswani"],
        year: 2017,
        abstract: "The dominant sequence transduction models...",
        url: "https://www.semanticscholar.org/paper/p1",
        pdfUrl: "https://arxiv.org/pdf/1706.03762",
      },
      { externalId: "p2", title: "No metadata", authors: [], year: null, abstract: null, url: null, pdfUrl: null },
      { externalId: "p4", title: "Bad links", authors: [], year: null, abstract: null, url: null, pdfUrl: null },
      {
        externalId: "p5",
        title: "arXiv only",
        authors: [],
        year: null,
        abstract: null,
        url: null,
        pdfUrl: "https://arxiv.org/pdf/1706.03762",
      },
      {
        externalId: "p6",
        title: "Open access wins over arXiv",
        authors: [],
        year: null,
        abstract: null,
        url: null,
        pdfUrl: "https://example.org/paper.pdf",
      },
      { externalId: "p7", title: "No arXiv id", authors: [], year: null, abstract: null, url: null, pdfUrl: null },
    ];
    expect(await provider.search("attention", 10)).toEqual(expected);
  });

  it.each<[string, Record<string, unknown>, SearchResult | null]>([
    [
      "trims the title",
      { paperId: "n1", title: "  Padded Title  " },
      { externalId: "n1", title: "Padded Title", authors: [], year: null, abstract: null, url: null, pdfUrl: null },
    ],
    ["drops a paper whose title is only whitespace", { paperId: "n2", title: "   " }, null],
    [
      "turns a blank abstract into null",
      { paperId: "n3", title: "T", abstract: "  \n " },
      { externalId: "n3", title: "T", authors: [], year: null, abstract: null, url: null, pdfUrl: null },
    ],
    [
      "trims an arXiv id with spaces",
      { paperId: "n4", title: "T", externalIds: { ArXiv: " 1706.03762 " } },
      { externalId: "n4", title: "T", authors: [], year: null, abstract: null, url: null, pdfUrl: arxivUrl("1706.03762") },
    ],
  ])("%s", async (_name, paper, expected) => {
    const provider = createSemanticScholarProvider({ fetchFn: async () => json({ data: [paper] }) });
    expect(await provider.search("x", 5)).toEqual(expected ? [expected] : []);
  });

  it("trims author names and drops blank ones", async () => {
    const authors = [{ name: "  Ada " }, { name: "   " }, { name: "" }, { name: "Bob" }];
    const provider = createSemanticScholarProvider({
      fetchFn: async () => json({ data: [{ paperId: "a1", title: "T", authors }] }),
    });
    const [result] = await provider.search("x", 5);
    expect(result?.authors).toEqual(["Ada", "Bob"]);
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

  it("sends no headers without an api key, encodes the query and asks for the fields it uses", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => json({ data: [] }));
    await createSemanticScholarProvider({ fetchFn }).search("a&b=c#", 5);
    const [url, init] = fetchFn.mock.calls[0]!;
    const requested = new URL(String(url));
    expect(requested.search).toContain("query=a%26b%3Dc%23");
    expect(requested.searchParams.get("query")).toBe("a&b=c#");
    expect(requested.searchParams.get("fields")).toBe("title,authors,year,abstract,url,openAccessPdf,externalIds");
    expect(init?.headers).toEqual({});
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

  it("waits the retry delay, then repeats the same request with a fresh signal", async () => {
    vi.useFakeTimers();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 429))
      .mockResolvedValueOnce(json({ data: [] }));
    const search = createSemanticScholarProvider({ apiKey: "secret", fetchFn, retryDelayMs: 1500 }).search("x", 5);

    await vi.advanceTimersByTimeAsync(1499);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await search).toEqual([]);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [first, second] = fetchFn.mock.calls;
    expect(second![0]).toBe(first![0]);
    expect(second![1]?.headers).toEqual({ "x-api-key": "secret" });
    expect(second![1]?.signal).toBeInstanceOf(AbortSignal);
    expect(second![1]?.signal).not.toBe(first![1]?.signal);
    expect(second![1]?.signal?.aborted).toBe(false);
  });

  it("reports a rate limit after the retry also fails", async () => {
    const provider = createSemanticScholarProvider({ fetchFn: async () => json({}, 429), retryDelayMs: 0 });
    await expect(provider.search("x", 5)).rejects.toMatchObject({
      status: 429,
      message: "Semantic Scholar rate limit reached, try again shortly",
    });
  });

  it.each([404, 500, 503])("reports status %i as a 502 without retrying", async (status) => {
    const fetchFn = vi.fn<typeof fetch>(async () => json({}, status));
    const search = createSemanticScholarProvider({ fetchFn, retryDelayMs: 0 }).search("x", 5);
    await expect(search).rejects.toBeInstanceOf(SearchProviderError);
    await expect(search).rejects.toMatchObject({ status: 502, message: `Semantic Scholar returned ${status}` });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each<[string, () => Promise<Response>, RegExp]>([
    ["a server error", async () => json({}, 500), /returned 500/],
    ["a network error", async () => Promise.reject(new Error("offline")), /Could not reach/],
  ])("reports %s after a 429 retry as a 502", async (_name, second, message) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(json({}, 429)).mockImplementationOnce(second);
    const search = createSemanticScholarProvider({ fetchFn, retryDelayMs: 0 }).search("x", 5);
    await expect(search).rejects.toMatchObject({ status: 502, message: expect.stringMatching(message) });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("gives up when the request does not finish within the timeout", async () => {
    const provider = createSemanticScholarProvider({ fetchFn: hangUntilAborted, timeoutMs: 20 });
    const search = provider.search("x", 5);
    await expect(search).rejects.toBeInstanceOf(SearchProviderError);
    await expect(search).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/Could not reach/) });
  });

  it.each<[string, () => Response]>([
    ["a malformed response", () => json({ data: "nope" })],
    ["a result without a paperId", () => json({ data: [{ title: "No id", authors: [] }] })],
  ])("reports %s as a 502", async (_name, respond) => {
    const search = createSemanticScholarProvider({ fetchFn: async () => respond() }).search("x", 5);
    await expect(search).rejects.toBeInstanceOf(SearchProviderError);
    await expect(search).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/Unexpected response/) });
  });

  it("reports a body that is not JSON as a 502", async () => {
    const search = createSemanticScholarProvider({ fetchFn: async () => new Response("<html>oops</html>") }).search("x", 5);
    await expect(search).rejects.toBeInstanceOf(SearchProviderError);
    await expect(search).rejects.toMatchObject({ status: 502, message: "Unexpected response from Semantic Scholar" });
  });

  it("fails the whole search when one result is malformed", async () => {
    const data = [{ paperId: "ok", title: "Fine", authors: [] }, { title: "No id", authors: [] }];
    const search = createSemanticScholarProvider({ fetchFn: async () => json({ data }) }).search("x", 5);
    await expect(search).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/Unexpected response/) });
  });

  it("reports a network error as a 502", async () => {
    const down = createSemanticScholarProvider({
      fetchFn: async () => {
        throw new Error("offline");
      },
    });
    await expect(down.search("x", 5)).rejects.toMatchObject({ status: 502 });
  });

  it.each<[string, () => Response]>([
    ["an HTML body", () => new Response("<html>Bad gateway</html>", { status: 200 })],
    ["an empty body", () => new Response(null, { status: 200 })],
    ["a body read that is aborted", () => brokenBody(new DOMException("The operation was aborted", "AbortError"))],
  ])("reports %s as a 502", async (_name, respond) => {
    const search = createSemanticScholarProvider({ fetchFn: async () => respond() }).search("x", 5);
    await expect(search).rejects.toBeInstanceOf(SearchProviderError);
    await expect(search).rejects.toMatchObject({ status: 502 });
  });
});
