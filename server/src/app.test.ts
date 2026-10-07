import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { createDb, IN_MEMORY_DB } from "./db/client.js";

function makeApp(search: () => Promise<never[]> = async () => []) {
  return createApp({ db: createDb(IN_MEMORY_DB), searchProvider: { search } });
}

describe("error handling", () => {
  it("returns unexpected errors to the client as a 500 and logs them", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = makeApp(async () => {
      throw new Error("secret internal detail");
    });
    const res = await app.request("/api/search?query=x");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "secret internal detail" });
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});
