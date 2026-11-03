import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

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

  it("treats empty strings as unset", () => {
    const env = loadEnv({ PORT: "", GEMINI_API_KEY: "", HOST: "" });
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });

  it("keeps provided keys and overrides", () => {
    const env = loadEnv({ GEMINI_API_KEY: "k", S2_API_KEY: "s", GEMINI_MODEL: "m", DATA_DIR: "/tmp/x" });
    expect(env).toMatchObject({ GEMINI_API_KEY: "k", S2_API_KEY: "s", GEMINI_MODEL: "m", DATA_DIR: "/tmp/x" });
  });

  it("rejects invalid values", () => {
    expect(() => loadEnv({ PORT: "abc" })).toThrow();
    expect(() => loadEnv({ PORT: "1.5" })).toThrow();
    expect(() => loadEnv({ GEMINI_RPM: "0" })).toThrow();
    expect(() => loadEnv({ GEMINI_RPM: "-3" })).toThrow();
  });
});
