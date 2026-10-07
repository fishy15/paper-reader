import path from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDb } from "./db/client.js";
import { loadEnv } from "./env.js";
import { createLlm } from "./services/llm.js";
import { createSemanticScholarProvider } from "./services/semanticScholar.js";

const env = loadEnv();
const db = createDb(path.join(env.DATA_DIR, "papers.db"));
const app = createApp({
  db,
  searchProvider: createSemanticScholarProvider({ apiKey: env.S2_API_KEY }),
  llm: createLlm({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
    requestsPerMinute: env.GEMINI_RPM,
  }),
  dataDir: env.DATA_DIR,
});

serve({ fetch: app.fetch, hostname: env.HOST, port: env.PORT }, (info) => {
  console.log(`Server listening on http://${info.address}:${info.port}`);
});
