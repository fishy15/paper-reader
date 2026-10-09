import fs from "node:fs/promises";
import path from "node:path";
import { desc, eq, getTableColumns } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { SavePaperInput, type Paper } from "@paper-reader/shared";
import type { Db } from "../db/client.js";
import { papers, type PaperRow } from "../db/schema.js";
import { toIsoUtc } from "../db/time.js";
import { validate } from "../validate.js";

// The extracted text can be hundreds of KB per paper and is never sent to the client.
const { fullText: _fullText, ...paperColumns } = getTableColumns(papers);

export function toPaper(row: Omit<PaperRow, "fullText">): Paper {
  const base = {
    id: row.id,
    title: row.title,
    authors: row.authors,
    year: row.year,
    abstract: row.abstract,
    url: row.url,
    pdfUrl: row.pdfUrl,
    hasPdf: row.localPdfPath !== null,
    summary: row.summary,
    createdAt: toIsoUtc(row.createdAt),
  };
  if (row.source === "upload") return { ...base, source: "upload" };
  if (row.externalId === null) throw new Error(`Search paper ${row.id} has no externalId`);
  return { ...base, source: "search", externalId: row.externalId };
}

export const IdParam = z.object({ id: z.coerce.number().int().positive() });

export function papersRoutes(db: Db, dataDir: string) {
  return new Hono()
    .get("/", (c) => {
      const rows = db.select(paperColumns).from(papers).orderBy(desc(papers.id)).all();
      return c.json(rows.map(toPaper));
    })
    .post("/from-search", validate("json", SavePaperInput), (c) => {
      const input = c.req.valid("json");
      const existing = db
        .select()
        .from(papers)
        .where(eq(papers.externalId, input.externalId))
        .get();
      if (existing) return c.json(toPaper(existing), 200);
      const row = db
        .insert(papers)
        .values({
          title: input.title,
          authors: input.authors,
          year: input.year,
          abstract: input.abstract,
          url: input.url,
          pdfUrl: input.pdfUrl,
          externalId: input.externalId,
          source: "search",
        })
        .returning()
        .get();
      return c.json(toPaper(row), 201);
    })
    .get("/:id", validate("param", IdParam), (c) => {
      const { id } = c.req.valid("param");
      const row = db.select().from(papers).where(eq(papers.id, id)).get();
      if (!row) return c.json({ error: "Paper not found" }, 404);
      return c.json(toPaper(row), 200);
    })
    .delete("/:id", validate("param", IdParam), async (c) => {
      const { id } = c.req.valid("param");
      const deleted = db.delete(papers).where(eq(papers.id, id)).returning().get();
      if (!deleted) return c.json({ error: "Paper not found" }, 404);
      if (deleted.localPdfPath) await fs.rm(path.join(dataDir, deleted.localPdfPath), { force: true });
      return c.json({ ok: true as const }, 200);
    });
}
