import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Paper } from "@paper-reader/shared";
import { papers } from "../db/schema.js";
import type { Llm } from "../services/llm.js";
import { fakeLlm, makePdf, makeTestApp } from "../test-utils.js";
import { MAX_PDF_BYTES } from "../services/pdf.js";

type App = ReturnType<typeof makeTestApp>["app"];

function upload(app: App, bytes: Uint8Array<ArrayBuffer>, name = "paper.pdf") {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type: "application/pdf" }));
  return app.request("/api/papers/upload", { method: "POST", body: form });
}

describe("PDF upload", () => {
  it("extracts metadata with the LLM and saves an upload paper", async () => {
    const extractMetadata = vi.fn<Llm["extractMetadata"]>(async () => ({
      title: "  A Great Paper ",
      authors: ["  Ada Lovelace ", " ", "Alan Turing"],
      year: 2021,
      abstract: "We do things.",
    }));
    const { app } = makeTestApp({ llm: fakeLlm({ extractMetadata }) });

    const res = await upload(app, makePdf(["Page one text", "Page two text", "Page three text"]));
    expect(res.status).toBe(201);
    const paper = (await res.json()) as Paper;
    expect(paper).toMatchObject({
      source: "upload",
      title: "A Great Paper",
      authors: ["Ada Lovelace", "Alan Turing"],
      year: 2021,
      abstract: "We do things.",
      hasPdf: true,
      url: null,
      pdfUrl: null,
    });
    expect("externalId" in paper).toBe(false);

    const list = (await (await app.request("/api/papers")).json()) as Paper[];
    expect(list).toHaveLength(1);
  });

  it("sends only the first two pages for metadata extraction", async () => {
    const extractMetadata = vi.fn<Llm["extractMetadata"]>(fakeLlm().extractMetadata);
    const { app } = makeTestApp({ llm: fakeLlm({ extractMetadata }) });

    await upload(app, makePdf(["Page one text", "Page two text", "Page three text"]));

    const sent = extractMetadata.mock.calls[0]![0];
    expect(sent).toContain("Page one text");
    expect(sent).toContain("Page two text");
    expect(sent).not.toContain("Page three text");
  });

  it("caps the text sent for metadata extraction at 12,000 characters", async () => {
    const extractMetadata = vi.fn<Llm["extractMetadata"]>(fakeLlm().extractMetadata);
    const { app } = makeTestApp({ llm: fakeLlm({ extractMetadata }) });

    expect((await upload(app, makePdf(["a".repeat(13_000)]))).status).toBe(201);

    expect(extractMetadata.mock.calls[0]![0].length).toBeLessThanOrEqual(12_000);
  });

  it("saves a row and file that match the upload", async () => {
    const { app, deps } = makeTestApp();
    const bytes = makePdf(["Page one text", "Page two text", "Page three text"]);

    const { id } = (await (await upload(app, bytes)).json()) as Paper;

    const row = deps.db.select().from(papers).where(eq(papers.id, id)).get()!;
    expect(row.fullText).toBe("Page one text\n\nPage two text\n\nPage three text");
    expect(row.localPdfPath).toMatch(/^pdfs\/[0-9a-f-]{36}\.pdf$/);
    expect(new Uint8Array(fs.readFileSync(path.join(deps.dataDir, row.localPdfPath!)))).toEqual(bytes);
  });

  it("deletes the stored PDF file together with the paper", async () => {
    const { app, deps } = makeTestApp();
    const paper = (await (await upload(app, makePdf(["Some text"]))).json()) as Paper;
    const pdfDir = path.join(deps.dataDir, "pdfs");
    expect(fs.readdirSync(pdfDir)).toHaveLength(1);

    expect((await app.request(`/api/papers/${paper.id}`, { method: "DELETE" })).status).toBe(200);
    expect(fs.readdirSync(pdfDir)).toHaveLength(0);
  });

  it("falls back to the filename and drops implausible values from the LLM", async () => {
    const { app } = makeTestApp({
      llm: fakeLlm({ extractMetadata: async () => ({ title: " ", authors: [], year: 20217, abstract: "  " }) }),
    });
    const paper = (await (await upload(app, makePdf(["x"]), "my-notes.pdf")).json()) as Paper;
    expect(paper).toMatchObject({ title: "my-notes", year: null, abstract: null, authors: [] });
  });

  it.each([
    ["0 (not stated)", 0, null],
    ["999", 999, null],
    ["1000", 1000, 1000],
    ["next year", 2027, 2027],
    ["the year after next", 2028, null],
    ["a fraction", 2021.5, null],
    ["NaN", NaN, null],
  ])("treats the year %s as %s", async (_name, year, expected) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { app } = makeTestApp({
      llm: fakeLlm({ extractMetadata: async () => ({ title: "T", authors: [], year, abstract: "A" }) }),
    });

    const paper = (await (await upload(app, makePdf(["x"]))).json()) as Paper;
    expect(paper.year).toBe(expected);
  });

  it.each([
    ["my-notes.pdf", "my-notes"],
    ["UPPER.PDF", "UPPER"],
    [".pdf", "Untitled"],
  ])("uses the title %s from the filename as %s when the LLM gives none", async (filename, expected) => {
    const { app } = makeTestApp({
      llm: fakeLlm({ extractMetadata: async () => ({ title: " ", authors: [], year: 2020, abstract: "A" }) }),
    });
    const paper = (await (await upload(app, makePdf(["x"]), filename)).json()) as Paper;
    expect(paper.title).toBe(expected);
  });

  // The multipart parser hands back a file with an empty name as a plain string, so the "Untitled"
  // fallback for an empty name can't be reached through the route.
  it("treats a file with an empty name as a missing file", async () => {
    const { app } = makeTestApp();
    const res = await upload(app, makePdf(["x"]), "");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/file/);
  });

  it("keeps two uploads of the same file independent", async () => {
    const { app, deps } = makeTestApp();
    const bytes = makePdf(["Same text"]);
    const first = (await (await upload(app, bytes)).json()) as Paper;
    const second = (await (await upload(app, bytes)).json()) as Paper;
    const pdfDir = path.join(deps.dataDir, "pdfs");
    expect(first.id).not.toBe(second.id);
    expect(fs.readdirSync(pdfDir)).toHaveLength(2);

    const paths = deps.db.select({ p: papers.localPdfPath }).from(papers).all().map((r) => r.p!);
    expect(new Set(paths).size).toBe(2);

    await app.request(`/api/papers/${first.id}`, { method: "DELETE" });
    const remaining = deps.db.select().from(papers).where(eq(papers.id, second.id)).get()!;
    expect(fs.readdirSync(pdfDir)).toHaveLength(1);
    expect(fs.existsSync(path.join(deps.dataDir, remaining.localPdfPath!))).toBe(true);
  });

  it("removes the stored file and returns a 500 when saving to the database fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, deps } = makeTestApp();
    vi.spyOn(deps.db, "insert").mockImplementation(() => {
      throw new Error("database is locked");
    });

    const res = await upload(app, makePdf(["Some text"]));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "database is locked" });
    expect(fs.readdirSync(path.join(deps.dataDir, "pdfs"))).toEqual([]);
  });

  it("rejects files that are not PDFs", async () => {
    const { app } = makeTestApp();
    const res = await upload(app, new TextEncoder().encode("just some text"), "notes.pdf");
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "File is not a PDF" });
  });

  it("rejects corrupt PDFs", async () => {
    const { app } = makeTestApp();
    const res = await upload(app, new TextEncoder().encode("%PDF-1.4\nthis is not really a pdf"));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/Could not read/);
  });

  it("rejects PDFs without extractable text and stores nothing", async () => {
    const { app, deps } = makeTestApp();
    const res = await upload(app, makePdf([""]));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: expect.stringContaining("No text found") });
    expect(fs.existsSync(path.join(deps.dataDir, "pdfs"))).toBe(false);
  });

  it.each<[string, (form: FormData) => void]>([
    ["no file field", () => {}],
    ["a file field sent as text", (form) => form.append("file", "not a file")],
  ])("rejects a request with %s, naming the file", async (_name, fill) => {
    const { app } = makeTestApp();
    const form = new FormData();
    fill(form);
    const res = await app.request("/api/papers/upload", { method: "POST", body: form });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/file/);
  });

  it("rejects files over the size limit", async () => {
    const { app } = makeTestApp();
    const res = await upload(app, new Uint8Array(MAX_PDF_BYTES + 1));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "PDF is too large (limit 25 MB)" });
  });

  it("accepts a valid PDF just under the size limit", async () => {
    const { app } = makeTestApp();
    const pdf = makePdf(["Some text"]);
    const padded = new Uint8Array(MAX_PDF_BYTES - 1000).fill(0x20);
    padded.set(pdf);
    expect((await upload(app, padded)).status).toBe(201);
  });

  // The limit applies to the whole multipart body, so a file of exactly the limit is already too big.
  it("rejects a file of exactly the size limit", async () => {
    const { app } = makeTestApp();
    const padded = new Uint8Array(MAX_PDF_BYTES).fill(0x20);
    padded.set(makePdf(["Some text"]));
    expect((await upload(app, padded)).status).toBe(413);
  });

  it("stores nothing when metadata extraction fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, deps } = makeTestApp({
      llm: fakeLlm({
        extractMetadata: async () => {
          throw new Error("Gemini declined to process this paper (SAFETY)");
        },
      }),
    });
    const res = await upload(app, makePdf(["Some text"]));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Gemini declined to process this paper (SAFETY)" });
    expect(fs.existsSync(path.join(deps.dataDir, "pdfs"))).toBe(false);
  });
});
