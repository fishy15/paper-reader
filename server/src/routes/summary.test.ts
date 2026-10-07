import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Paper } from "@paper-reader/shared";
import { papers } from "../db/schema.js";
import { LlmRateLimitError, type Llm } from "../services/llm.js";
import { fakeLlm, makePdf, makeTestApp } from "../test-utils.js";
import { MAX_SUMMARY_CHARS } from "./summary.js";

type TestApp = ReturnType<typeof makeTestApp>;

function insertPaper(deps: TestApp["deps"], values: Partial<typeof papers.$inferInsert> = {}) {
  return deps.db
    .insert(papers)
    .values({ title: "A Paper", authors: [], source: "upload", fullText: "The full text.", ...values })
    .returning()
    .get();
}

function insertSearchPaper(deps: TestApp["deps"], values: Partial<typeof papers.$inferInsert> = {}) {
  return insertPaper(deps, { source: "search", externalId: "s2-1", fullText: null, ...values });
}

const summarize = (app: TestApp["app"], id: number) => app.request(`/api/papers/${id}/summarize`, { method: "POST" });

afterEach(() => vi.restoreAllMocks());

describe("POST /api/papers/:id/summarize", () => {
  it("summarizes the stored full text and caches the summary", async () => {
    const summarizeFn = vi.fn<Llm["summarize"]>(async () => "Problem: it works.");
    const { app, deps } = makeTestApp({ llm: fakeLlm({ summarize: summarizeFn }) });
    const { id } = insertPaper(deps);

    const res = await summarize(app, id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Paper).summary).toBe("Problem: it works.");
    expect(summarizeFn).toHaveBeenCalledWith({ title: "A Paper", text: "The full text." });

    const saved = await (await app.request(`/api/papers/${id}`)).json();
    expect(saved).toMatchObject({ summary: "Problem: it works." });
  });

  it("regenerates and replaces an existing summary", async () => {
    const summarizeFn = vi.fn<Llm["summarize"]>().mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    const { app, deps } = makeTestApp({ llm: fakeLlm({ summarize: summarizeFn }) });
    const { id } = insertPaper(deps);

    await summarize(app, id);
    expect(((await (await summarize(app, id)).json()) as Paper).summary).toBe("second");
    expect(summarizeFn).toHaveBeenCalledTimes(2);
  });

  it("downloads the PDF for a search paper once, stores its text and summarizes it", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(makePdf(["Body of the paper"])));
    const summarizeFn = vi.fn<Llm["summarize"]>(async () => "A summary");
    const { app, deps } = makeTestApp({ llm: fakeLlm({ summarize: summarizeFn }) });
    const { id } = insertSearchPaper(deps, { pdfUrl: "https://arxiv.org/pdf/1706.03762" });

    expect((await summarize(app, id)).status).toBe(200);
    expect(summarizeFn.mock.calls[0]![0].text).toContain("Body of the paper");
    expect(deps.db.select().from(papers).where(eq(papers.id, id)).get()?.fullText).toContain("Body of the paper");

    await summarize(app, id);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("asks for an upload when a search paper has no text and no PDF link", async () => {
    const summarizeFn = vi.fn<Llm["summarize"]>(async () => "unused");
    const { app, deps } = makeTestApp({ llm: fakeLlm({ summarize: summarizeFn }) });
    const { id } = insertSearchPaper(deps);

    const res = await summarize(app, id);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/Upload its PDF/);
    expect(summarizeFn).not.toHaveBeenCalled();
  });

  it("reports download failures and unreadable PDFs without calling the LLM or storing text", async () => {
    const summarizeFn = vi.fn<Llm["summarize"]>(async () => "unused");
    const { app, deps } = makeTestApp({ llm: fakeLlm({ summarize: summarizeFn }) });
    const { id } = insertSearchPaper(deps, { pdfUrl: "https://example.org/paper" });

    const cases: [() => Response, number, RegExp][] = [
      [() => new Response("forbidden", { status: 403 }), 502, /returned 403/],
      [() => new Response("<html>landing page</html>"), 502, /did not return a PDF/],
      [() => new Response(new TextEncoder().encode("%PDF-1.4 but not really")), 422, /Could not read/],
      [() => new Response(makePdf([""])), 422, /No text found/],
    ];
    for (const [respond, status, message] of cases) {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => respond());
      const res = await summarize(app, id);
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toMatch(message);
    }
    expect(summarizeFn).not.toHaveBeenCalled();
    expect(deps.db.select().from(papers).where(eq(papers.id, id)).get()?.fullText).toBeNull();
  });

  it("truncates very long text and marks the cut", async () => {
    const summarizeFn = vi.fn<Llm["summarize"]>(async () => "ok");
    const { app, deps } = makeTestApp({ llm: fakeLlm({ summarize: summarizeFn }) });
    const { id } = insertPaper(deps, { fullText: "x".repeat(MAX_SUMMARY_CHARS + 100) });

    await summarize(app, id);
    const text = summarizeFn.mock.calls[0]![0].text;
    expect(text).toHaveLength(MAX_SUMMARY_CHARS + "\n\n[Text truncated]".length);
    expect(text.endsWith("[Text truncated]")).toBe(true);
  });

  it("maps a Gemini rate limit to 429 and keeps the old summary", async () => {
    const { app, deps } = makeTestApp({
      llm: fakeLlm({
        summarize: async () => {
          throw new LlmRateLimitError("Gemini rate limit reached");
        },
      }),
    });
    const { id } = insertPaper(deps, { summary: "old summary" });

    const res = await summarize(app, id);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Gemini rate limit reached" });
    expect(deps.db.select().from(papers).where(eq(papers.id, id)).get()?.summary).toBe("old summary");
  });

  it("returns 404 for a missing paper and 400 for a bad id", async () => {
    const { app } = makeTestApp();
    expect((await summarize(app, 999)).status).toBe(404);
    expect((await app.request("/api/papers/abc/summarize", { method: "POST" })).status).toBe(400);
  });
});
