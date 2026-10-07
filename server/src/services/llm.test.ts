import { ApiError, type GenerateContentResponse } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { createLlm, LlmRateLimitError, type GeminiClient } from "./llm.js";

const metadata = { title: "A Paper", authors: ["Ada Lovelace"], year: 2021, abstract: "We do things." };

function fakeClient(respond: () => Promise<Partial<GenerateContentResponse>>) {
  const generateContent = vi.fn(respond as GeminiClient["models"]["generateContent"]);
  return { client: { models: { generateContent } } satisfies GeminiClient, generateContent };
}

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

  it("waits for the rate limiter before every request", async () => {
    const order: string[] = [];
    const { client } = fakeClient(async () => {
      order.push("request");
      return { text: JSON.stringify(metadata) };
    });
    await makeLlm(client, async () => void order.push("acquire")).extractMetadata("x");
    expect(order).toEqual(["acquire", "request"]);
  });

  it("fails with a helpful message when no API key is configured", async () => {
    const llm = createLlm({ model: "m", requestsPerMinute: 5, acquire: async () => {} });
    await expect(llm.extractMetadata("x")).rejects.toThrow(/GEMINI_API_KEY is not set/);
  });

  it("maps HTTP 429 to a rate limit error", async () => {
    const { client } = fakeClient(async () => {
      throw new ApiError({ message: "quota exceeded", status: 429 });
    });
    await expect(makeLlm(client).extractMetadata("x")).rejects.toBeInstanceOf(LlmRateLimitError);
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
