import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../drizzle");

/** SQLite's special filename for a private, non-persistent database. */
export const IN_MEMORY_DB = ":memory:";

/** Opens (and migrates) a SQLite database. Pass IN_MEMORY_DB for tests. */
export function createDb(file: string): Db {
  if (file !== IN_MEMORY_DB) fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}
