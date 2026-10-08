import { ApiError, type GenerateContentResponse } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { createLlm, LlmRateLimitError, type GeminiClient } from "./llm.js";

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

describe("gemini llm", () => {
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

  it("sends the title and text as plain text and returns the trimmed summary", async () => {
    const { client, generateContent } = fakeClient(async () => ({ text: "  Problem: x\n" }));

    expect(await makeLlm(client).summarize({ title: "A Paper", text: "Full body" })).toBe("Problem: x");
    const params = generateContent.mock.calls[0]![0];
    expect(params.contents).toContain("Title: A Paper");
    expect(params.contents).toContain("<paper_text>\nFull body\n</paper_text>");
    expect(params.config?.responseMimeType).toBeUndefined();
  });

  it("waits for the rate limiter before every request", async () => {
    const order: string[] = [];
    const { client } = fakeClient(async () => {
      order.push("request");
      return { text: JSON.stringify(metadata) };
    });
    const llm = makeLlm(client, async () => void order.push("acquire"));
    await llm.extractMetadata("x");
    await llm.summarize({ title: "t", text: "x" });
    expect(order).toEqual(["acquire", "request", "acquire", "request"]);
  });

  it("fails with a helpful message when no API key is configured", async () => {
    const llm = createLlm({ model: "m", requestsPerMinute: 5, acquire: async () => {} });
    await expect(llm.extractMetadata("x")).rejects.toThrow(/GEMINI_API_KEY is not set/);
    await expect(llm.summarize({ title: "t", text: "x" })).rejects.toThrow(/GEMINI_API_KEY is not set/);
  });

  it("maps HTTP 429 to a rate limit error", async () => {
    const { client } = fakeClient(async () => {
      throw new ApiError({ message: "quota exceeded", status: 429 });
    });
    const llm = makeLlm(client);
    await expect(llm.extractMetadata("x")).rejects.toBeInstanceOf(LlmRateLimitError);
    await expect(llm.summarize({ title: "t", text: "x" })).rejects.toBeInstanceOf(LlmRateLimitError);
  });

  it("reports blocked prompts, empty responses, bad JSON and schema mismatches", async () => {
    const cases: [Partial<GenerateContentResponse>, RegExp][] = [
      [{ promptFeedback: { blockReason: "SAFETY" as never } }, /declined.*SAFETY/],
      [{ text: "" }, /no content/],
      [{ text: "not json" }, /invalid JSON/],
      [{ text: JSON.stringify({ title: "Only a title" }) }, /expected format/],
    ];
    for (const [response, message] of cases) {
      const { client } = fakeClient(async () => response);
      await expect(makeLlm(client).extractMetadata("x")).rejects.toThrow(message);
    }
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

  it("skips chunks without text and waits for the rate limiter first", async () => {
    const order: string[] = [];
    const { client, generateContentStream } = fakeStreamClient([{ text: "" }, { text: "Hi" }, { candidates: [{ finishReason: "STOP" as never }] }]);
    const original = generateContentStream.getMockImplementation()!;
    generateContentStream.mockImplementation(async (params) => {
      order.push("request");
      return original(params);
    });
    const llm = makeLlm(client, async () => void order.push("acquire"));
    expect(await collect(llm.answer(question()))).toEqual(["Hi"]);
    expect(order).toEqual(["acquire", "request"]);
  });

  it("fails with a helpful message when no API key is configured", async () => {
    const llm = createLlm({ model: "m", requestsPerMinute: 5, acquire: async () => {} });
    await expect(collect(llm.answer(question()))).rejects.toThrow(/GEMINI_API_KEY is not set/);
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

  it("reports blocked prompts and empty streams", async () => {
    const blocked = fakeStreamClient([{ promptFeedback: { blockReason: "SAFETY" as never } }]);
    await expect(collect(makeLlm(blocked.client).answer(question()))).rejects.toThrow(/declined.*SAFETY/);

    const empty = fakeStreamClient([{ candidates: [{ finishReason: "MAX_TOKENS" as never }] }]);
    await expect(collect(makeLlm(empty.client).answer(question()))).rejects.toThrow(/no content.*MAX_TOKENS/);
  });
});
