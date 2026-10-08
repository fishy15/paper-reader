import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { QaStreamEvent, type QaMessage } from "@paper-reader/shared";
import { papers, qaMessages } from "../db/schema.js";
import { LlmRateLimitError, type Llm } from "../services/llm.js";
import { fakeLlm, makeTestApp } from "../test-utils.js";
import { HISTORY_MESSAGES } from "./qa.js";

type TestApp = ReturnType<typeof makeTestApp>;

function insertPaper(deps: TestApp["deps"], values: Partial<typeof papers.$inferInsert> = {}) {
  return deps.db
    .insert(papers)
    .values({ title: "A Paper", authors: [], source: "upload", fullText: "The full text.", ...values })
    .returning()
    .get();
}

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
  return (await res.json()) as QaMessage[];
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
    const { id } = insertPaper(deps);

    const res = await ask(app, id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(await readEvents(res)).toEqual([
      { type: "delta", text: "Because " },
      { type: "delta", text: "of X." },
      { type: "done" },
    ]);
    expect(answer).toHaveBeenCalledWith({ title: "A Paper", text: "The full text.", history: [], question: "Why?" });

    expect(await messages(app, id)).toMatchObject([
      { paperId: id, role: "user", content: "Why?" },
      { paperId: id, role: "assistant", content: "Because of X." },
    ]);
  });

  it("sends earlier messages as history, at most the most recent ones", async () => {
    const answer = answering("ok");
    const { app, deps } = makeTestApp({ llm: fakeLlm({ answer }) });
    const { id } = insertPaper(deps);
    const earlier = Array.from({ length: HISTORY_MESSAGES + 4 }, (_, i) => ({
      paperId: id,
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `message ${i}`,
    }));
    deps.db.insert(qaMessages).values(earlier).run();

    await readEvents(await ask(app, id, { question: "  And now?  " }));

    const input = answer.mock.calls[0]![0];
    expect(input.question).toBe("And now?");
    expect(input.history).toHaveLength(HISTORY_MESSAGES);
    expect(input.history[0]).toEqual({ role: "user", content: "message 4" });
    expect(input.history.at(-1)).toEqual({ role: "assistant", content: `message ${HISTORY_MESSAGES + 3}` });
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
    vi.spyOn(console, "error").mockImplementation(() => {});
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
    expect(await messages(app, id)).toEqual([]);
  });

  it("asks for an upload when the paper has no text and no PDF link", async () => {
    const answer = answering("unused");
    const { app, deps } = makeTestApp({ llm: fakeLlm({ answer }) });
    const { id } = insertPaper(deps, { source: "search", externalId: "s2-1", fullText: null });

    const res = await ask(app, id);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/Upload its PDF/);
    expect(answer).not.toHaveBeenCalled();
  });

  it("validates the id and question, and 404s for a missing paper", async () => {
    const { app, deps } = makeTestApp();
    const { id } = insertPaper(deps);
    expect((await ask(app, 999)).status).toBe(404);
    expect((await ask(app, id, { question: "   " })).status).toBe(400);
    expect((await ask(app, id, { question: "x".repeat(4001) })).status).toBe(400);
    expect((await ask(app, id, {})).status).toBe(400);
    expect((await app.request("/api/papers/abc/ask", { method: "POST" })).status).toBe(400);
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

  it("404s for a missing paper, and the messages are deleted with their paper", async () => {
    const { app, deps } = makeTestApp();
    expect((await app.request("/api/papers/999/messages")).status).toBe(404);

    const { id } = insertPaper(deps);
    await readEvents(await ask(app, id));
    await app.request(`/api/papers/${id}`, { method: "DELETE" });
    expect(deps.db.select().from(qaMessages).where(eq(qaMessages.paperId, id)).all()).toEqual([]);
  });
});
