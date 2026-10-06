import path from "node:path";
import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().default(3000),
  DATA_DIR: z.string().default(path.resolve(import.meta.dirname, "../../data")),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),
  S2_API_KEY: z.string().optional(),
});
export type Env = z.infer<typeof Env>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return Env.parse(source);
}
