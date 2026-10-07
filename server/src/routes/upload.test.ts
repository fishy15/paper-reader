import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Paper } from "@paper-reader/shared";
import type { Llm } from "../services/llm.js";
import { fakeLlm, makePdf, makeTestApp } from "../test-utils.js";
import { MAX_PDF_BYTES } from "./upload.js";

type App = ReturnType<typeof makeTestApp>["app"];

function upload(app: App, bytes: Uint8Array<ArrayBuffer>, name = "paper.pdf") {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type: "application/pdf" }));
  return app.request("/api/papers/upload", { method: "POST", body: form });
}

describe("PDF upload", () => {
  it("stores the PDF, extracts metadata with the LLM and saves an upload paper", async () => {
    const extractMetadata = vi.fn<Llm["extractMetadata"]>(async () => ({
      title: "  A Great Paper ",
      authors: ["Ada Lovelace", " ", "Alan Turing"],
      year: 2021,
      abstract: "We do things.",
    }));
    const { app, deps } = makeTestApp({ llm: fakeLlm({ extractMetadata }) });

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

    // Only the first two pages are sent for metadata extraction.
    const sent = extractMetadata.mock.calls[0]![0];
    expect(sent).toContain("Page one text");
    expect(sent).toContain("Page two text");
    expect(sent).not.toContain("Page three text");

    expect(fs.readdirSync(path.join(deps.dataDir, "pdfs"))).toHaveLength(1);
    const list = (await (await app.request("/api/papers")).json()) as Paper[];
    expect(list).toHaveLength(1);
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
  });

  it("rejects PDFs without extractable text and stores nothing", async () => {
    const { app, deps } = makeTestApp();
    const res = await upload(app, makePdf([""]));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: expect.stringContaining("No text found") });
    expect(fs.existsSync(path.join(deps.dataDir, "pdfs"))).toBe(false);
  });

  it("rejects requests without a file", async () => {
    const { app } = makeTestApp();
    const res = await app.request("/api/papers/upload", { method: "POST", body: new FormData() });
    expect(res.status).toBe(400);
  });

  it("rejects files over the size limit", async () => {
    const { app } = makeTestApp();
    const res = await upload(app, new Uint8Array(MAX_PDF_BYTES + 1));
    expect(res.status).toBe(413);
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
    vi.restoreAllMocks();
  });
});
