import { hc } from "hono/client";
import { z } from "zod";
import type { AppType } from "@paper-reader/server/app";
import type { SearchResult } from "@paper-reader/shared";

const client = hc<AppType>("/");

export class ApiError extends Error {}

const ErrorBody = z.object({ error: z.string() });

async function errorMessage(res: { status: number; json(): Promise<unknown> }): Promise<string> {
  const body = ErrorBody.safeParse(await res.json().catch(() => null));
  return body.success ? body.data.error : `Request failed (${res.status})`;
}

export async function searchPapers(query: string) {
  const res = await client.api.search.$get({ query: { query } });
  if (!res.ok) throw new ApiError(await errorMessage(res));
  return res.json();
}

export async function listPapers() {
  const res = await client.api.papers.$get();
  if (!res.ok) throw new ApiError(await errorMessage(res));
  return res.json();
}

export async function savePaper(result: SearchResult) {
  const res = await client.api.papers["from-search"].$post({ json: result });
  if (!res.ok) throw new ApiError(await errorMessage(res));
  return res.json();
}

export async function deletePaper(id: number) {
  const res = await client.api.papers[":id"].$delete({ param: { id: String(id) } });
  if (!res.ok) throw new ApiError(await errorMessage(res));
}
