import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { papers } from "../db/schema.js";
import { makeTestApp } from "../test-utils.js";

const sample = {
  title: "Attention Is All You Need",
  authors: ["Ashish Vaswani", "Noam Shazeer"],
  year: 2017,
  abstract: null,
  url: "https://example.com/paper",
  externalId: "abc123",
  pdfUrl: "https://example.com/paper.pdf",
};

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

interface PaperBody {
  id: number;
  title: string;
  [key: string]: unknown;
}

describe("papers routes", () => {
  let app: ReturnType<typeof makeTestApp>["app"];
  let deps: ReturnType<typeof makeTestApp>["deps"];
  beforeEach(() => {
    ({ app, deps } = makeTestApp());
  });

  const savePaper = (body: unknown) =>
    app.request("/api/papers/from-search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const saveOk = async (body: unknown) => (await (await savePaper(body)).json()) as PaperBody;
  const listPapers = async () => (await (await app.request("/api/papers")).json()) as PaperBody[];

  it("saves a paper and returns its stored fields", async () => {
    const created = await savePaper(sample);
    expect(created.status).toBe(201);
    const paper = (await created.json()) as PaperBody;
    expect(paper.title).toBe(sample.title);
    expect(paper.url).toBe(sample.url);
    expect(paper.pdfUrl).toBe(sample.pdfUrl);
  });

  it("lists saved papers", async () => {
    await savePaper(sample);
    expect(await listPapers()).toHaveLength(1);
  });

  it("fetches a paper by id", async () => {
    const paper = await saveOk(sample);
    const res = await app.request(`/api/papers/${paper.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: paper.id, title: sample.title });
  });

  it("deletes a paper and returns { ok: true }", async () => {
    const paper = await saveOk(sample);
    const res = await app.request(`/api/papers/${paper.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await app.request(`/api/papers/${paper.id}`)).status).toBe(404);
  });

  it("deleting one paper leaves the others", async () => {
    const first = await saveOk(sample);
    const second = await saveOk({ ...sample, externalId: "other" });
    await app.request(`/api/papers/${first.id}`, { method: "DELETE" });
    expect((await listPapers()).map((p) => p.id)).toEqual([second.id]);
  });

  it("deletes a paper whose PDF file is already missing", async () => {
    const row = deps.db
      .insert(papers)
      .values({ title: "Gone", authors: [], source: "upload", localPdfPath: "missing.pdf" })
      .returning()
      .get();
    expect(fs.existsSync(path.join(deps.dataDir, "missing.pdf"))).toBe(false);
    const res = await app.request(`/api/papers/${row.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await app.request(`/api/papers/${row.id}`)).status).toBe(404);
  });

  it("dedupes on externalId and keeps the stored paper", async () => {
    const first = await saveOk(sample);
    const again = await savePaper({ ...sample, title: "A different title" });
    expect(again.status).toBe(200);
    const body = (await again.json()) as PaperBody;
    expect(body.id).toBe(first.id);
    expect(body.title).toBe(sample.title);
    expect(await listPapers()).toHaveLength(1);
  });

  it("returns the full paper shape from save, list and get", async () => {
    const expected = {
      id: expect.any(Number),
      source: "search",
      externalId: sample.externalId,
      title: sample.title,
      authors: sample.authors,
      year: sample.year,
      abstract: null,
      url: sample.url,
      pdfUrl: sample.pdfUrl,
      hasPdf: false,
      summary: null,
      createdAt: expect.stringMatching(ISO_UTC),
    };
    const created = await savePaper(sample);
    const paper = (await created.json()) as PaperBody;
    expect(paper).toEqual(expected);
    expect(await listPapers()).toEqual([expected]);
    expect(await (await app.request(`/api/papers/${paper.id}`)).json()).toEqual(expected);
  });

  it("never exposes fullText or the local PDF path, and reports hasPdf", async () => {
    const row = deps.db
      .insert(papers)
      .values({
        title: "Uploaded",
        authors: ["U. Ploader"],
        source: "upload",
        localPdfPath: "stored.pdf",
        fullText: "secret full text",
      })
      .returning()
      .get();
    const fetched = (await (await app.request(`/api/papers/${row.id}`)).json()) as PaperBody;
    const listed = (await listPapers())[0]!;
    for (const body of [fetched, listed]) {
      expect(body.hasPdf).toBe(true);
      expect(body).not.toHaveProperty("fullText");
      expect(body).not.toHaveProperty("localPdfPath");
    }
  });

  it("lists papers newest first and dedupes by externalId, not title", async () => {
    const a = await saveOk({ ...sample, externalId: "a" });
    const b = await saveOk({ ...sample, externalId: "b" });
    const c = await saveOk({ ...sample, externalId: "c", title: "Another" });
    expect(a.title).toBe(b.title);
    expect((await listPapers()).map((p) => p.id)).toEqual([c.id, b.id, a.id]);
  });

  it("round-trips optional and unusual values", async () => {
    const unusual = {
      title: "Über naïve 論文",
      authors: [],
      year: null,
      abstract: "An abstract.",
      url: null,
      externalId: "u1",
      pdfUrl: null,
    };
    const authored = { ...unusual, externalId: "u2", authors: ["Zoë Müller", "李雷"] };
    for (const input of [unusual, authored]) {
      const expected = {
        ...input,
        id: expect.any(Number),
        source: "search",
        hasPdf: false,
        summary: null,
        createdAt: expect.stringMatching(ISO_UTC),
      };
      const saved = await saveOk(input);
      expect(saved).toEqual(expected);
      expect(await (await app.request(`/api/papers/${saved.id}`)).json()).toEqual(expected);
      expect(await listPapers()).toContainEqual(expected);
    }
  });

  describe("invalid input", () => {
    const withoutAbstract = {
      title: sample.title,
      authors: sample.authors,
      year: sample.year,
      url: sample.url,
      externalId: sample.externalId,
      pdfUrl: sample.pdfUrl,
    };

    it.each([
      ["a missing body", {}, "title"],
      ["a missing abstract", withoutAbstract, "abstract"],
      ["an empty title", { ...sample, title: "" }, "title"],
      ["a missing externalId", { ...sample, externalId: undefined }, "externalId"],
      ["an empty externalId", { ...sample, externalId: "" }, "externalId"],
      ["a string year", { ...sample, year: "2017" }, "year"],
      ["a malformed pdfUrl", { ...sample, pdfUrl: "not a url" }, "pdfUrl"],
      ["a 2001-character title", { ...sample, title: "x".repeat(2001) }, "title"],
    ])("rejects %s with a 400 naming the field and saves nothing", async (_name, body, field) => {
      const res = await savePaper(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: expect.stringMatching(new RegExp(`^Invalid request \\((?:.*; )?${field}:`)) });
      expect(await listPapers()).toEqual([]);
    });

    it.each(["abc", "0", "-1", "1.5"].flatMap((id) => ["GET", "DELETE"].map((method) => [method, id] as const)))(
      "rejects %s with id %s with a 400",
      async (method, id) => {
        const res = await app.request(`/api/papers/${id}`, { method });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: expect.stringContaining("Invalid request") });
      },
    );

    it.each(["GET", "DELETE"])("returns 404 for a missing paper on %s", async (method) => {
      const res = await app.request("/api/papers/999", { method });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Paper not found" });
    });
  });
});
