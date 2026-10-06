import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { SearchProviderError, type PaperSearchProvider } from "../services/semanticScholar.js";

const SearchParams = z.object({
  query: z.string().trim().min(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export function searchRoutes(provider: PaperSearchProvider) {
  return new Hono().get("/", zValidator("query", SearchParams), async (c) => {
    const { query, limit } = c.req.valid("query");
    try {
      return c.json(await provider.search(query, limit), 200);
    } catch (err) {
      if (err instanceof SearchProviderError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });
}
