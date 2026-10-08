import { Hono } from "hono";
import type { Db } from "./db/client.js";
import { papersRoutes } from "./routes/papers.js";
import { qaRoutes } from "./routes/qa.js";
import { searchRoutes } from "./routes/search.js";
import { summaryRoutes } from "./routes/summary.js";
import { uploadRoutes } from "./routes/upload.js";
import type { Llm } from "./services/llm.js";
import type { PaperSearchProvider } from "./services/semanticScholar.js";

export interface AppDeps {
  db: Db;
  searchProvider: PaperSearchProvider;
  llm: Llm;
  /** Directory holding the database and uploaded PDFs. */
  dataDir: string;
}

export function createApp({ db, searchProvider, llm, dataDir }: AppDeps) {
  return new Hono()
    .onError((err, c) => {
      // Single-user local tool: surface the real error message instead of hiding it.
      console.error(err);
      return c.json({ error: err.message }, 500);
    })
    .route("/api/papers", papersRoutes(db, dataDir))
    .route("/api/papers", uploadRoutes({ db, llm, dataDir }))
    .route("/api/papers", summaryRoutes({ db, llm }))
    .route("/api/papers", qaRoutes({ db, llm }))
    .route("/api/search", searchRoutes(searchProvider));
}

export type AppType = ReturnType<typeof createApp>;
