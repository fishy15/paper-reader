import { Hono } from "hono";
import type { Db } from "./db/client.js";
import { papersRoutes } from "./routes/papers.js";
import { searchRoutes } from "./routes/search.js";
import type { PaperSearchProvider } from "./services/semanticScholar.js";

export interface AppDeps {
  db: Db;
  searchProvider: PaperSearchProvider;
}

export function createApp({ db, searchProvider }: AppDeps) {
  return new Hono()
    .onError((err, c) => {
      console.error(err);
      return c.json({ error: "Internal server error" }, 500);
    })
    .route("/api/papers", papersRoutes(db))
    .route("/api/search", searchRoutes(searchProvider));
}

export type AppType = ReturnType<typeof createApp>;
