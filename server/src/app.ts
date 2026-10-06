import { Hono } from "hono";
import type { Db } from "./db/client.js";
import { papersRoutes } from "./routes/papers.js";

export function createApp(db: Db) {
  return new Hono()
    .onError((err, c) => {
      console.error(err);
      return c.json({ error: "Internal server error" }, 500);
    })
    .route("/api/papers", papersRoutes(db));
}

export type AppType = ReturnType<typeof createApp>;
