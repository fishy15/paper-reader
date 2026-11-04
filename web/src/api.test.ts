import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { QaStreamEvent } from "@paper-reader/shared";
import {
  ApiError, askQuestion, deletePaper, getPaper, listMessages, listPapers, savePaper, searchPapers,
  summarizePaper, uploadPaper,
} from "./api.js";
import { makeMessage, makePaper, makeSearchResult, ndjson } from "./test/fixtures.js";
import { server } from "./test/server.js";

async function collect(events: AsyncGenerator<QaStreamEvent>) {
  const out: QaStreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("api", () => {
  it("searchPapers sends the query and returns the results", async () => {
    const results = [makeSearchResult()];
    let query: string | null = null;
    server.use(
      http.get("*/api/search", ({ request }) => {
        query = new URL(request.url).searchParams.get("query");
        return HttpResponse.json(results);
      }),
    );
    expect(await searchPapers("a b&c")).toEqual(results);
    expect(query).toBe("a b&c");
  });

  describe("returns the JSON body", () => {
    const paper = makePaper({ id: 7 });
    const messages = [makeMessage({ paperId: 7 })];
    const cases: [string, () => Promise<unknown>, unknown][] = [
      ["listPapers", () => listPapers(), [paper]],
      ["getPaper", () => getPaper(7), paper],
      ["listMessages", () => listMessages(7), messages],
      ["summarizePaper", () => summarizePaper(7), { ...paper, summary: "S" }],
    ];

    it.each(cases)("%s", async (_name, call, expected) => {
      server.use(
        http.get("*/api/papers", () => HttpResponse.json([paper])),
        http.get("*/api/papers/7", () => HttpResponse.json(paper)),
        http.get("*/api/papers/7/messages", () => HttpResponse.json(messages)),
        http.post("*/api/papers/7/summarize", () => HttpResponse.json({ ...paper, summary: "S" })),
      );
      expect(await call()).toEqual(expected);
    });
  });

  it("savePaper posts the search result as JSON", async () => {
    const result = makeSearchResult();
    let body: unknown;
    server.use(
      http.post("*/api/papers/from-search", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(makePaper(), { status: 201 });
      }),
    );
    await savePaper(result);
    expect(body).toEqual(result);
  });

  it("uploadPaper posts multipart form data", async () => {
    let type: string | null = null;
    server.use(
      http.post("*/api/papers/upload", ({ request }) => {
        type = request.headers.get("content-type");
        return HttpResponse.json(makePaper(), { status: 201 });
      }),
    );
    await uploadPaper(new File(["%PDF-"], "a.pdf", { type: "application/pdf" }));
    expect(type).toMatch(/^multipart\/form-data/);
  });

  it("deletePaper resolves with no value", async () => {
    server.use(http.delete("*/api/papers/3", () => HttpResponse.json({ ok: true })));
    await expect(deletePaper(3)).resolves.toBeUndefined();
  });

  it("throws an ApiError with the server's message for { error } bodies", async () => {
    server.use(http.get("*/api/papers", () => HttpResponse.json({ error: "Nope" }, { status: 400 })));
    const err = await listPapers().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("Nope");
  });

  it.each<[string, () => Response, number]>([
    ["a non-string error", () => HttpResponse.json({ error: 123 }, { status: 400 }), 400],
    ["an empty body", () => new HttpResponse(null, { status: 404 }), 404],
    ["a null body", () => HttpResponse.json(null, { status: 500 }), 500],
    ["an HTML body", () => new HttpResponse("<html>oops</html>", { status: 502 }), 502],
    ["a { message } body", () => HttpResponse.json({ message: "x" }, { status: 500 }), 500],
    ["an empty error message", () => HttpResponse.json({ error: "" }, { status: 500 }), 500],
  ])("falls back to the status code for %s", async (_name, respond, status) => {
    server.use(http.get("*/api/papers", respond));
    const err = await listPapers().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe(`Request failed (${status})`);
  });

  it("turns a network failure into an ApiError", async () => {
    server.use(http.get("*/api/papers", () => HttpResponse.error()));
    const err = await listPapers().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("Could not reach the server");
  });

  it("rejects with an AbortError, not an ApiError, when the signal aborted before the call", async () => {
    server.use(http.post("*/api/papers/2/ask", () => new HttpResponse(ndjson([{ type: "done" }]))));
    const controller = new AbortController();
    controller.abort();
    const err: unknown = await collect(askQuestion(2, "q", controller.signal)).catch((e) => e);
    expect(err).not.toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ name: "AbortError" });
  });

  describe("every call surfaces the server's message", () => {
    const calls: [string, () => Promise<unknown>][] = [
      ["searchPapers", () => searchPapers("q")],
      ["listPapers", () => listPapers()],
      ["savePaper", () => savePaper(makeSearchResult())],
      ["uploadPaper", () => uploadPaper(new File(["x"], "a.pdf"))],
      ["deletePaper", () => deletePaper(1)],
      ["getPaper", () => getPaper(1)],
      ["summarizePaper", () => summarizePaper(1)],
      ["listMessages", () => listMessages(1)],
      ["askQuestion", () => collect(askQuestion(1, "q"))],
    ];

    it.each(calls)("%s", async (_name, call) => {
      server.use(http.all("*/api/*", () => HttpResponse.json({ error: "Down" }, { status: 500 })));
      const err = await call().catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ message: "Down" });
    });
  });
});

