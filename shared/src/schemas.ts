import { z } from "zod";

// Generous caps: real metadata is far smaller, but a save request should not store unbounded text.
export const PaperMetadata = z.object({
  title: z.string().min(1).max(2000),
  authors: z.array(z.string().max(500)).max(1000),
  year: z.number().int().nullable(),
  abstract: z.string().max(50_000).nullable(),
  url: z.url().max(2048).nullable(),
});
export type PaperMetadata = z.infer<typeof PaperMetadata>;

export const SearchResult = PaperMetadata.extend({
  externalId: z.string().min(1).max(200),
  pdfUrl: z.url().max(2048).nullable(),
});
export type SearchResult = z.infer<typeof SearchResult>;

const PaperBase = PaperMetadata.extend({
  id: z.number().int(),
  pdfUrl: z.url().nullable(),
  hasPdf: z.boolean(),
  summary: z.string().nullable(),
  createdAt: z.string(),
});

/** A saved paper. Only search results carry an external (Semantic Scholar) ID. */
export const Paper = z.discriminatedUnion("source", [
  PaperBase.extend({ source: z.literal("search"), externalId: z.string() }),
  PaperBase.extend({ source: z.literal("upload") }),
]);
export type Paper = z.infer<typeof Paper>;
export type PaperSource = Paper["source"];

export const SavePaperInput = SearchResult;
export type SavePaperInput = z.infer<typeof SavePaperInput>;

export const QaMessage = z.object({
  id: z.number().int(),
  paperId: z.number().int(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string(),
});
export type QaMessage = z.infer<typeof QaMessage>;

export const QaInput = z.object({ question: z.string().trim().min(1).max(4000) });
export type QaInput = z.infer<typeof QaInput>;

/** One line of the newline-delimited JSON stream returned when asking a question. */
export const QaStreamEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("done") }),
]);
export type QaStreamEvent = z.infer<typeof QaStreamEvent>;
