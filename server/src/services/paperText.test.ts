import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, IN_MEMORY_DB } from "../db/client.js";
import { papers, type PaperRow } from "../db/schema.js";
import { makePdf } from "../test-utils.js";
import { limitPaperText, loadFullText, MAX_PAPER_CHARS, PaperTextError } from "./paperText.js";
import { downloadPdf } from "./pdfDownload.js";

// Keep the real download code and `PdfDownloadError`, but let a test make `downloadPdf` throw.
vi.mock("./pdfDownload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pdfDownload.js")>();
  return { ...actual, downloadPdf: vi.fn(actual.downloadPdf) };
});

const PDF_URL = "https://example.org/a.pdf";
const TRUNCATION_MARKER = "\n\n[Text truncated]";
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function setup(values: Partial<typeof papers.$inferInsert> = {}) {
  const db = createDb(IN_MEMORY_DB);
  const row: PaperRow = db
    .insert(papers)
    .values({ title: "P", authors: [], source: "search", externalId: "x", ...values })
    .returning()
    .get();
  return { db, row };
}

function stubFetch(impl: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

const storedText = (db: ReturnType<typeof setup>["db"], row: PaperRow) =>
  db.select().from(papers).where(eq(papers.id, row.id)).get()?.fullText;

describe("limitPaperText", () => {
  it("leaves text at or under the limit alone", () => {
    const text = "x".repeat(MAX_PAPER_CHARS);
    expect(limitPaperText(text)).toBe(text);
    expect(limitPaperText("")).toBe("");
  });

  it("truncates longer text and marks the cut", () => {
    expect(limitPaperText("x".repeat(MAX_PAPER_CHARS + 1))).toBe("x".repeat(MAX_PAPER_CHARS) + TRUNCATION_MARKER);
  });

  it.each([
    ["straddles the cut", MAX_PAPER_CHARS - 1, "x".repeat(MAX_PAPER_CHARS - 1)],
    ["ends exactly at the cut", MAX_PAPER_CHARS - 2, "x".repeat(MAX_PAPER_CHARS - 2) + "𝑥"],
  ])("never splits a character outside the basic plane when it %s", (_name, prefixLength, kept) => {
    const out = limitPaperText("x".repeat(prefixLength) + "𝑥" + "y");
    const expected = kept + TRUNCATION_MARKER;
    // Compare the tail and length rather than the whole string, so a failure stays readable.
    expect(LONE_SURROGATE.test(out)).toBe(false);
    expect(out.slice(-30)).toBe(expected.slice(-30));
    expect(out.length).toBe(expected.length);
  });
});

describe("limitPaperText surrogate boundaries", () => {
  it.each([0xd800, 0xdbff])("drops a lone high surrogate 0x%s left at the cut", (code) => {
    const out = limitPaperText("x".repeat(MAX_PAPER_CHARS - 1) + String.fromCharCode(code) + "y");
    expect(out).toBe("x".repeat(MAX_PAPER_CHARS - 1) + TRUNCATION_MARKER);
  });
});

describe("loadFullText", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns stored text without any download", async () => {
    const { db, row } = setup({ fullText: "stored", pdfUrl: PDF_URL });
    const fetchSpy = vi.fn(() => Promise.reject(new Error("should not fetch")));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await loadFullText(db, row)).toBe("stored");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects with 422 when there is no text and no PDF link", async () => {
    const { db, row } = setup();
    await expect(loadFullText(db, row)).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/Upload its PDF/),
    });
    await expect(loadFullText(db, row)).rejects.toBeInstanceOf(PaperTextError);
  });

  it("downloads, extracts, joins pages and stores the text", async () => {
    const { db, row } = setup({ pdfUrl: PDF_URL });
    stubFetch(async () => new Response(makePdf(["page one", "page two"])));
    expect(await loadFullText(db, row)).toBe("page one\n\npage two");
    expect(storedText(db, row)).toBe("page one\n\npage two");
  });

  it("drops blank leading and trailing pages", async () => {
    const { db, row } = setup({ pdfUrl: PDF_URL });
    stubFetch(async () => new Response(makePdf(["", "body", ""])));
    expect(await loadFullText(db, row)).toBe("body");
    expect(storedText(db, row)).toBe("body");
  });

  it("returns and stores text longer than the limit without truncating it", async () => {
    const { db, row } = setup({ pdfUrl: PDF_URL });
    // pdf.js clips a page's text to about 90 characters here, so reach the limit with many pages.
    const pages = Array.from({ length: 4600 }, () => "word ".repeat(18).trim());
    stubFetch(async () => new Response(makePdf(pages)));
    const text = await loadFullText(db, row);
    expect(text.length).toBeGreaterThan(MAX_PAPER_CHARS);
    expect(text).not.toContain("[Text truncated]");
    expect(storedText(db, row)?.length).toBe(text.length);
  }, 30_000);

  it("maps download failures to 502", async () => {
    const { db, row } = setup({ pdfUrl: PDF_URL });
    stubFetch(async () => new Response("no", { status: 500 }));
    await expect(loadFullText(db, row)).rejects.toBeInstanceOf(PaperTextError);
    await expect(loadFullText(db, row)).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/returned 500/),
    });
  });

  it("rethrows unexpected download errors unchanged and stores nothing", async () => {
    const { db, row } = setup({ pdfUrl: PDF_URL });
    const boom = new Error("boom");
    vi.mocked(downloadPdf).mockRejectedValueOnce(boom);
    const result = loadFullText(db, row);
    await expect(result).rejects.toBe(boom);
    await expect(result).rejects.not.toBeInstanceOf(PaperTextError);
    expect(storedText(db, row)).toBeNull();
  });

  it("rejects a PDF with no extractable text with 422 and stores nothing", async () => {
    const { db, row } = setup({ pdfUrl: PDF_URL });
    stubFetch(async () => new Response(makePdf(["", ""])));
    await expect(loadFullText(db, row)).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/No text found/),
    });
    expect(storedText(db, row)).toBeNull();
  });

  it("rejects an unparseable PDF with 422", async () => {
    const { db, row } = setup({ pdfUrl: PDF_URL });
    stubFetch(async () => new Response("%PDF-1.4 garbage"));
    await expect(loadFullText(db, row)).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/Could not read/),
    });
    await expect(loadFullText(db, row)).rejects.toBeInstanceOf(PaperTextError);
  });
});
