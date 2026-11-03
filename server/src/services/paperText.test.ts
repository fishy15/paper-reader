import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createDb, IN_MEMORY_DB } from "../db/client.js";
import { papers, type PaperRow } from "../db/schema.js";
import { makePdf } from "../test-utils.js";
import { limitPaperText, loadFullText, MAX_PAPER_CHARS, PaperTextError } from "./paperText.js";

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
  return () => vi.unstubAllGlobals();
}

describe("limitPaperText", () => {
  it("leaves text at or under the limit alone", () => {
    const text = "x".repeat(MAX_PAPER_CHARS);
    expect(limitPaperText(text)).toBe(text);
    expect(limitPaperText("")).toBe("");
  });

  it("truncates longer text and marks the cut", () => {
    const out = limitPaperText("x".repeat(MAX_PAPER_CHARS + 1));
    expect(out.startsWith("x".repeat(MAX_PAPER_CHARS))).toBe(true);
    expect(out.endsWith("[Text truncated]")).toBe(true);
    expect(out.length).toBeLessThan(MAX_PAPER_CHARS + 50);
  });
});

describe("loadFullText", () => {
  it("returns stored text without any download", async () => {
    const { db, row } = setup({ fullText: "stored", pdfUrl: "https://example.org/a.pdf" });
    const cleanup = stubFetch(() => Promise.reject(new Error("should not fetch")));
    try {
      expect(await loadFullText(db, row)).toBe("stored");
    } finally {
      cleanup();
    }
  });

  it("rejects with 422 when there is no text and no PDF link", async () => {
    const { db, row } = setup();
    const err = await loadFullText(db, row).catch((e) => e);
    expect(err).toBeInstanceOf(PaperTextError);
    expect(err.status).toBe(422);
  });

  it("downloads, extracts, joins pages and stores the text", async () => {
    const { db, row } = setup({ pdfUrl: "https://example.org/a.pdf" });
    const cleanup = stubFetch(async () => new Response(makePdf(["page one", "page two"])));
    try {
      expect(await loadFullText(db, row)).toBe("page one\n\npage two");
    } finally {
      cleanup();
    }
    const stored = db.select().from(papers).where(eq(papers.id, row.id)).get();
    expect(stored?.fullText).toBe("page one\n\npage two");
  });

  it("maps download failures to 502", async () => {
    const { db, row } = setup({ pdfUrl: "https://example.org/a.pdf" });
    const cleanup = stubFetch(async () => new Response("no", { status: 500 }));
    try {
      const err = await loadFullText(db, row).catch((e) => e);
      expect(err).toBeInstanceOf(PaperTextError);
      expect(err.status).toBe(502);
    } finally {
      cleanup();
    }
  });

  it("rejects a PDF with no extractable text with 422 and stores nothing", async () => {
    const { db, row } = setup({ pdfUrl: "https://example.org/a.pdf" });
    const cleanup = stubFetch(async () => new Response(makePdf(["", ""])));
    try {
      const err = await loadFullText(db, row).catch((e) => e);
      expect(err).toBeInstanceOf(PaperTextError);
      expect(err.status).toBe(422);
      expect(err.message).toMatch(/No text found/);
    } finally {
      cleanup();
    }
    expect(db.select().from(papers).where(eq(papers.id, row.id)).get()?.fullText).toBeNull();
  });

  it("rejects an unparseable PDF with 422", async () => {
    const { db, row } = setup({ pdfUrl: "https://example.org/a.pdf" });
    const cleanup = stubFetch(async () => new Response("%PDF-1.4 garbage"));
    try {
      const err = await loadFullText(db, row).catch((e) => e);
      expect(err).toBeInstanceOf(PaperTextError);
      expect(err.status).toBe(422);
    } finally {
      cleanup();
    }
  });
});
