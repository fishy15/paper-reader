import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { ZodType } from "zod";

/** `zValidator` that rejects with the same `{ error }` body as every other failure. */
export function validate<Target extends keyof ValidationTargets, Schema extends ZodType>(
  target: Target,
  schema: Schema,
) {
  return zValidator(target, schema, (result, c) => {
    if (result.success) return;
    const issues = result.error.issues.map((i) => `${i.path.join(".") || target}: ${i.message}`);
    return c.json({ error: `Invalid request (${issues.join("; ")})` }, 400);
  });
}
