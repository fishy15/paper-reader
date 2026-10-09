/** SQLite's `datetime('now')` is UTC without a marker ("2026-10-08 12:00:00"); make that explicit as ISO 8601. */
export function toIsoUtc(sqliteTimestamp: string): string {
  return `${sqliteTimestamp.replace(" ", "T")}Z`;
}
