import { describe, expect, it } from "vitest";
import { makePdf } from "../test-utils.js";
import { extractPages, isPdf, MAX_PDF_BYTES } from "./pdf.js";

/**
 * Builds a one-page PDF whose text may contain parentheses, backslashes and Latin-1 accents.
 * `makePdf` can't: it doesn't escape them, encodes as UTF-8 and its font has no encoding entry.
 */
function makeLatin1Pdf(text: string): Uint8Array<ArrayBuffer> {
  const escaped = text.replace(/[\\()]/g, "\\$&");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];

  // One character per byte, so string offsets are byte offsets.
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Uint8Array.from(pdf, (ch) => ch.charCodeAt(0));
}

describe("isPdf", () => {
  it("accepts bytes starting with the PDF header", () => {
    expect(isPdf(makePdf(["x"]))).toBe(true);
    expect(isPdf(new TextEncoder().encode("%PDF-"))).toBe(true);
  });

  it.each([
    ["HTML", new TextEncoder().encode("<html></html>")],
    ["a truncated header", new TextEncoder().encode("%PDF")],
    ["empty input", new Uint8Array()],
    ["a leading space", new TextEncoder().encode(" %PDF-1.4")],
    ["non-text bytes", new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x00])],
  ])("rejects %s", (_name, bytes) => {
    expect(isPdf(bytes)).toBe(false);
  });
});

describe("MAX_PDF_BYTES", () => {
  it("is 25 MiB, matching the limit named in the upload error", () => {
    expect(MAX_PDF_BYTES).toBe(26_214_400);
  });
});

describe("extractPages", () => {
  it("returns the text of each page in order", async () => {
    expect(await extractPages(makePdf(["first page", "second page"]))).toEqual(["first page", "second page"]);
  });

  it("trims the text of each page", async () => {
    expect(await extractPages(makePdf(["  padded  "]))).toEqual(["padded"]);
  });

  it("returns an empty string for a page without text", async () => {
    expect(await extractPages(makePdf(["text", "", "more"]))).toEqual(["text", "", "more"]);
  });

  it("returns no pages for a PDF with zero pages", async () => {
    expect(await extractPages(makePdf([]))).toEqual([]);
  });

  it("keeps many pages in numeric order", async () => {
    const texts = Array.from({ length: 12 }, (_, i) => `p${i + 1}`);
    expect(await extractPages(makePdf(texts))).toEqual(texts);
  });

  it("round-trips parentheses, backslashes and Latin-1 accents", async () => {
    const text = "f(x) = a\\b (nested (parens))";
    expect(await extractPages(makeLatin1Pdf(text))).toEqual([text]);
    expect(await extractPages(makeLatin1Pdf("café naïve Zürich"))).toEqual(["café naïve Zürich"]);
  });

  it("does not consume the caller's buffer", async () => {
    const pdf = makePdf(["hello"]);
    const copy = pdf.slice();
    const first = await extractPages(pdf);
    const second = await extractPages(pdf);
    expect(pdf).toEqual(copy);
    expect(second).toEqual(first);
  });

  it("throws on bytes that are not a parseable PDF", async () => {
    await expect(extractPages(new TextEncoder().encode("%PDF-1.4 garbage"))).rejects.toMatchObject({
      name: "InvalidPDFException",
    });
  });

  it("rejects an empty file", async () => {
    await expect(extractPages(new Uint8Array())).rejects.toMatchObject({
      name: "InvalidPDFException",
      message: expect.stringMatching(/empty/i),
    });
  });

  it.each([0.3, 0.6, 0.9])("rejects a PDF cut off at %s of its length", async (fraction) => {
    const pdf = makePdf(["one", "two", "three", "four"]);
    await expect(extractPages(pdf.slice(0, Math.floor(pdf.length * fraction)))).rejects.toMatchObject({
      name: "InvalidPDFException",
    });
  });
});
