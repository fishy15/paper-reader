import { describe, expect, it, onTestFinished, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, IN_MEMORY_DB, type Db } from "./client.js";
import { papers, qaMessages } from "./schema.js";
import { parseSqliteTimestamp, toIsoUtc, type SqliteTimestamp } from "./time.js";

/** Inserts a row without `createdAt` so SQLite's column default fills it in, and reads that value back. */
function defaultCreatedAt(db: Db, table: "papers" | "qa_messages"): SqliteTimestamp {
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
    expect(toIsoUtc(parseSqliteTimestamp("2026-10-08 12:00:00"))).toBe("2026-10-08T12:00:00Z");
  });

  it("produces something Date parses as that UTC instant", () => {
    expect(new Date(toIsoUtc(parseSqliteTimestamp("2026-10-08 12:00:00"))).toISOString()).toBe("2026-10-08T12:00:00.000Z");
  });

  it.each(["papers", "qa_messages"] as const)("converts the real %s.created_at default to the current instant", (table) => {
    // A column default of datetime('now', 'localtime') is only off by the machine's UTC offset, so pin a
    // non-UTC zone; on a UTC machine that mistake would otherwise pass the closeness check below.
    vi.stubEnv("TZ", "Asia/Tokyo");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
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

  describe("parseSqliteTimestamp", () => {
    it("accepts a SQLite timestamp and returns it unchanged", () => {
      expect(parseSqliteTimestamp("2026-10-08 12:00:00")).toBe("2026-10-08 12:00:00");
    });

    it.each(["2026-10-08T12:00:00Z", "", "not a date", "2026-10-08"])("throws for %j", (value) => {
      expect(() => parseSqliteTimestamp(value)).toThrow();
    });
  });

  // Checked by `npm run typecheck`; vitest does not type-check.
  it("rejects plain strings at compile time", () => {
    const plain: string = "2026-10-08 12:00:00";
    const db = createDb(IN_MEMORY_DB);
    const ok = parseSqliteTimestamp("2026-10-08 12:00:00");
    const run = (fn: () => void) => {
      try {
        fn();
      } catch {
        // only the compile-time result matters here
      }
    };
    run(() => {
      // @ts-expect-error a plain string is not a SqliteTimestamp
      toIsoUtc(plain);
      // @ts-expect-error a string literal is not a SqliteTimestamp
      toIsoUtc("2026-10-08 12:00:00");
      // @ts-expect-error created_at takes a SqliteTimestamp, not a plain string
      db.insert(qaMessages).values({ paperId: 1, role: "user", content: "x", createdAt: plain });
    });
    expect(toIsoUtc(ok)).toBe("2026-10-08T12:00:00Z");
    const [row] = db.insert(papers).values({ title: "T", authors: [], source: "upload" }).returning().all();
    expect(toIsoUtc(row!.createdAt)).toMatch(/Z$/);
    db.insert(qaMessages).values({ paperId: row!.id, role: "user", content: "x", createdAt: ok });
  });
});