describe("askQuestion", () => {
  it("sends the question and yields the streamed events", async () => {
    let body: unknown;
    server.use(
      http.post("*/api/papers/2/ask", async ({ request }) => {
        body = await request.json();
        return new HttpResponse(ndjson([{ type: "delta", text: "Hi" }, { type: "done" }]));
      }),
    );
    expect(await collect(askQuestion(2, "Why?"))).toEqual([{ type: "delta", text: "Hi" }, { type: "done" }]);
    expect(body).toEqual({ question: "Why?" });
  });

  it("throws the server's message when the request is rejected before streaming", async () => {
    server.use(http.post("*/api/papers/2/ask", () => HttpResponse.json({ error: "Rate limit" }, { status: 429 })));
    await expect(collect(askQuestion(2, "q"))).rejects.toThrow("Rate limit");
  });

  it("throws when the stream carries an unreadable line", async () => {
    server.use(http.post("*/api/papers/2/ask", () => new HttpResponse("not json\n")));
    await expect(collect(askQuestion(2, "q"))).rejects.toThrow(/unreadable response/);
  });

  it("throws when a successful response has no body", async () => {
    server.use(http.post("*/api/papers/2/ask", () => new HttpResponse(null)));
    const err = await collect(askQuestion(2, "q")).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("The server sent an empty response");
  });

  it("yields an error event instead of throwing", async () => {
    const events: QaStreamEvent[] = [{ type: "delta", text: "Partial" }, { type: "error", message: "boom" }];
    server.use(http.post("*/api/papers/2/ask", () => new HttpResponse(ndjson(events))));
    expect(await collect(askQuestion(2, "q"))).toEqual(events);
  });

  it("yields the first event before the stream closes", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const encoder = new TextEncoder();
    server.use(
      http.post("*/api/papers/2/ask", () =>
        new HttpResponse(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(encoder.encode(ndjson([{ type: "delta", text: "First" }])));
              await released;
              controller.enqueue(encoder.encode(ndjson([{ type: "done" }])));
              controller.close();
            },
          }),
        ),
      ),
    );
    const events = askQuestion(2, "q");
    expect(await events.next()).toEqual({ done: false, value: { type: "delta", text: "First" } });
    release();
    expect(await events.next()).toEqual({ done: false, value: { type: "done" } });
    expect((await events.next()).done).toBe(true);
  });

  it("aborts the request when the signal fires", async () => {
    server.use(
      http.post("*/api/papers/2/ask", async () => {
        await delay("infinite");
        return new HttpResponse(null);
      }),
    );
    const controller = new AbortController();
    const pending = collect(askQuestion(2, "q", controller.signal));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects with an AbortError when aborted after the first chunk", async () => {
    server.use(
      http.post("*/api/papers/2/ask", () =>
        new HttpResponse(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(ndjson([{ type: "delta", text: "A" }])));
            },
          }),
        ),
      ),
    );
    const controller = new AbortController();
    const events = askQuestion(2, "q", controller.signal);
    expect((await events.next()).value).toEqual({ type: "delta", text: "A" });
    controller.abort();
    await expect(events.next()).rejects.toMatchObject({ name: "AbortError" });
  });
});
