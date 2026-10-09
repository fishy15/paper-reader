import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const papers = sqliteTable(
  "papers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    authors: text("authors", { mode: "json" }).$type<string[]>().notNull(),
    year: integer("year"),
    abstract: text("abstract"),
    url: text("url"),
    pdfUrl: text("pdf_url"),
    externalId: text("external_id").unique(),
    source: text("source", { enum: ["search", "upload"] }).notNull(),
    localPdfPath: text("local_pdf_path"),
    fullText: text("full_text"),
    summary: text("summary"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (t) => [
    check(
      "source_external_id",
      sql`(${t.source} = 'search') = (${t.externalId} IS NOT NULL)`,
    ),
  ],
);

export const qaMessages = sqliteTable(
  "qa_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    paperId: integer("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (t) => [index("qa_messages_paper_id_idx").on(t.paperId)],
);

export type PaperRow = typeof papers.$inferSelect;
