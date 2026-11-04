import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createDb, IN_MEMORY_DB } from "./client.js";
import { papers } from "./schema.js";

describe("createDb", () => {
  it("creates missing parent directories for a file database", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "createdb-"));
    onTestFinished(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });
    const file = path.join(root, "a", "b", "app.db");
    const db = createDb(file);
    onTestFinished(() => {
      db.$client.close();
    });
    expect(fs.statSync(path.dirname(file)).isDirectory()).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    db.insert(papers).values({ title: "T", authors: [], source: "upload" }).run();
    expect(db.select().from(papers).all()).toHaveLength(1);
  });

  it("keeps an in-memory database off disk", () => {
    expect(IN_MEMORY_DB).toBe(":memory:");
    const db = createDb(IN_MEMORY_DB);
    onTestFinished(() => {
      db.$client.close();
    });
    expect(db.$client.memory).toBe(true);
  });
});
