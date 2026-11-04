import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { papers, type PaperRow } from "../db/schema.js";
import { extractPages } from "./pdf.js";
import { downloadPdf, PdfDownloadError } from "./pdfDownload.js";

/** About 100k tokens: well inside Gemini's context window, but bounded so one request can't be huge. */
export const MAX_PAPER_CHARS = 400_000;

/** The paper's text could not be obtained; the message is safe to show the user. */
export class PaperTextError extends Error {
  constructor(
    message: string,
    readonly status: 422 | 502,
  ) {
    super(message);
  }
}

/**
 * Returns the paper's full text. Papers saved from search have none yet, so it is fetched from
 * their PDF link once and stored.
 */
export async function loadFullText(db: Db, row: PaperRow): Promise<string> {
  if (row.fullText) return row.fullText;
  if (!row.pdfUrl) throw new PaperTextError("This paper has no PDF link. Upload its PDF to use it.", 422);

  let bytes: Uint8Array;
  try {
    bytes = await downloadPdf(row.pdfUrl);
  } catch (err) {
    if (err instanceof PdfDownloadError) throw new PaperTextError(err.message, 502);
    throw err;
  }
  let pages: string[];
  try {
    pages = await extractPages(bytes);
  } catch {
    throw new PaperTextError("Could not read the downloaded PDF (it may be corrupted or encrypted)", 422);
  }
  const fullText = pages.join("\n\n").trim();
  if (!fullText) throw new PaperTextError("No text found in the downloaded PDF (scanned PDFs are not supported)", 422);

  db.update(papers).set({ fullText }).where(eq(papers.id, row.id)).run();
  return fullText;
}

/** Cuts text that is too long for one request and marks the cut for the model. */
export function limitPaperText(text: string): string {
  if (text.length <= MAX_PAPER_CHARS) return text;
  let end = MAX_PAPER_CHARS;
  const last = text.charCodeAt(end - 1);
  // Don't leave half of a surrogate pair at the cut.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}\n\n[Text truncated]`;
}
