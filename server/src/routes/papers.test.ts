import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createDb, IN_MEMORY_DB } from "../db/client.js";

const sample = {
  title: "Attention Is All You Need",
  authors: ["Ashish Vaswani", "Noam Shazeer"],
  year: 2017,
  abstract: null,
  url: "https://example.com/paper",
  externalId: "abc123",
  pdfUrl: null,
};

describe("papers routes", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = createApp(createDb(IN_MEMORY_DB));
  });

  const post = (body: unknown) =>
    app.request("/api/papers/from-search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("saves, lists, fetches and deletes a paper", async () => {
    const created = await post(sample);
    expect(created.status).toBe(201);
    const paper = (await created.json()) as { id: number; title: string };
    expect(paper.title).toBe(sample.title);

    const list = (await (await app.request("/api/papers")).json()) as unknown[];
    expect(list).toHaveLength(1);

    expect((await app.request(`/api/papers/${paper.id}`)).status).toBe(200);
    expect((await app.request(`/api/papers/${paper.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(`/api/papers/${paper.id}`)).status).toBe(404);
  });

  it("dedupes on externalId", async () => {
    await post(sample);
    const again = await post(sample);
    expect(again.status).toBe(200);
    const list = (await (await app.request("/api/papers")).json()) as unknown[];
    expect(list).toHaveLength(1);
  });

  it("rejects invalid input", async () => {
    expect((await post({ title: "" })).status).toBe(400);
  });
});
