import type { Paper, QaMessage, QaStreamEvent, SearchResult } from "@paper-reader/shared";

export function makePaper(overrides: Partial<Paper> = {}): Paper {
  return {
    id: 1,
    title: "A Paper",
    authors: ["Ada Lovelace"],
    year: 2020,
    abstract: "An abstract.",
    url: null,
    pdfUrl: null,
    hasPdf: true,
    summary: null,
    createdAt: "2026-01-01T00:00:00Z",
    source: "upload",
    ...overrides,
  } as Paper;
}

export function makeSearchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: "Found Paper",
    authors: ["Grace Hopper"],
    year: 2019,
    abstract: "Found abstract.",
    url: null,
    pdfUrl: null,
    externalId: "s2-1",
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<QaMessage> = {}): QaMessage {
  return { id: 1, paperId: 1, role: "user", content: "hi", createdAt: "2026-01-01T00:00:00Z", ...overrides };
}

/** A newline-delimited JSON body in the format the ask endpoint streams. */
export function ndjson(events: QaStreamEvent[]): string {
  return events.map((e) => `${JSON.stringify(e)}\n`).join("");
}
