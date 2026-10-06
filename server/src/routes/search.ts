import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { SearchProviderError, type PaperSearchProvider } from "../services/semanticScholar.js";

const Query = z.object({
  q: z.string().trim().min(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export function searchRoutes(provider: PaperSearchProvider) {
  return new Hono().get("/", zValidator("query", Query), async (c) => {
    const { q, limit } = c.req.valid("query");
    try {
      return c.json(await provider.search(q, limit), 200);
    } catch (err) {
      if (err instanceof SearchProviderError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });
}
