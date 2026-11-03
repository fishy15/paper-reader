import { describe, expect, it } from "vitest";
import { makePdf } from "../test-utils.js";
import { extractPages, isPdf } from "./pdf.js";

describe("isPdf", () => {
  it("accepts bytes starting with the PDF header", () => {
    expect(isPdf(makePdf(["x"]))).toBe(true);
    expect(isPdf(new TextEncoder().encode("%PDF-"))).toBe(true);
  });

  it("rejects other content, including short or empty input", () => {
    expect(isPdf(new TextEncoder().encode("<html></html>"))).toBe(false);
    expect(isPdf(new TextEncoder().encode("%PDF"))).toBe(false);
    expect(isPdf(new Uint8Array())).toBe(false);
    expect(isPdf(new TextEncoder().encode(" %PDF-1.4"))).toBe(false);
  });
});

describe("extractPages", () => {
  it("returns the trimmed text of each page in order", async () => {
    expect(await extractPages(makePdf(["first page", "second page"]))).toEqual(["first page", "second page"]);
  });

  it("returns an empty string for a page without text", async () => {
    expect(await extractPages(makePdf(["text", "", "more"]))).toEqual(["text", "", "more"]);
  });

  it("does not consume the caller's buffer", async () => {
    const pdf = makePdf(["hello"]);
    const copy = pdf.slice();
    await extractPages(pdf);
    await extractPages(pdf);
    expect(pdf).toEqual(copy);
  });

  it("throws on bytes that are not a parseable PDF", async () => {
    await expect(extractPages(new TextEncoder().encode("%PDF-1.4 garbage"))).rejects.toThrow();
  });
});
