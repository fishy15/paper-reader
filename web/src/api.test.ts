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

  it("listPapers, getPaper, listMessages and summarizePaper return the JSON body", async () => {
    const paper = makePaper({ id: 7 });
    const messages = [makeMessage({ paperId: 7 })];
    server.use(
      http.get("*/api/papers", () => HttpResponse.json([paper])),
      http.get("*/api/papers/7", () => HttpResponse.json(paper)),
      http.get("*/api/papers/7/messages", () => HttpResponse.json(messages)),
      http.post("*/api/papers/7/summarize", () => HttpResponse.json({ ...paper, summary: "S" })),
    );
    expect(await listPapers()).toEqual([paper]);
    expect(await getPaper(7)).toEqual(paper);
    expect(await listMessages(7)).toEqual(messages);
    expect((await summarizePaper(7)).summary).toBe("S");
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

  it("falls back to the status code when the body is not an { error } object", async () => {
    server.use(
      http.get("*/api/papers", () => new HttpResponse("<html>oops</html>", { status: 502 })),
      http.get("*/api/papers/1", () => HttpResponse.json({ message: "x" }, { status: 500 })),
    );
    await expect(listPapers()).rejects.toThrow("Request failed (502)");
    await expect(getPaper(1)).rejects.toThrow("Request failed (500)");
  });

  it("every call turns a failed response into an ApiError", async () => {
    server.use(http.all("*/api/*", () => HttpResponse.json({ error: "Down" }, { status: 500 })));
    const calls = [
      () => searchPapers("q"), () => listPapers(), () => savePaper(makeSearchResult()),
      () => uploadPaper(new File(["x"], "a.pdf")), () => deletePaper(1), () => getPaper(1),
      () => summarizePaper(1), () => listMessages(1), () => collect(askQuestion(1, "q")),
    ];
    for (const call of calls) await expect(call()).rejects.toThrow(ApiError);
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
    await expect(pending).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
  });
});
