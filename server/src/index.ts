import path from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDb } from "./db/client.js";
import { loadEnv } from "./env.js";
import { createSemanticScholarProvider } from "./services/semanticScholar.js";

const env = loadEnv();
const db = createDb(path.join(env.DATA_DIR, "papers.db"));
const app = createApp({
  db,
  searchProvider: createSemanticScholarProvider({ apiKey: env.S2_API_KEY }),
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`Server listening on http://localhost:${info.port}`);
});
