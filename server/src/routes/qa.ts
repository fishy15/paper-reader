import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { QaInput, type QaStreamEvent } from "@paper-reader/shared";
import type { Db } from "../db/client.js";
import { papers, qaMessages } from "../db/schema.js";
import { toIsoUtc } from "../db/time.js";
import { LlmRateLimitError, type Llm } from "../services/llm.js";
import { limitPaperText, loadFullText, PaperTextError } from "../services/paperText.js";
import { IdParam } from "./papers.js";
import { validate } from "../validate.js";

/** How many earlier messages (questions and answers) are sent along with a new question. */
export const HISTORY_MESSAGES = 20;

export interface QaDeps {
  db: Db;
  llm: Llm;
}

export function qaRoutes({ db, llm }: QaDeps) {
  return new Hono()
    .get("/:id/messages", validate("param", IdParam), (c) => {
      const { id } = c.req.valid("param");
      if (!db.select({ id: papers.id }).from(papers).where(eq(papers.id, id)).get()) {
        return c.json({ error: "Paper not found" }, 404);
      }
      const rows = db.select().from(qaMessages).where(eq(qaMessages.paperId, id)).orderBy(qaMessages.id).all();
      return c.json(rows.map((m) => ({ ...m, createdAt: toIsoUtc(m.createdAt) })), 200);
    })
    .post("/:id/ask", validate("param", IdParam), validate("json", QaInput), async (c) => {
      const { id } = c.req.valid("param");
      const { question } = c.req.valid("json");
      const row = db.select().from(papers).where(eq(papers.id, id)).get();
      if (!row) return c.json({ error: "Paper not found" }, 404);

      let text: string;
      try {
        text = limitPaperText(await loadFullText(db, row));
      } catch (err) {
        if (err instanceof PaperTextError) return c.json({ error: err.message }, err.status);
        throw err;
      }

      const history = db
        .select({ role: qaMessages.role, content: qaMessages.content })
        .from(qaMessages)
        .where(eq(qaMessages.paperId, id))
        .orderBy(desc(qaMessages.id))
        .limit(HISTORY_MESSAGES)
        .all()
        .reverse();

      const answer = llm.answer({ title: row.title, text, history, question });
      // Wait for the first chunk before replying, so failures that happen up front (missing key,
      // rate limit) get a real status code instead of an error inside a 200 stream.
      let result: IteratorResult<string>;
      try {
        result = await answer.next();
      } catch (err) {
        if (err instanceof LlmRateLimitError) return c.json({ error: err.message }, 429);
        throw err;
      }

      c.header("Content-Type", "application/x-ndjson");
      return stream(c, async (out) => {
        const send = (event: QaStreamEvent) => out.write(`${JSON.stringify(event)}\n`);
        let reply = "";
        try {
          while (!result.done) {
            if (out.aborted) {
              await answer.return(undefined);
              return;
            }
            reply += result.value;
            await send({ type: "delta", text: result.value });
            result = await answer.next();
          }
        } catch (err) {
          console.error(err);
          await send({ type: "error", message: err instanceof Error ? err.message : String(err) });
          return;
        }

        // Saved together and only after a complete answer, so history never has a dangling question.
        db.insert(qaMessages)
          .values([
            { paperId: id, role: "user", content: question },
            { paperId: id, role: "assistant", content: reply },
          ])
          .run();
        await send({ type: "done" });
      });
    });
}
