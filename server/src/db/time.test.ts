import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, IN_MEMORY_DB, type Db } from "./client.js";
import { papers, qaMessages } from "./schema.js";
import { toIsoUtc } from "./time.js";

/** Inserts a row without `createdAt` so SQLite's column default fills it in, and reads that value back. */
function defaultCreatedAt(db: Db, table: "papers" | "qa_messages"): string {
  const [paper] = db.insert(papers).values({ title: "T", authors: [], source: "upload" }).returning().all();
  if (table === "papers") return paper!.createdAt;
  const [message] = db
    .insert(qaMessages)
    .values({ paperId: paper!.id, role: "user", content: "hi" })
    .returning()
    .all();
  return message!.createdAt;
}

describe("toIsoUtc", () => {
  it("converts a SQLite timestamp to ISO 8601 UTC", () => {
    expect(toIsoUtc("2026-10-08 12:00:00")).toBe("2026-10-08T12:00:00Z");
  });

  it("produces something Date parses as that UTC instant", () => {
    expect(new Date(toIsoUtc("2026-10-08 12:00:00")).toISOString()).toBe("2026-10-08T12:00:00.000Z");
  });

  it.each(["papers", "qa_messages"] as const)("converts the real %s.created_at default to the current instant", (table) => {
    const db = createDb(IN_MEMORY_DB);
    const iso = toIsoUtc(defaultCreatedAt(db, table));
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Math.abs(Date.parse(iso) - Date.now())).toBeLessThan(5000);
  });

  // Planned change (see "Timestamps" in ISSUES.md): fails until created_at is checked when read.
  it("fails when a corrupt created_at is read from the database", () => {
    const db = createDb(IN_MEMORY_DB);
    db.$client
      .prepare("INSERT INTO papers (title, authors, source, created_at) VALUES ('T', '[]', 'upload', '2026-10-08T12:00:00Z')")
      .run();
    expect(() => db.select().from(papers).where(eq(papers.title, "T")).all()).toThrow();
  });
});
