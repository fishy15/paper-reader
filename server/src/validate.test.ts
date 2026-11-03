import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validate } from "./validate.js";

const app = new Hono()
  .post("/json", validate("json", z.object({ name: z.string(), nested: z.object({ n: z.number() }) })), (c) =>
    c.json(c.req.valid("json")),
  )
  .get("/query", validate("query", z.object({ q: z.string().min(2) })), (c) => c.json(c.req.valid("query")));

const post = (body: unknown) =>
  app.request("/json", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("validate", () => {
  it("passes valid input through", async () => {
    const res = await post({ name: "a", nested: { n: 1 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "a", nested: { n: 1 } });
  });

  it("returns a 400 { error } listing each issue with its path", async () => {
    const res = await post({ name: 1, nested: { n: "x" } });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/^Invalid request \(/);
    expect(error).toContain("name:");
    expect(error).toContain("nested.n:");
  });

  it("uses the target name when the issue has no path", async () => {
    const res = await post("just a string");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("json:");
  });

  it("validates query strings", async () => {
    expect((await app.request("/query?q=ok")).status).toBe(200);
    const res = await app.request("/query?q=a");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("q:");
  });
});
