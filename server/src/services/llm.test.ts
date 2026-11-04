import { ApiError, type GenerateContentResponse } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLlm, LlmRateLimitError, type GeminiClient, type Llm } from "./llm.js";

const metadata = { title: "A Paper", authors: ["Ada Lovelace"], year: 2021, abstract: "We do things." };

function fakeClient(respond: () => Promise<Partial<GenerateContentResponse>>) {
  const generateContent = vi.fn(respond as GeminiClient["models"]["generateContent"]);
  const generateContentStream = vi.fn<GeminiClient["models"]["generateContentStream"]>(async () => {
    throw new Error("unexpected streaming call");
  });
  return { client: { models: { generateContent, generateContentStream } } satisfies GeminiClient, generateContent };
}

/** A client whose streaming call yields the given chunks (an Error in the list is thrown at that point). */
function fakeStreamClient(chunks: (Partial<GenerateContentResponse> | Error)[]) {
  const generateContentStream = vi.fn<GeminiClient["models"]["generateContentStream"]>(async () =>
    (async function* () {
      for (const chunk of chunks) {
        if (chunk instanceof Error) throw chunk;
        yield chunk as GenerateContentResponse;
      }
    })(),
  );
  const generateContent = vi.fn<GeminiClient["models"]["generateContent"]>();
  return { client: { models: { generateContent, generateContentStream } } satisfies GeminiClient, generateContentStream };
}

