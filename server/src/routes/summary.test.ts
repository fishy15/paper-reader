import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Paper } from "@paper-reader/shared";
import { papers } from "../db/schema.js";
import { LlmRateLimitError, type Llm } from "../services/llm.js";
import { fakeLlm, makePdf, makeTestApp } from "../test-utils.js";
import { MAX_PAPER_CHARS } from "../services/paperText.js";

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

async function errorOf(res: Response) {
  return z.object({ error: z.string() }).parse(await res.json()).error;
}

const summarize = (app: TestApp["app"], id: number) => app.request(`/api/papers/${id}/summarize`, { method: "POST" });

describe("POST /api/papers/:id/summarize", () => {
  it("summarizes the stored full text and caches the summary", async () => {
    const summarizeFn = vi.fn<Llm["summarize"]>(async () => "Problem: it works.");
    const { app, deps } = makeTestApp({ llm: fakeLlm({ summarize: summarizeFn }) });
    const { id } = insertPaper(deps);

    const res = await summarize(app, id);
    expect(res.status).toBe(200);
    expect(Paper.parse(await res.json()).summary).toBe("Problem: it works.");
    expect(summarizeFn).toHaveBeenCalledWith({ title: "A Paper", text: "The full text." });

    const saved = await (await app.request(`/api/papers/${id}`)).json();
    expect(saved).toMatchObject({ summary: "Problem: it works." });
  });

  it("regenerates and replaces an existing summary", async () => {
    const summarizeFn = vi.fn<Llm["summarize"]>().mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    const { app, deps } = makeTestApp({ llm: fakeLlm({ summarize: summarizeFn }) });
    const { id } = insertPaper(deps);

    await summarize(app, id);
    expect(Paper.parse(await (await summarize(app, id)).json()).summary).toBe("second");
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
    expect(summarizeFn.mock.calls[0]![0].text).toBe("Body of the paper");
    expect(deps.db.select().from(papers).where(eq(papers.id, id)).get()?.fullText).toBe("Body of the paper");

    await summarize(app, id);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("asks for an upload when a search paper has no text and no PDF link", async () => {
    const summarizeFn = vi.fn<Llm["summarize"]>(async () => "unused");
    const { app, deps } = makeTestApp({ llm: fakeLlm({ summarize: summarizeFn }) });
    const { id } = insertSearchPaper(deps);

    const res = await summarize(app, id);
    expect(res.status).toBe(422);
    expect((await errorOf(res))).toMatch(/Upload its PDF/);
    expect(summarizeFn).not.toHaveBeenCalled();
  });

  it.each<[string, () => Response, number, RegExp]>([
    ["the host returns an error status", () => new Response("forbidden", { status: 403 }), 502, /returned 403/],
    ["the link returns a web page", () => new Response("<html>landing page</html>"), 502, /did not return a PDF/],
    [
      "the PDF is corrupted",
      () => new Response(new TextEncoder().encode("%PDF-1.4 but not really")),
      422,
      /Could not read/,
    ],
    ["the PDF has no text", () => new Response(makePdf([""])), 422, /No text found/],
  ])("reports a failure when %s, without calling the LLM or storing text", async (_name, respond, status, message) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => respond());
    const summarizeFn = vi.fn<Llm["summarize"]>(async () => "unused");
    const { app, deps } = makeTestApp({ llm: fakeLlm({ summarize: summarizeFn }) });
    const { id } = insertSearchPaper(deps, { pdfUrl: "https://example.org/paper" });

    const res = await summarize(app, id);
    expect(res.status).toBe(status);
    expect((await errorOf(res))).toMatch(message);
    expect(summarizeFn).not.toHaveBeenCalled();
    expect(deps.db.select().from(papers).where(eq(papers.id, id)).get()?.fullText).toBeNull();
  });

  it("truncates very long text and marks the cut", async () => {
    const summarizeFn = vi.fn<Llm["summarize"]>(async () => "ok");
    const { app, deps } = makeTestApp({ llm: fakeLlm({ summarize: summarizeFn }) });
    const { id } = insertPaper(deps, { fullText: "x".repeat(MAX_PAPER_CHARS + 100) });

    await summarize(app, id);
    const text = summarizeFn.mock.calls[0]![0].text;
    expect(text).toHaveLength(MAX_PAPER_CHARS + "\n\n[Text truncated]".length);
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

  it("keeps the downloaded text when the LLM is rate limited, so a retry does not download again", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(makePdf(["Body of the paper"])));
    const summarizeFn = vi
      .fn<Llm["summarize"]>()
      .mockRejectedValueOnce(new LlmRateLimitError("Gemini rate limit reached"))
      .mockResolvedValueOnce("A summary");
    const { app, deps } = makeTestApp({ llm: fakeLlm({ summarize: summarizeFn }) });
    const { id } = insertSearchPaper(deps, { pdfUrl: "https://arxiv.org/pdf/1706.03762" });

    expect((await summarize(app, id)).status).toBe(429);
    expect(deps.db.select().from(papers).where(eq(papers.id, id)).get()?.fullText).toBe("Body of the paper");

    const retry = await summarize(app, id);
    expect(retry.status).toBe(200);
    expect(Paper.parse(await retry.json()).summary).toBe("A summary");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("leaves other papers' summaries alone", async () => {
    const { app, deps } = makeTestApp();
    const a = insertPaper(deps);
    const b = insertPaper(deps, { title: "Other" });

    await summarize(app, a.id);

    const rows = deps.db.select().from(papers).all();
    expect(rows.find((p) => p.id === a.id)?.summary).toBe("Fake summary.");
    expect(rows.find((p) => p.id === b.id)?.summary).toBeNull();
  });

  it.each([
    ["has no summary yet", null],
    ["has a summary", "old summary"],
  ])("returns a 500 and keeps the summary unchanged when the LLM fails unexpectedly and the paper %s", async (_name, summary) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, deps } = makeTestApp({
      llm: fakeLlm({
        summarize: async () => {
          throw new Error("boom");
        },
      }),
    });
    const { id } = insertPaper(deps, { summary });

    const res = await summarize(app, id);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom" });
    expect(deps.db.select().from(papers).where(eq(papers.id, id)).get()?.summary).toBe(summary);
  });

  it("returns a 500 and stores nothing when loading the paper text fails unexpectedly", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(makePdf(["Body"])));
    const summarizeFn = vi.fn<Llm["summarize"]>(async () => "unused");
    const { app, deps } = makeTestApp({ llm: fakeLlm({ summarize: summarizeFn }) });
    const { id } = insertSearchPaper(deps, { pdfUrl: "https://arxiv.org/pdf/1" });
    const update = vi.spyOn(deps.db, "update").mockImplementation(() => {
      throw new Error("disk full");
    });

    const res = await summarize(app, id);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "disk full" });
    expect(summarizeFn).not.toHaveBeenCalled();
    update.mockRestore();
    const saved = deps.db.select().from(papers).where(eq(papers.id, id)).get();
    expect(saved?.fullText).toBeNull();
    expect(saved?.summary).toBeNull();
  });

  it("returns 404 for a missing paper", async () => {
    const { app } = makeTestApp();
    const res = await summarize(app, 999);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Paper not found" });
  });

  it("returns 400 for a bad id", async () => {
    const { app } = makeTestApp();
    const res = await app.request("/api/papers/abc/summarize", { method: "POST" });
    expect(res.status).toBe(400);
    expect((await errorOf(res))).toMatch(/id/);
  });
});
