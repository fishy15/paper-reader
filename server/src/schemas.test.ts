import { describe, expect, it } from "vitest";
import { Paper, PaperMetadata, QaInput, QaStreamEvent, SavePaperInput } from "@paper-reader/shared";

const metadata = { title: "T", authors: ["A"], year: 2020, abstract: null, url: null };
const search = { ...metadata, externalId: "e1", pdfUrl: null };

describe("shared schemas", () => {
  it("PaperMetadata accepts null year/abstract/url and rejects an empty title", () => {
    expect(PaperMetadata.safeParse(metadata).success).toBe(true);
    expect(PaperMetadata.safeParse({ ...metadata, title: "" }).success).toBe(false);
  });

  it("PaperMetadata enforces integer years, URL format and size caps", () => {
    expect(PaperMetadata.safeParse({ ...metadata, year: 2020.5 }).success).toBe(false);
    expect(PaperMetadata.safeParse({ ...metadata, url: "not a url" }).success).toBe(false);
    expect(PaperMetadata.safeParse({ ...metadata, title: "x".repeat(2001) }).success).toBe(false);
    expect(PaperMetadata.safeParse({ ...metadata, authors: Array(1001).fill("a") }).success).toBe(false);
  });

  it("SavePaperInput requires a non-empty externalId", () => {
    expect(SavePaperInput.safeParse(search).success).toBe(true);
    expect(SavePaperInput.safeParse({ ...search, externalId: "" }).success).toBe(false);
    expect(SavePaperInput.safeParse(metadata).success).toBe(false);
  });

  it("Paper discriminates on source and requires externalId only for search", () => {
    const base = { ...metadata, id: 1, pdfUrl: null, hasPdf: false, summary: null, createdAt: "2026-01-01T00:00:00Z" };
    expect(Paper.safeParse({ ...base, source: "upload" }).success).toBe(true);
    expect(Paper.safeParse({ ...base, source: "search", externalId: "e" }).success).toBe(true);
    expect(Paper.safeParse({ ...base, source: "search" }).success).toBe(false);
    expect(Paper.safeParse({ ...base, source: "other" }).success).toBe(false);
  });

  it("QaInput trims the question and bounds its length", () => {
    expect(QaInput.parse({ question: "  hi  " })).toEqual({ question: "hi" });
    expect(QaInput.safeParse({ question: "   " }).success).toBe(false);
    expect(QaInput.safeParse({ question: "x".repeat(4000) }).success).toBe(true);
    expect(QaInput.safeParse({ question: "x".repeat(4001) }).success).toBe(false);
  });

  it("QaStreamEvent accepts the three event shapes only", () => {
    expect(QaStreamEvent.safeParse({ type: "delta", text: "a" }).success).toBe(true);
    expect(QaStreamEvent.safeParse({ type: "error", message: "m" }).success).toBe(true);
    expect(QaStreamEvent.safeParse({ type: "done" }).success).toBe(true);
    expect(QaStreamEvent.safeParse({ type: "delta" }).success).toBe(false);
    expect(QaStreamEvent.safeParse({ type: "nope" }).success).toBe(false);
  });
});