async function collect(stream: AsyncGenerator<string>) {
  const parts: string[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

const question = (overrides = {}) => ({ title: "A Paper", text: "Paper body", history: [], question: "Why?", ...overrides });

function makeLlm(client: GeminiClient, acquire = async () => {}) {
  return createLlm({ model: "test-model", requestsPerMinute: 5, client, acquire });
}

const summaryInput = { title: "t", text: "x" };

const nonRateLimitErrors: [string, Error][] = [
  ...[400, 401, 403, 500, 503].map((status): [string, Error] => [
    `ApiError ${status}`,
    new ApiError({ message: `status ${status}`, status }),
  ]),
  ["a plain Error", new Error("socket hang up")],
];

describe("gemini llm", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the paper text with a JSON schema and returns the parsed metadata", async () => {
    const { client, generateContent } = fakeClient(async () => ({ text: JSON.stringify(metadata) }));
    expect(await makeLlm(client).extractMetadata("Page one")).toEqual(metadata);

    const params = generateContent.mock.calls[0]![0];
    expect(params.model).toBe("test-model");
    expect(params.contents).toContain("Page one");
    expect(params.config).toMatchObject({ responseMimeType: "application/json" });
    const schema = params.config?.responseJsonSchema as Record<string, unknown>;
    expect(schema["$schema"]).toBeUndefined();
    expect(schema).toMatchObject({
      type: "object",
      required: ["title", "authors", "year", "abstract"],
    });
  });

  it("accepts a year of 0 and an empty abstract, which mean 'not stated'", async () => {
    const notStated = { ...metadata, year: 0, abstract: "" };
    const { client } = fakeClient(async () => ({ text: JSON.stringify(notStated) }));
    expect(await makeLlm(client).extractMetadata("x")).toEqual(notStated);
  });

  it.each([
    ["a year that is a string", { ...metadata, year: "2021" }],
    ["missing authors", { title: "A Paper", year: 2021, abstract: "We do things." }],
  ])("rejects metadata with %s", async (_name, response) => {
    const { client } = fakeClient(async () => ({ text: JSON.stringify(response) }));
    await expect(makeLlm(client).extractMetadata("x")).rejects.toThrow(/expected format/);
  });

  it("sends the title and text as plain text and returns the trimmed summary", async () => {
    const { client, generateContent } = fakeClient(async () => ({ text: "  Problem: x\n" }));

    expect(await makeLlm(client).summarize({ title: "A Paper", text: "Full body" })).toBe("Problem: x");
    const params = generateContent.mock.calls[0]![0];
    expect(params.contents).toContain("Title: A Paper");
    expect(params.contents).toContain("<paper_text>\nFull body\n</paper_text>");
    expect(params.config?.responseMimeType).toBeUndefined();
  });

  it("trims only the ends of a multi-paragraph summary", async () => {
    const summary = "Problem: a\n\nMethod: b\nstill method\n\nResults: c";
    const { client } = fakeClient(async () => ({ text: `\n  ${summary}\n\n` }));
    expect(await makeLlm(client).summarize(summaryInput)).toBe(summary);
  });

  it("treats a whitespace-only response as no content", async () => {
    const { client } = fakeClient(async () => ({ text: " \n  ", candidates: [{ finishReason: "STOP" as never }] }));
    await expect(makeLlm(client).summarize(summaryInput)).rejects.toThrow(/no content.*STOP/);
  });

  it("waits for the rate limiter before every request", async () => {
    const order: string[] = [];
    const { client } = fakeClient(async () => {
      order.push("request");
      return { text: JSON.stringify(metadata) };
    });
    const llm = makeLlm(client, async () => void order.push("acquire"));
    await llm.extractMetadata("x");
    await llm.summarize(summaryInput);
    expect(order).toEqual(["acquire", "request", "acquire", "request"]);
  });

  it("uses a rate limiter spaced by requestsPerMinute when none is injected", async () => {
    vi.useFakeTimers();
    const { client, generateContent } = fakeClient(async () => ({ text: "ok" }));
    const llm = createLlm({ model: "m", requestsPerMinute: 60, client });

    await llm.summarize(summaryInput);
    const second = llm.summarize(summaryInput);
    await vi.advanceTimersByTimeAsync(999);
    expect(generateContent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it("fails with a helpful message when no API key is configured", async () => {
    const llm = createLlm({ model: "m", requestsPerMinute: 5, acquire: async () => {} });
    await expect(llm.extractMetadata("x")).rejects.toThrow(/GEMINI_API_KEY is not set/);
    await expect(llm.summarize(summaryInput)).rejects.toThrow(/GEMINI_API_KEY is not set/);
  });

  it("does not use the rate limiter when no API key is configured", async () => {
    const acquire = vi.fn(async () => {});
    const llm = createLlm({ model: "m", requestsPerMinute: 5, acquire });
    await expect(llm.summarize(summaryInput)).rejects.toThrow(/GEMINI_API_KEY is not set/);
    await expect(collect(llm.answer(question()))).rejects.toThrow(/GEMINI_API_KEY is not set/);
    expect(acquire).not.toHaveBeenCalled();
  });

  it.each([
    ["extractMetadata", (llm: Llm) => llm.extractMetadata("x")],
    ["summarize", (llm: Llm) => llm.summarize(summaryInput)],
  ])("maps HTTP 429 from %s to a rate limit error", async (_name, call) => {
    const { client } = fakeClient(async () => {
      throw new ApiError({ message: "quota exceeded", status: 429 });
    });
    const result = call(makeLlm(client));
    await expect(result).rejects.toBeInstanceOf(LlmRateLimitError);
    await expect(result).rejects.toThrow(/rate limit/i);
  });

  it.each(nonRateLimitErrors)("passes %s through unchanged", async (_name, error) => {
    const { client } = fakeClient(async () => {
      throw error;
    });
    const llm = makeLlm(client);
    for (const result of [llm.extractMetadata("x"), llm.summarize(summaryInput)]) {
      await expect(result).rejects.toBe(error);
      await expect(result).rejects.not.toBeInstanceOf(LlmRateLimitError);
    }
  });

  it.each<[string, Partial<GenerateContentResponse>, RegExp]>([
    ["a blocked prompt", { promptFeedback: { blockReason: "SAFETY" as never } }, /declined.*SAFETY/],
    ["an empty response", { text: "" }, /no content/],
    ["bad JSON", { text: "not json" }, /invalid JSON/],
    ["a schema mismatch", { text: JSON.stringify({ title: "Only a title" }) }, /expected format/],
  ])("reports %s", async (_name, response, message) => {
    const { client } = fakeClient(async () => response);
    await expect(makeLlm(client).extractMetadata("x")).rejects.toThrow(message);
  });

  it("names the finish reason of an empty response, or 'unknown' without one", async () => {
    const withReason = fakeClient(async () => ({ text: "", candidates: [{ finishReason: "MAX_TOKENS" as never }] }));
    await expect(makeLlm(withReason.client).summarize(summaryInput)).rejects.toThrow(/no content.*MAX_TOKENS/);

    const withoutReason = fakeClient(async () => ({ text: "" }));
    await expect(makeLlm(withoutReason.client).summarize(summaryInput)).rejects.toThrow(/no content.*unknown/);
  });

  it.each([
    ["extractMetadata", (llm: Llm) => llm.extractMetadata("Page one")],
    ["summarize", (llm: Llm) => llm.summarize({ title: "t", text: "Page one" })],
  ])("tells the model that the paper text from %s is untrusted", async (_name, call) => {
    const { client, generateContent } = fakeClient(async () => ({ text: JSON.stringify(metadata) }));
    await call(makeLlm(client));
    const params = generateContent.mock.calls[0]![0];
    expect(params.config?.systemInstruction).toContain("untrusted");
    expect(params.contents).toContain("<paper_text>\nPage one\n</paper_text>");
  });
});

describe("gemini llm answer", () => {
  it("streams the text chunks and builds the conversation from the history", async () => {
    const { client, generateContentStream } = fakeStreamClient([{ text: "Because " }, { text: "of X." }]);
    const history = [
      { role: "user" as const, content: "What is it?" },
      { role: "assistant" as const, content: "A method." },
    ];

    expect(await collect(makeLlm(client).answer(question({ history })))).toEqual(["Because ", "of X."]);

    const params = generateContentStream.mock.calls[0]![0];
    expect(params.contents).toEqual([
      { role: "user", parts: [{ text: "What is it?" }] },
      { role: "model", parts: [{ text: "A method." }] },
      { role: "user", parts: [{ text: "Why?" }] },
    ]);
    const system = params.config?.systemInstruction as string;
    expect(system).toContain("Title: A Paper");
    expect(system).toContain("<paper_text>\nPaper body\n</paper_text>");
  });

  it("tells the model the paper text is untrusted and keeps it out of the user turns", async () => {
    const { client, generateContentStream } = fakeStreamClient([{ text: "ok" }]);
    await collect(makeLlm(client).answer(question({ text: "SECRET BODY" })));

    const params = generateContentStream.mock.calls[0]![0];
    const system = params.config?.systemInstruction as string;
    expect(system).toContain("untrusted");
    expect(system).toContain("<paper_text>\nSECRET BODY\n</paper_text>");
    expect(JSON.stringify(params.contents)).not.toContain("SECRET BODY");
  });

  it("skips chunks without text", async () => {
    const { client } = fakeStreamClient([{ text: "" }, { text: "Hi" }, { candidates: [{ finishReason: "STOP" as never }] }]);
    expect(await collect(makeLlm(client).answer(question()))).toEqual(["Hi"]);
  });

  it("waits for the rate limiter before the request", async () => {
    const order: string[] = [];
    const { client, generateContentStream } = fakeStreamClient([{ text: "Hi" }]);
    generateContentStream.mockImplementationOnce(async () => {
      order.push("request");
      return (async function* () {
        yield { text: "Hi" } as GenerateContentResponse;
      })();
    });
    const llm = makeLlm(client, async () => void order.push("acquire"));
    await collect(llm.answer(question()));
    expect(order).toEqual(["acquire", "request"]);
  });

  it("fails with a helpful message when no API key is configured", async () => {
    const llm = createLlm({ model: "m", requestsPerMinute: 5, acquire: async () => {} });
    await expect(collect(llm.answer(question()))).rejects.toThrow(/GEMINI_API_KEY is not set/);
  });

  it("propagates a failing rate limiter without making a request", async () => {
    const failure = new Error("limiter broke");
    const { client, generateContentStream } = fakeStreamClient([{ text: "Hi" }]);
    const llm = makeLlm(client, async () => {
      throw failure;
    });
    await expect(collect(llm.answer(question()))).rejects.toBe(failure);
    expect(generateContentStream).not.toHaveBeenCalled();
  });

  it("maps HTTP 429 to a rate limit error, before or during the stream", async () => {
    const limited = new ApiError({ message: "quota exceeded", status: 429 });
    const before = fakeStreamClient([]);
    before.generateContentStream.mockRejectedValueOnce(limited);
    await expect(collect(makeLlm(before.client).answer(question()))).rejects.toBeInstanceOf(LlmRateLimitError);

    const during = fakeStreamClient([{ text: "partial" }, limited]);
    const received: string[] = [];
    await expect(
      (async () => {
        for await (const part of makeLlm(during.client).answer(question())) received.push(part);
      })(),
    ).rejects.toBeInstanceOf(LlmRateLimitError);
    expect(received).toEqual(["partial"]);
  });

  it.each(nonRateLimitErrors)("passes %s through unchanged, before or during the stream", async (_name, error) => {
    const before = fakeStreamClient([]);
    before.generateContentStream.mockRejectedValueOnce(error);
    const beforeResult = collect(makeLlm(before.client).answer(question()));
    await expect(beforeResult).rejects.toBe(error);
    await expect(beforeResult).rejects.not.toBeInstanceOf(LlmRateLimitError);

    const during = fakeStreamClient([{ text: "partial" }, error]);
    const duringResult = collect(makeLlm(during.client).answer(question()));
    await expect(duringResult).rejects.toBe(error);
    await expect(duringResult).rejects.not.toBeInstanceOf(LlmRateLimitError);
  });

  it("reports blocked prompts and empty streams", async () => {
    const blocked = fakeStreamClient([{ promptFeedback: { blockReason: "SAFETY" as never } }]);
    await expect(collect(makeLlm(blocked.client).answer(question()))).rejects.toThrow(/declined.*SAFETY/);

    const empty = fakeStreamClient([{ candidates: [{ finishReason: "MAX_TOKENS" as never }] }]);
    await expect(collect(makeLlm(empty.client).answer(question()))).rejects.toThrow(/no content.*MAX_TOKENS/);
  });

  it("delivers the text that came before a block in the middle of the stream", async () => {
    const { client } = fakeStreamClient([{ text: "Some text" }, { promptFeedback: { blockReason: "SAFETY" as never } }]);
    const received: string[] = [];
    await expect(
      (async () => {
        for await (const part of makeLlm(client).answer(question())) received.push(part);
      })(),
    ).rejects.toThrow(/declined.*SAFETY/);
    expect(received).toEqual(["Some text"]);
  });

  it("keeps the finish reason from an earlier chunk when later chunks have none", async () => {
    const { client } = fakeStreamClient([{ candidates: [{ finishReason: "SAFETY" as never }] }, { candidates: [] }, {}]);
    await expect(collect(makeLlm(client).answer(question()))).rejects.toThrow(/no content.*SAFETY/);
  });

  it("reports an unknown finish reason for a stream with no chunks", async () => {
    const { client } = fakeStreamClient([]);
    await expect(collect(makeLlm(client).answer(question()))).rejects.toThrow(/no content.*unknown/);
  });

  it("stops the Gemini stream when the answer is closed early", async () => {
    let requested = 0;
    let closed = false;
    const generateContentStream = vi.fn<GeminiClient["models"]["generateContentStream"]>(async () =>
      (async function* () {
        try {
          while (true) {
            requested++;
            yield { text: `chunk ${requested}` } as GenerateContentResponse;
          }
        } finally {
          closed = true;
        }
      })(),
    );
    const generateContent = vi.fn<GeminiClient["models"]["generateContent"]>();
    const llm = makeLlm({ models: { generateContent, generateContentStream } });

    const answer = llm.answer(question());
    expect((await answer.next()).value).toBe("chunk 1");
    await answer.return(undefined);

    expect(closed).toBe(true);
    expect(requested).toBe(1);
  });
});
