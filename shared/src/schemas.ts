import { z } from "zod";

export const PaperMetadata = z.object({
  title: z.string().min(1),
  authors: z.array(z.string()),
  year: z.number().int().nullable(),
  abstract: z.string().nullable(),
  url: z.string().url().nullable(),
});
export type PaperMetadata = z.infer<typeof PaperMetadata>;

export const SearchResult = PaperMetadata.extend({
  externalId: z.string(),
  pdfUrl: z.string().url().nullable(),
});
export type SearchResult = z.infer<typeof SearchResult>;

const PaperBase = PaperMetadata.extend({
  id: z.number().int(),
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

export const QaInput = z.object({ question: z.string().min(1).max(4000) });
export type QaInput = z.infer<typeof QaInput>;
