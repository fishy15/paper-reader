export class ApiError extends Error {}

/** Matches by name: a `DOMException` isn't always an `Error` instance, so `instanceof` is unreliable. */
export function isAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "AbortError";
}
