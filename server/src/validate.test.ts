import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validate } from "./validate.js";

const app = new Hono()
  .post("/json", validate("json", z.object({ name: z.string(), nested: z.object({ n: z.number() }) })), (c) =>
    c.json(c.req.valid("json")),
  )
  .post("/list", validate("json", z.object({ items: z.array(z.string()) })), (c) => c.json(c.req.valid("json")))
  .get("/query", validate("query", z.object({ q: z.string().min(2) })), (c) => c.json(c.req.valid("query")))
  .get("/page", validate("query", z.object({ n: z.coerce.number() })), (c) =>
    c.json({ n: c.req.valid("query").n, type: typeof c.req.valid("query").n }),
  );

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
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/^Invalid request \(name: .+; nested\.n: .+\)$/);
  });

  it("uses the target name when the issue has no path", async () => {
    const res = await post("just a string");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Invalid request \(json: .+\)$/);
  });

  it("names the array index of a bad entry", async () => {
    const res = await app.request("/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: ["a", 1] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Invalid request \(items\.1: .+\)$/);
  });

  it("rejects malformed JSON with a 400 that mentions it", async () => {
    const res = await app.request("/json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/malformed/i);
  });

  it("rejects an empty body with a JSON content-type with a 400", async () => {
    const res = await app.request("/json", { method: "POST", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/malformed/i);
  });

  it("reports missing fields when the content-type is absent", async () => {
    const res = await app.request("/json", { method: "POST", body: JSON.stringify({ name: "a", nested: { n: 1 } }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Invalid request \(name: .+; nested: .+\)$/);
  });

  it("passes a valid query string through", async () => {
    const res = await app.request("/query?q=ok");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ q: "ok" });
  });

  it("returns a 400 naming the field for an invalid query string", async () => {
    const res = await app.request("/query?q=a");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Invalid request \(q: .+\)$/);
  });

  it("hands the handler the coerced query value", async () => {
    const res = await app.request("/page?n=5");
    expect(await res.json()).toEqual({ n: 5, type: "number" });
  });
});
