import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { QaMessage, QaStreamEvent } from "@paper-reader/shared";
import { papers, qaMessages } from "../db/schema.js";
import { LlmRateLimitError, type Llm } from "../services/llm.js";
import { MAX_PAPER_CHARS } from "../services/paperText.js";
import { fakeLlm, makePdf, makeTestApp } from "../test-utils.js";
import { HISTORY_MESSAGES } from "./qa.js";

type TestApp = ReturnType<typeof makeTestApp>;

function insertPaper(deps: TestApp["deps"], values: Partial<typeof papers.$inferInsert> = {}) {
  return deps.db
    .insert(papers)
    .values({ title: "A Paper", authors: [], source: "upload", fullText: "The full text.", ...values })
    .returning()
    .get();
}

const askRaw = (app: TestApp["app"], id: number | string, init: RequestInit = {}) =>
  app.request(`/api/papers/${id}/ask`, { method: "POST", ...init });

const ask = (app: TestApp["app"], id: number, body: unknown = { question: "Why?" }) =>
  app.request(`/api/papers/${id}/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function readEvents(res: Response): Promise<QaStreamEvent[]> {
  const lines = (await res.text()).split("\n").filter(Boolean);
  return lines.map((line) => QaStreamEvent.parse(JSON.parse(line)));
}

async function messages(app: TestApp["app"], id: number) {
  const res = await app.request(`/api/papers/${id}/messages`);
  return z.array(QaMessage).parse(await res.json());
}

async function errorOf(res: Response) {
  return z.object({ error: z.string() }).parse(await res.json()).error;
}

function answering(...chunks: string[]) {
  return vi.fn<Llm["answer"]>(async function* () {
    yield* chunks;
  });
}

describe("POST /api/papers/:id/ask", () => {
  it("streams the answer as events and saves the question and answer", async () => {
    const answer = answering("Because ", "of X.");
    const { app, deps } = makeTestApp({ llm: fakeLlm({ answer }) });
    const { id } = insertPaper(deps, { title: "Attention Is All You Need" });

    const res = await ask(app, id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(await readEvents(res)).toEqual([
      { type: "delta", text: "Because " },
      { type: "delta", text: "of X." },
      { type: "done" },
    ]);
    expect(answer).toHaveBeenCalledWith({
      title: "Attention Is All You Need",
      text: "The full text.",
      history: [],
      question: "Why?",
    });

    expect(await messages(app, id)).toMatchObject([
      { paperId: id, role: "user", content: "Why?" },
      { paperId: id, role: "assistant", content: "Because of X." },
    ]);
  });

  it("trims the question before sending it to the model and saving it", async () => {
    const answer = answering("ok");
    const { app, deps } = makeTestApp({ llm: fakeLlm({ answer }) });
    const { id } = insertPaper(deps);

    await readEvents(await ask(app, id, { question: "  Why?  " }));

    expect(answer).toHaveBeenCalledWith(expect.objectContaining({ question: "Why?" }));
    expect((await messages(app, id))[0]).toMatchObject({ role: "user", content: "Why?" });
  });

  it("returns a real status code when the LLM fails before answering, and saves nothing", async () => {
    const rateLimited = vi.fn<Llm["answer"]>(async function* () {
      throw new LlmRateLimitError("Gemini rate limit reached");
    });
    const { app, deps } = makeTestApp({ llm: fakeLlm({ answer: rateLimited }) });
    const { id } = insertPaper(deps);

    const res = await ask(app, id);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Gemini rate limit reached" });
    expect(await messages(app, id)).toEqual([]);
  });

  it("reports a failure partway through as an error event and saves nothing", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.fn<Llm["answer"]>(async function* () {
      yield "Partial";
      throw new Error("connection reset");
    });
    const { app, deps } = makeTestApp({ llm: fakeLlm({ answer: failing }) });
    const { id } = insertPaper(deps);

    const res = await ask(app, id);
    expect(res.status).toBe(200);
    expect(await readEvents(res)).toEqual([
      { type: "delta", text: "Partial" },
      { type: "error", message: "connection reset" },
    ]);
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: "connection reset" }));
    expect(await messages(app, id)).toEqual([]);
  });

  it("asks for an upload when the paper has no text and no PDF link", async () => {
    const answer = answering("unused");
    const { app, deps } = makeTestApp({ llm: fakeLlm({ answer }) });
    const { id } = insertPaper(deps, { source: "search", externalId: "s2-1", fullText: null });

    const res = await ask(app, id);
    expect(res.status).toBe(422);
    expect((await errorOf(res))).toMatch(/Upload its PDF/);
    expect(answer).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing paper", async () => {
    const { app } = makeTestApp();
    expect((await ask(app, 999)).status).toBe(404);
  });

  it.each([
    ["a bad id", "abc"],
    ["id 0", "0"],
    ["a negative id", "-1"],
    ["a fractional id", "1.5"],
  ])("rejects %s with a 400 naming the id", async (_name, id) => {
    const { app } = makeTestApp();
    const res = await askRaw(app, id, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Why?" }),
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res))).toMatch(/id/);
  });

  it.each<[string, unknown]>([
    ["a blank question", { question: "   " }],
    ["an over-long question", { question: "x".repeat(4001) }],
    ["a missing question", {}],
    ["a numeric question", { question: 42 }],
    ["a null question", { question: null }],
  ])("rejects %s with a 400 naming the question", async (_name, body) => {
    const { app, deps } = makeTestApp();
    const { id } = insertPaper(deps);
    const res = await ask(app, id, body);
    expect(res.status).toBe(400);
    expect((await errorOf(res))).toMatch(/question/);
  });

  it("accepts a question of exactly 4000 characters", async () => {
    const { app, deps } = makeTestApp();
    const { id } = insertPaper(deps);
    const res = await ask(app, id, { question: "x".repeat(4000) });
    expect(res.status).toBe(200);
    await readEvents(res);
  });

  it("rejects a body that is not valid JSON", async () => {
    const { app, deps } = makeTestApp();
    const { id } = insertPaper(deps);
    const res = await askRaw(app, id, { headers: { "content-type": "application/json" }, body: "{not json" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.stringMatching(/malformed/i) });
  });

  it("rejects a request without a content-type, naming the question", async () => {
    const { app, deps } = makeTestApp();
    const { id } = insertPaper(deps);
    const res = await askRaw(app, id, { body: JSON.stringify({ question: "Why?" }) });
    expect(res.status).toBe(400);
    expect((await errorOf(res))).toMatch(/question/);
  });

  it("saves an empty answer when the model returns nothing", async () => {
    const { app, deps } = makeTestApp({ llm: fakeLlm({ answer: answering() }) });
    const { id } = insertPaper(deps);

    const res = await ask(app, id);
    expect(res.status).toBe(200);
    expect(await readEvents(res)).toEqual([{ type: "done" }]);
    expect(await messages(app, id)).toMatchObject([
      { role: "user", content: "Why?" },
      { role: "assistant", content: "" },
    ]);
  });

  it("sends the model truncated text ending in the truncation marker", async () => {
    const answer = answering("ok");
    const { app, deps } = makeTestApp({ llm: fakeLlm({ answer }) });
    const { id } = insertPaper(deps, { fullText: "x".repeat(MAX_PAPER_CHARS + 100) });

    await readEvents(await ask(app, id));

    const text = answer.mock.calls[0]![0].text;
    expect(text).toHaveLength(MAX_PAPER_CHARS + "\n\n[Text truncated]".length);
    expect(text.endsWith("[Text truncated]")).toBe(true);
  });

  it("delivers a chunk containing a newline as one intact event", async () => {
    const { app, deps } = makeTestApp({ llm: fakeLlm({ answer: answering("line1\nline2") }) });
    const { id } = insertPaper(deps);

    expect(await readEvents(await ask(app, id))).toEqual([
      { type: "delta", text: "line1\nline2" },
      { type: "done" },
    ]);
    expect((await messages(app, id))[1]).toMatchObject({ content: "line1\nline2" });
  });

  it("sends only this paper's messages as history", async () => {
    const answer = answering("ok");
    const { app, deps } = makeTestApp({ llm: fakeLlm({ answer }) });
    const a = insertPaper(deps);
    const b = insertPaper(deps, { title: "Other" });
    deps.db
      .insert(qaMessages)
      .values([
        { paperId: a.id, role: "user", content: "question about A" },
        { paperId: b.id, role: "user", content: "question about B" },
        { paperId: a.id, role: "assistant", content: "answer about A" },
        { paperId: b.id, role: "assistant", content: "answer about B" },
      ])
      .run();

    await readEvents(await ask(app, a.id));

    expect(answer.mock.calls[0]![0].history).toEqual([
      { role: "user", content: "question about A" },
      { role: "assistant", content: "answer about A" },
    ]);
  });

  it.each([
    ["exactly the limit", HISTORY_MESSAGES, HISTORY_MESSAGES, 0],
    ["one over the limit", HISTORY_MESSAGES + 1, HISTORY_MESSAGES, 1],
    ["fewer than the limit", 3, 3, 0],
    ["four over the limit", HISTORY_MESSAGES + 4, HISTORY_MESSAGES, 4],
  ])("sends %s as history", async (_name, stored, expectedLength, firstKept) => {
    const answer = answering("ok");
    const { app, deps } = makeTestApp({ llm: fakeLlm({ answer }) });
    const { id } = insertPaper(deps);
    deps.db
      .insert(qaMessages)
      .values(
        Array.from({ length: stored }, (_, i) => ({
          paperId: id,
          role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
          content: `message ${i}`,
        })),
      )
      .run();

    await readEvents(await ask(app, id));

    const { history } = answer.mock.calls[0]![0];
    expect(history).toHaveLength(expectedLength);
    expect(history[0]).toEqual({ role: firstKept % 2 === 0 ? "user" : "assistant", content: `message ${firstKept}` });
    expect(history.at(-1)).toEqual({ role: (stored - 1) % 2 === 0 ? "user" : "assistant", content: `message ${stored - 1}` });
  });

  it("returns a 500 error, opens no stream and saves nothing when the LLM fails before answering", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.fn<Llm["answer"]>(async function* () {
      throw new Error("boom");
    });
    const { app, deps } = makeTestApp({ llm: fakeLlm({ answer: failing }) });
    const { id } = insertPaper(deps);

    const res = await ask(app, id);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).not.toContain("application/x-ndjson");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "boom" });
    expect(logged).toHaveBeenCalled();
    expect(await messages(app, id)).toEqual([]);
  });

  it("returns a 500 when loading the paper text fails unexpectedly", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const answer = answering("unused");
    const { app, deps } = makeTestApp({ llm: fakeLlm({ answer }) });
    const { id } = insertPaper(deps, { source: "search", externalId: "s2-1", fullText: null, pdfUrl: "https://arxiv.org/pdf/1" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(makePdf(["Body"])));
    vi.spyOn(deps.db, "update").mockImplementation(() => {
      throw new Error("disk full");
    });

    const res = await ask(app, id);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "disk full" });
    expect(answer).not.toHaveBeenCalled();
    expect(await messages(app, id)).toEqual([]);
  });

  it("stops pulling from the model and saves nothing when the client disconnects mid-stream", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let finished!: () => void;
    const closed = new Promise<void>((resolve) => (finished = resolve));
    let reachedLast = false;
    const slow = vi.fn<Llm["answer"]>(async function* () {
      try {
        yield "first";
        await gate;
        yield "second";
        reachedLast = true;
        yield "third";
      } finally {
        finished();
      }
    });
    const { app, deps } = makeTestApp({ llm: fakeLlm({ answer: slow }) });
    const { id } = insertPaper(deps);

    const res = await ask(app, id);
    const reader = res.body!.getReader();
    await reader.read(); // the first delta arrives
    await reader.cancel(); // the client goes away
    release();
    await closed; // the generator was closed by answer.return()

    expect(reachedLast).toBe(false);
    expect(await messages(app, id)).toEqual([]);
  });

  describe("for a search paper without saved text", () => {
    const pdfUrl = "https://example.org/paper";

    it.each([
      ["the download fails", () => new Response("forbidden", { status: 403 }), 502, /returned 403/],
      [
        "the PDF is corrupted",
        () => new Response(new TextEncoder().encode("%PDF-1.4 but not really")),
        422,
        /Could not read/,
      ],
    ])("maps a failure when %s to a status and saves nothing", async (_name, respond, status, message) => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => respond());
      const answer = answering("unused");
      const { app, deps } = makeTestApp({ llm: fakeLlm({ answer }) });
      const { id } = insertPaper(deps, { source: "search", externalId: "s2-1", fullText: null, pdfUrl });

      const res = await ask(app, id);
      expect(res.status).toBe(status);
      expect((await errorOf(res))).toMatch(message);
      expect(answer).not.toHaveBeenCalled();
      expect(await messages(app, id)).toEqual([]);
    });

    it("downloads once and reuses the stored text on the next question", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => new Response(makePdf(["Body of the paper"])));
      const answer = answering("ok");
      const { app, deps } = makeTestApp({ llm: fakeLlm({ answer }) });
      const { id } = insertPaper(deps, { source: "search", externalId: "s2-1", fullText: null, pdfUrl });

      await readEvents(await ask(app, id));
      await readEvents(await ask(app, id, { question: "Again?" }));

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(answer.mock.calls[0]![0].text).toBe("Body of the paper");
      expect(answer.mock.calls[1]![0].text).toBe("Body of the paper");
    });
  });
});

describe("GET /api/papers/:id/messages", () => {
  it("returns the conversation oldest first, per paper", async () => {
    const { app, deps } = makeTestApp();
    const a = insertPaper(deps);
    const b = insertPaper(deps, { title: "Other" });
    await readEvents(await ask(app, a.id, { question: "first" }));
    await readEvents(await ask(app, b.id, { question: "elsewhere" }));
    await readEvents(await ask(app, a.id, { question: "second" }));

    expect((await messages(app, a.id)).map((m) => m.content)).toEqual([
      "first",
      "Fake answer.",
      "second",
      "Fake answer.",
    ]);
    expect(await messages(app, b.id)).toHaveLength(2);
  });

  it("404s for a missing paper", async () => {
    const { app } = makeTestApp();
    expect((await app.request("/api/papers/999/messages")).status).toBe(404);
  });

  it("400s for a bad id", async () => {
    const { app } = makeTestApp();
    const res = await app.request("/api/papers/abc/messages");
    expect(res.status).toBe(400);
    expect((await errorOf(res))).toMatch(/id/);
  });

  it("returns messages with an id, the paper id, a role and an ISO timestamp", async () => {
    const { app, deps } = makeTestApp();
    const { id } = insertPaper(deps);
    await readEvents(await ask(app, id));

    const res = await app.request(`/api/papers/${id}/messages`);
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(2);
    for (const raw of body) {
      const message = QaMessage.parse(raw);
      expect(message.paperId).toBe(id);
      expect(message.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    }
  });
});

describe("deleting a paper", () => {
  it("deletes its messages too", async () => {
    const { app, deps } = makeTestApp();
    const { id } = insertPaper(deps);
    await readEvents(await ask(app, id));
    expect(await messages(app, id)).toHaveLength(2);

    await app.request(`/api/papers/${id}`, { method: "DELETE" });
    expect(deps.db.select().from(qaMessages).where(eq(qaMessages.paperId, id)).all()).toEqual([]);
  });
});
