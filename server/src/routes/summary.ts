import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../db/client.js";
import { papers } from "../db/schema.js";
import { LlmRateLimitError, type Llm } from "../services/llm.js";
import { limitPaperText, loadFullText, PaperTextError } from "../services/paperText.js";
import { IdParam, toPaper } from "./papers.js";

export interface SummaryDeps {
  db: Db;
  llm: Llm;
}

export function summaryRoutes({ db, llm }: SummaryDeps) {
  return new Hono().post("/:id/summarize", zValidator("param", IdParam), async (c) => {
    const { id } = c.req.valid("param");
    const row = db.select().from(papers).where(eq(papers.id, id)).get();
    if (!row) return c.json({ error: "Paper not found" }, 404);

    let text: string;
    try {
      text = limitPaperText(await loadFullText(db, row));
    } catch (err) {
      if (err instanceof PaperTextError) return c.json({ error: err.message }, err.status);
      throw err;
    }

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
