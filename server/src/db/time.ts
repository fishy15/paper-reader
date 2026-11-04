declare const sqliteTimestampBrand: unique symbol;

/** A string in SQLite's `datetime('now')` format: `YYYY-MM-DD HH:MM:SS`, UTC, no marker. */
export type SqliteTimestamp = string & { readonly [sqliteTimestampBrand]: true };

const SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** The only place the format is asserted. Throws on anything that isn't `YYYY-MM-DD HH:MM:SS`. */
export function parseSqliteTimestamp(value: string): SqliteTimestamp {
  if (!SQLITE_TIMESTAMP.test(value)) {
    throw new Error(`Invalid SQLite timestamp: ${JSON.stringify(value)}`);
  }
  return value as SqliteTimestamp;
}

/** SQLite's `datetime('now')` is UTC without a marker ("2026-10-08 12:00:00"); make that explicit as ISO 8601. */
export function toIsoUtc(sqliteTimestamp: SqliteTimestamp): string {
  return `${sqliteTimestamp.replace(" ", "T")}Z`;
}
