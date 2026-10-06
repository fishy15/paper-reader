import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { SavePaperInput, type Paper } from "@paper-reader/shared";
import type { Db } from "../db/client.js";
import { papers, type PaperRow } from "../db/schema.js";

export function toPaper(row: PaperRow): Paper {
  return {
    id: row.id,
    title: row.title,
    authors: row.authors,
    year: row.year,
    abstract: row.abstract,
    url: row.url,
    externalId: row.externalId,
    source: row.source,
    hasPdf: row.pdfPath !== null,
    summary: row.summary,
    createdAt: row.createdAt,
  };
}

const IdParam = z.object({ id: z.coerce.number().int().positive() });

export function papersRoutes(db: Db) {
  return new Hono()
    .get("/", (c) => {
      const rows = db.select().from(papers).orderBy(papers.id).all();
      return c.json(rows.map(toPaper));
    })
    .post("/", zValidator("json", SavePaperInput), (c) => {
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
          url: input.url ?? input.pdfUrl,
          externalId: input.externalId,
          source: "search",
        })
        .returning()
        .get();
      return c.json(toPaper(row), 201);
    })
    .get("/:id", zValidator("param", IdParam), (c) => {
      const { id } = c.req.valid("param");
      const row = db.select().from(papers).where(eq(papers.id, id)).get();
      if (!row) return c.json({ error: "Paper not found" }, 404);
      return c.json(toPaper(row), 200);
    })
    .delete("/:id", zValidator("param", IdParam), (c) => {
      const { id } = c.req.valid("param");
      const deleted = db.delete(papers).where(eq(papers.id, id)).returning().get();
      if (!deleted) return c.json({ error: "Paper not found" }, 404);
      return c.json({ ok: true as const }, 200);
    });
}
