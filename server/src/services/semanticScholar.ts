import { z } from "zod";
import type { SearchResult } from "@paper-reader/shared";

export interface PaperSearchProvider {
  search(query: string, limit: number): Promise<SearchResult[]>;
}

/** The upstream search service failed; `status` is what we report to our client. */
export class SearchProviderError extends Error {
  constructor(
    message: string,
    readonly status: 429 | 502,
  ) {
    super(message);
  }
}

// Semantic Scholar omits or nulls most fields depending on the paper, so the raw
// schema is lenient and `toSearchResult` normalizes into our strict shape.
const S2Paper = z.object({
  paperId: z.string(),
  title: z.string().nullish(),
  abstract: z.string().nullish(),
  year: z.number().int().nullish(),
  url: z.string().nullish(),
  authors: z.array(z.object({ name: z.string().nullish() })).default([]),
  openAccessPdf: z.object({ url: z.string().nullish() }).nullish(),
  // Other id values (e.g. CorpusId) are numbers; only the arXiv id is used.
  externalIds: z.object({ ArXiv: z.string().nullish() }).nullish(),
});
const S2Response = z.object({ data: z.array(S2Paper).default([]) });

const FIELDS = "title,authors,year,abstract,url,openAccessPdf,externalIds";
const BASE_URL = "https://api.semanticscholar.org/graph/v1/paper/search";

function validUrl(raw: string | null | undefined): string | null {
  return raw && URL.canParse(raw) ? raw : null;
}

/** S2 often has no `openAccessPdf` for papers that are on arXiv, whose PDF URLs are predictable. */
function pdfUrlFor(paper: z.infer<typeof S2Paper>): string | null {
  const openAccess = validUrl(paper.openAccessPdf?.url);
  if (openAccess) return openAccess;
  const arxivId = paper.externalIds?.ArXiv?.trim();
  return arxivId ? validUrl(`https://arxiv.org/pdf/${arxivId}`) : null;
}

function toSearchResult(paper: z.infer<typeof S2Paper>): SearchResult | null {
  const title = paper.title?.trim();
  if (!title) return null;
  return {
    externalId: paper.paperId,
    title,
    authors: paper.authors.flatMap((a) => (a.name ? [a.name] : [])),
    year: paper.year ?? null,
    abstract: paper.abstract?.trim() || null,
    url: validUrl(paper.url),
    pdfUrl: pdfUrlFor(paper),
  };
}

export interface SemanticScholarOptions {
  apiKey?: string | undefined;
  fetchFn?: typeof fetch;
  retryDelayMs?: number;
  /** Gives up on a request (including reading its body) after this long. */
  timeoutMs?: number;
}

export function createSemanticScholarProvider(
  options: SemanticScholarOptions = {},
): PaperSearchProvider {
  const { apiKey, fetchFn = fetch, retryDelayMs = 1500, timeoutMs = 15_000 } = options;

  async function request(url: string): Promise<Response> {
    const headers: Record<string, string> = apiKey ? { "x-api-key": apiKey } : {};
    try {
      return await fetchFn(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new SearchProviderError("Could not reach Semantic Scholar", 502);
    }
  }

  return {
    async search(query, limit) {
      const params = new URLSearchParams({ query, limit: String(limit), fields: FIELDS });
      const url = `${BASE_URL}?${params}`;

      let res = await request(url);
      if (res.status === 429) {
        // The shared unauthenticated pool is easily exhausted; retry once.
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        res = await request(url);
      }
      if (res.status === 429) {
        throw new SearchProviderError("Semantic Scholar rate limit reached, try again shortly", 429);
      }
      if (!res.ok) {
        throw new SearchProviderError(`Semantic Scholar returned ${res.status}`, 502);
      }

      const parsed = S2Response.safeParse(await res.json());
      if (!parsed.success) {
        throw new SearchProviderError("Unexpected response from Semantic Scholar", 502);
      }
      return parsed.data.data.flatMap((p) => toSearchResult(p) ?? []);
    },
  };
}
