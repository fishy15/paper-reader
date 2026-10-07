import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../db/client.js";
import { papers } from "../db/schema.js";
import { LlmRateLimitError, type Llm } from "../services/llm.js";
import { extractPages } from "../services/pdf.js";
import { downloadPdf, PdfDownloadError } from "../services/pdfDownload.js";
import { IdParam, toPaper } from "./papers.js";

/** About 100k tokens: well inside Gemini's context window, but bounded so one request can't be huge. */
export const MAX_SUMMARY_CHARS = 400_000;

export interface SummaryDeps {
  db: Db;
  llm: Llm;
}

export function summaryRoutes({ db, llm }: SummaryDeps) {
  return new Hono().post("/:id/summarize", zValidator("param", IdParam), async (c) => {
    const { id } = c.req.valid("param");
    const row = db.select().from(papers).where(eq(papers.id, id)).get();
    if (!row) return c.json({ error: "Paper not found" }, 404);

    let fullText = row.fullText;
    if (!fullText) {
      // Papers saved from search have no text yet: fetch it from the PDF link once and keep it.
      if (!row.pdfUrl) {
        return c.json({ error: "This paper has no PDF link. Upload its PDF to summarize it." }, 422);
      }
      let bytes: Uint8Array;
      try {
        bytes = await downloadPdf(row.pdfUrl);
      } catch (err) {
        if (err instanceof PdfDownloadError) return c.json({ error: err.message }, 502);
        throw err;
      }
      let pages: string[];
      try {
        pages = await extractPages(bytes);
      } catch {
        return c.json({ error: "Could not read the downloaded PDF (it may be corrupted or encrypted)" }, 422);
      }
      fullText = pages.join("\n\n").trim();
      if (!fullText) {
        return c.json({ error: "No text found in the downloaded PDF (scanned PDFs are not supported)" }, 422);
      }
      db.update(papers).set({ fullText }).where(eq(papers.id, id)).run();
    }

    const text =
      fullText.length > MAX_SUMMARY_CHARS ? `${fullText.slice(0, MAX_SUMMARY_CHARS)}\n\n[Text truncated]` : fullText;
    let summary: string;
    try {
      summary = await llm.summarize({ title: row.title, text });
    } catch (err) {
      if (err instanceof LlmRateLimitError) return c.json({ error: err.message }, 429);
      throw err;
    }

    const updated = db.update(papers).set({ summary }).where(eq(papers.id, id)).returning().get();
    return c.json(toPaper(updated), 200);
  });
}
