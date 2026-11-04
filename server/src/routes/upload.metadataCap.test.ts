import { describe, expect, it, vi } from "vitest";
import type { Llm } from "../services/llm.js";
import { fakeLlm, makePdf, makeTestApp } from "../test-utils.js";

// The `makePdf` fixture can't reach the 12,000-character cap: text that runs off the page edge is not
// extracted, so one page yields about 81 characters. Pages are returned directly instead, which lets
// the test see where the route cuts the text.
vi.mock("../services/pdf.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/pdf.js")>()),
  extractPages: vi.fn(async () => ["a".repeat(7_000), "b".repeat(7_000), "c".repeat(7_000)]),
}));

describe("PDF upload metadata text", () => {
  it("is the first two pages cut at 12,000 characters", async () => {
    const extractMetadata = vi.fn<Llm["extractMetadata"]>(fakeLlm().extractMetadata);
    const { app } = makeTestApp({ llm: fakeLlm({ extractMetadata }) });
    const form = new FormData();
    form.append("file", new File([makePdf(["x"])], "paper.pdf", { type: "application/pdf" }));

    const res = await app.request("/api/papers/upload", { method: "POST", body: form });
    expect(res.status).toBe(201);

    const sent = extractMetadata.mock.calls[0]![0];
    expect(sent).toHaveLength(12_000);
    expect(sent).toBe(`${"a".repeat(7_000)}\n\n${"b".repeat(4_998)}`);
  });
});
