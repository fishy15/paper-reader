import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "./env.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
// Every key `loadEnv` returns, so a key added to the schema is picked up. The schema isn't exported; a new
// optional key without a default only appears here once it is given a value in this call.
const ENV_KEYS = Object.keys(loadEnv({ GEMINI_API_KEY: "k", S2_API_KEY: "s" }));

/** The `KEY=value` lines of the repo's .env.example, ignoring comments and blank lines. */
function readEnvExample(): Record<string, string> {
  const text = fs.readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");
  const lines = text.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#"));
  return Object.fromEntries(
    lines.map((line) => {
      const eq = line.indexOf("=");
      return [line.slice(0, eq), line.slice(eq + 1)];
    }),
  );
}

afterEach(() => vi.unstubAllEnvs());

describe("loadEnv", () => {
  it("applies defaults for an empty environment", () => {
    const env = loadEnv({});
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.GEMINI_RPM).toBe(5);
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.S2_API_KEY).toBeUndefined();
    expect(path.isAbsolute(env.DATA_DIR)).toBe(true);
  });

  it("coerces numeric values from strings", () => {
    const env = loadEnv({ PORT: "8080", GEMINI_RPM: "15" });
    expect(env.PORT).toBe(8080);
    expect(env.GEMINI_RPM).toBe(15);
  });

  it("treats empty strings as unset, for every key", () => {
    const empty = Object.fromEntries(ENV_KEYS.map((key) => [key, ""]));
    const env = loadEnv(empty);
    expect(env).toEqual(loadEnv({}));
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.S2_API_KEY).toBeUndefined();
  });

  it("treats an undefined value as unset", () => {
    expect(loadEnv({ PORT: undefined, GEMINI_RPM: undefined })).toEqual(loadEnv({}));
  });

  it("keeps provided keys and overrides", () => {
    const env = loadEnv({ GEMINI_API_KEY: "k", S2_API_KEY: "s", GEMINI_MODEL: "m", DATA_DIR: "/tmp/x" });
    expect(env).toMatchObject({ GEMINI_API_KEY: "k", S2_API_KEY: "s", GEMINI_MODEL: "m", DATA_DIR: "/tmp/x" });
  });

  it("accepts a GEMINI_RPM below one per minute", () => {
    expect(loadEnv({ GEMINI_RPM: "0.5" }).GEMINI_RPM).toBe(0.5);
  });

  it.each<[string, string, RegExp]>([
    ["PORT", "abc", /PORT/],
    ["PORT", "1.5", /PORT/],
    ["GEMINI_RPM", "0", /GEMINI_RPM/],
    ["GEMINI_RPM", "-3", /GEMINI_RPM/],
    ["GEMINI_RPM", "Infinity", /GEMINI_RPM/],
    ["GEMINI_RPM", "NaN", /GEMINI_RPM/],
  ])("rejects %s=%s and names the variable", (key, value, name) => {
    expect(() => loadEnv({ [key]: value })).toThrow(name);
  });

  it("reads process.env when called without an argument", () => {
    vi.stubEnv("PORT", "4321");
    expect(loadEnv().PORT).toBe(4321);
  });

  it("ignores unrelated variables", () => {
    const env = loadEnv({ PATH: "/x", FOO: "bar" });
    expect(env).toEqual(loadEnv({}));
    expect(Object.keys(env)).not.toContain("PATH");
    expect(Object.keys(env)).not.toContain("FOO");
  });

  it("defaults DATA_DIR to the data directory at the repo root", () => {
    const parent = path.dirname(loadEnv({}).DATA_DIR);
    expect(fs.existsSync(path.join(parent, "server", "package.json"))).toBe(true);
    expect(path.basename(loadEnv({}).DATA_DIR)).toBe("data");
  });

  describe(".env.example", () => {
    it("loads without error and blank values fall back to defaults", () => {
      const example = readEnvExample();
      const env = loadEnv(example);
      expect(example.GEMINI_API_KEY).toBe("");
      expect(env.GEMINI_API_KEY).toBeUndefined();
      expect(env.S2_API_KEY).toBeUndefined();
    });

    it("only has keys the schema knows", () => {
      const known = Object.keys(loadEnv({ GEMINI_API_KEY: "k", S2_API_KEY: "s" }));
      expect(Object.keys(readEnvExample()).filter((key) => !known.includes(key))).toEqual([]);
    });

    it("has every key the schema knows", () => {
      const keys = Object.keys(readEnvExample());
      expect(ENV_KEYS.filter((key) => !keys.includes(key))).toEqual([]);
    });
  });

  // Planned fixes (see "Configuration" in ISSUES.md): tests in the "planned fixes" blocks fail until the schema changes.
  describe("PORT range", () => {
    it.each(["1", "65535"])("accepts PORT=%s", (value) => {
      expect(loadEnv({ PORT: value }).PORT).toBe(Number(value));
    });

    it("rejects PORT=1.5", () => {
      expect(() => loadEnv({ PORT: "1.5" })).toThrow(/PORT/);
    });

    describe("planned fixes", () => {
      it.each(["0", "-1", "70000"])("rejects PORT=%s", (value) => {
        expect(() => loadEnv({ PORT: value })).toThrow(/PORT/);
      });
    });
  });

  describe("planned fixes", () => {
    it.each(["PORT", "HOST", "GEMINI_RPM"])("treats whitespace-only %s as unset", (key) => {
      expect(loadEnv({ [key]: " " })).toEqual(loadEnv({}));
    });

    it("resolves a relative DATA_DIR against the repo root and leaves an absolute one alone", () => {
      expect(loadEnv({ DATA_DIR: "my-data" }).DATA_DIR).toBe(path.join(REPO_ROOT, "my-data"));
      expect(loadEnv({ DATA_DIR: "/tmp/x" }).DATA_DIR).toBe("/tmp/x");
    });
  });
});
