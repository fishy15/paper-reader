import { hc } from "hono/client";
import { z } from "zod";
import type { AppType } from "@paper-reader/server/app";
import type { QaStreamEvent, SearchResult } from "@paper-reader/shared";
import { ApiError, isAbort } from "./apiError.js";
import { readQaEvents } from "./qaStream.js";

export { ApiError };

const client = hc<AppType>("/");

const ErrorBody = z.object({ error: z.string().min(1) });

/** Runs a request, turning a network failure into an `ApiError`. Aborts pass through unchanged. */
async function send<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new ApiError("Could not reach the server");
  }
}

async function errorMessage(res: { status: number; json(): Promise<unknown> }): Promise<string> {
  const body = ErrorBody.safeParse(await res.json().catch(() => null));
  return body.success ? body.data.error : `Request failed (${res.status})`;
}

export async function searchPapers(query: string) {
  const res = await send(client.api.search.$get({ query: { query } }));
  if (!res.ok) throw new ApiError(await errorMessage(res));
  return res.json();
}

export async function listPapers() {
  const res = await send(client.api.papers.$get());
  if (!res.ok) throw new ApiError(await errorMessage(res));
  return res.json();
}

export async function savePaper(result: SearchResult) {
  const res = await send(client.api.papers["from-search"].$post({ json: result }));
  if (!res.ok) throw new ApiError(await errorMessage(res));
  return res.json();
}

export async function uploadPaper(file: File) {
  const res = await send(client.api.papers.upload.$post({ form: { file } }));
  if (!res.ok) throw new ApiError(await errorMessage(res));
  return res.json();
}

export async function deletePaper(id: number) {
  const res = await send(client.api.papers[":id"].$delete({ param: { id: String(id) } }));
  if (!res.ok) throw new ApiError(await errorMessage(res));
}

export async function getPaper(id: number) {
  const res = await send(client.api.papers[":id"].$get({ param: { id: String(id) } }));
  if (!res.ok) throw new ApiError(await errorMessage(res));
  return res.json();
}

export async function summarizePaper(id: number) {
  const res = await send(client.api.papers[":id"].summarize.$post({ param: { id: String(id) } }));
  if (!res.ok) throw new ApiError(await errorMessage(res));
  return res.json();
}

export async function listMessages(paperId: number) {
  const res = await send(client.api.papers[":id"].messages.$get({ param: { id: String(paperId) } }));
  if (!res.ok) throw new ApiError(await errorMessage(res));
  return res.json();
}

/**
 * Asks a question about a paper and yields the answer as it streams in. Failures before the
 * answer starts (no PDF, rate limit, ...) throw an `ApiError`; failures after it starts arrive
 * as an `error` event.
 */
export async function* askQuestion(
  paperId: number,
  question: string,
  signal?: AbortSignal,
): AsyncGenerator<QaStreamEvent> {
  const res = await send(client.api.papers[":id"].ask.$post(
    { param: { id: String(paperId) }, json: { question } },
    signal ? { init: { signal } } : undefined,
  ));
  if (!res.ok) throw new ApiError(await errorMessage(res));
  if (!res.body) throw new ApiError("The server sent an empty response");
  yield* readQaEvents(res.body);
}
