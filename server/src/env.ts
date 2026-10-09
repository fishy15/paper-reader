import path from "node:path";
import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().default(3000),
  // The API has no authentication, so only accept connections from this machine.
  HOST: z.string().default("127.0.0.1"),
  DATA_DIR: z.string().default(path.resolve(import.meta.dirname, "../../data")),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-3.5-flash-lite"),
  // Google doesn't publish fixed free-tier limits; check yours in AI Studio and raise this if allowed.
  GEMINI_RPM: z.coerce.number().positive().default(5),
  S2_API_KEY: z.string().optional(),
});
export type Env = z.infer<typeof Env>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // `PORT=` in a .env file is an empty string, which would otherwise count as 0 or a blank key.
  const set = Object.entries(source).filter(([, value]) => value !== "");
  return Env.parse(Object.fromEntries(set));
}
