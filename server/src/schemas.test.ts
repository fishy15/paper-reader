import { describe, expect, it } from "vitest";
import { Paper, PaperMetadata, QaInput, QaStreamEvent, SavePaperInput, SearchResult } from "@paper-reader/shared";

const metadata = { title: "T", authors: ["A"], year: 2020, abstract: null, url: null };
const search = { ...metadata, externalId: "e1", pdfUrl: null };

/** The paths of every issue a failed parse reported, e.g. `["externalId", "pdfUrl"]`. */
function failedPaths(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }): string[] {
  expect(result.success).toBe(false);
  return (result.error?.issues ?? []).map((i) => i.path.join("."));
}

const url = (length: number) => `https://example.com/${"a".repeat(length - "https://example.com/".length)}`;

describe("shared schemas", () => {
  it("PaperMetadata accepts null year/abstract/url and rejects an empty title", () => {
    expect(PaperMetadata.safeParse(metadata).success).toBe(true);
    expect(failedPaths(PaperMetadata.safeParse({ ...metadata, title: "" }))).toEqual(["title"]);
  });

  it("PaperMetadata rejects a fractional year and a malformed url", () => {
    expect(failedPaths(PaperMetadata.safeParse({ ...metadata, year: 2020.5 }))).toEqual(["year"]);
    expect(failedPaths(PaperMetadata.safeParse({ ...metadata, url: "not a url" }))).toEqual(["url"]);
  });

  // [field, value accepted at the limit, value rejected one over]
  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ["title", { title: "x".repeat(2000) }, { title: "x".repeat(2001) }],
    ["authors.0", { authors: ["x".repeat(500)] }, { authors: ["x".repeat(501)] }],
    ["authors", { authors: Array(1000).fill("a") }, { authors: Array(1001).fill("a") }],
    ["abstract", { abstract: "x".repeat(50_000) }, { abstract: "x".repeat(50_001) }],
    ["url", { url: url(2048) }, { url: url(2049) }],
    ["pdfUrl", { pdfUrl: url(2048) }, { pdfUrl: url(2049) }],
    ["externalId", { externalId: "x".repeat(200) }, { externalId: "x".repeat(201) }],
  ])("SearchResult accepts %s at its limit and rejects one over", (field, atLimit, overLimit) => {
    expect(SearchResult.safeParse({ ...search, ...atLimit }).success).toBe(true);
    expect(failedPaths(SearchResult.safeParse({ ...search, ...overLimit }))).toEqual([field]);
  });

  it("SearchResult rejects a pdfUrl that is not a url", () => {
    expect(failedPaths(SearchResult.safeParse({ ...search, pdfUrl: "not a url" }))).toEqual(["pdfUrl"]);
  });

  it.each(["abstract", "year", "url"])("PaperMetadata requires %s to be sent, even as null", (field) => {
    const without = Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== field));
    expect(failedPaths(PaperMetadata.safeParse(without))).toEqual([field]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["a string year", { year: "2020" }, "year"],
    ["authors as a string", { authors: "A" }, "authors"],
    ["a non-string author", { authors: [1] }, "authors.0"],
  ])("PaperMetadata rejects %s", (_name, override, path) => {
    expect(failedPaths(PaperMetadata.safeParse({ ...metadata, ...override }))).toEqual([path]);
  });

  it("SavePaperInput requires a non-empty externalId", () => {
    expect(SavePaperInput.safeParse(search).success).toBe(true);
    expect(failedPaths(SavePaperInput.safeParse({ ...search, externalId: "" }))).toEqual(["externalId"]);
    expect(failedPaths(SavePaperInput.safeParse(metadata))).toEqual(["externalId", "pdfUrl"]);
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
    expect(failedPaths(QaInput.safeParse({ question: "   " }))).toEqual(["question"]);
    expect(QaInput.safeParse({ question: "x".repeat(4000) }).success).toBe(true);
    expect(failedPaths(QaInput.safeParse({ question: "x".repeat(4001) }))).toEqual(["question"]);
  });

  it("QaInput trims before checking the length and keeps inner newlines", () => {
    const padded = ` ${"x".repeat(4000)}\n\t `;
    expect(QaInput.parse({ question: padded }).question).toBe("x".repeat(4000));
    expect(failedPaths(QaInput.safeParse({ question: "\n\t " }))).toEqual(["question"]);
    expect(QaInput.parse({ question: "a\nb\n" })).toEqual({ question: "a\nb" });
  });

  it("QaStreamEvent accepts the three event shapes only", () => {
    expect(QaStreamEvent.safeParse({ type: "delta", text: "a" }).success).toBe(true);
    expect(QaStreamEvent.safeParse({ type: "error", message: "m" }).success).toBe(true);
    expect(QaStreamEvent.safeParse({ type: "done" }).success).toBe(true);
    expect(failedPaths(QaStreamEvent.safeParse({ type: "delta" }))).toEqual(["text"]);
    expect(failedPaths(QaStreamEvent.safeParse({ type: "nope" }))).toEqual(["type"]);
  });

  it("QaStreamEvent accepts an empty text and rejects malformed events", () => {
    expect(QaStreamEvent.safeParse({ type: "delta", text: "" }).success).toBe(true);
    expect(failedPaths(QaStreamEvent.safeParse({ type: "error" }))).toEqual(["message"]);
    expect(failedPaths(QaStreamEvent.safeParse({ type: "delta", text: 5 }))).toEqual(["text"]);
    expect(failedPaths(QaStreamEvent.safeParse({ text: "a" }))).toEqual(["type"]);
  });
});
