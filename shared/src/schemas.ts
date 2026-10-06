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

export const PaperSource = z.enum(["search", "upload"]);
export type PaperSource = z.infer<typeof PaperSource>;

export const Paper = PaperMetadata.extend({
  id: z.number().int(),
  externalId: z.string().nullable(),
  source: PaperSource,
  hasPdf: z.boolean(),
  summary: z.string().nullable(),
  createdAt: z.string(),
});
export type Paper = z.infer<typeof Paper>;

export const SavePaperInput = SearchResult;
export type SavePaperInput = z.infer<typeof SavePaperInput>;

export const ChatMessage = z.object({
  id: z.number().int(),
  paperId: z.number().int(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ChatInput = z.object({ question: z.string().min(1).max(4000) });
export type ChatInput = z.infer<typeof ChatInput>;
