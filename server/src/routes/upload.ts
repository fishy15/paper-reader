import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { papers } from "../db/schema.js";
import type { ExtractedMetadata, Llm } from "../services/llm.js";
import { extractPages, isPdf, MAX_PDF_BYTES } from "../services/pdf.js";
import { toPaper } from "./papers.js";

/** Metadata (title, authors, abstract) lives on the first pages; sending more only costs tokens. */
const METADATA_PAGES = 2;
const METADATA_MAX_CHARS = 12_000;

export interface UploadDeps {
  db: Db;
  llm: Llm;
  dataDir: string;
}

/** The LLM reports "not stated" as 0, and may misread digits; keep only plausible years. */
function validYear(year: number): number | null {
  const max = new Date().getFullYear() + 1;
  return Number.isInteger(year) && year >= 1000 && year <= max ? year : null;
}

function cleanMetadata(meta: ExtractedMetadata, filename: string) {
  return {
    title: meta.title.trim() || filename.replace(/\.pdf$/i, "") || "Untitled",
    authors: meta.authors.map((a) => a.trim()).filter(Boolean),
    year: validYear(meta.year),
    abstract: meta.abstract.trim() || null,
  };
}

export function uploadRoutes({ db, llm, dataDir }: UploadDeps) {
  return new Hono().post(
    "/upload",
    bodyLimit({
      maxSize: MAX_PDF_BYTES,
      onError: (c) => c.json({ error: "PDF is too large (limit 25 MB)" }, 413),
    }),
    zValidator("form", z.object({ file: z.instanceof(File) })),
    async (c) => {
      const { file } = c.req.valid("form");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!isPdf(bytes)) return c.json({ error: "File is not a PDF" }, 415);

      let pages: string[];
      try {
        pages = await extractPages(bytes);
      } catch {
        return c.json({ error: "Could not read this PDF (it may be corrupted or encrypted)" }, 422);
      }
      const fullText = pages.join("\n\n").trim();
      if (!fullText) {
        return c.json({ error: "No text found in this PDF (scanned PDFs are not supported)" }, 422);
      }

      const extracted = await llm.extractMetadata(
        pages.slice(0, METADATA_PAGES).join("\n\n").slice(0, METADATA_MAX_CHARS),
      );
      const metadata = cleanMetadata(extracted, file.name);

      // Paths are stored relative to the data directory so the database stays portable.
      const localPdfPath = path.join("pdfs", `${randomUUID()}.pdf`);
      const absolutePath = path.join(dataDir, localPdfPath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, bytes);
      try {
        const row = db
          .insert(papers)
          .values({ ...metadata, source: "upload", localPdfPath, fullText })
          .returning()
          .get();
        return c.json(toPaper(row), 201);
      } catch (err) {
        await fs.rm(absolutePath, { force: true });
        throw err;
      }
    },
  );
}
