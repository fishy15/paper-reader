import { describe, expect, it, vi } from "vitest";
import { makePdf } from "../test-utils.js";
import { downloadPdf, PdfDownloadError } from "./pdfDownload.js";

const URL_OK = "https://example.org/paper.pdf";

describe("downloadPdf", () => {
  it("returns the bytes of a PDF and sends a timeout signal", async () => {
    const pdf = makePdf(["hello"]);
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(pdf));
    expect(await downloadPdf(URL_OK, { fetchFn })).toEqual(pdf);
    expect(fetchFn.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects links that are not http(s) URLs without fetching", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    for (const url of ["not a url", "file:///etc/passwd", "ftp://example.org/a.pdf"]) {
      await expect(downloadPdf(url, { fetchFn })).rejects.toThrow(/not an http\(s\) URL/);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports HTTP errors, network failures and non-PDF responses", async () => {
    const cases: [typeof fetch, RegExp][] = [
      [async () => new Response("nope", { status: 403 }), /returned 403/],
      [async () => Promise.reject(new Error("offline")), /unreachable or timed out/],
      [async () => new Response("<html>landing page</html>"), /did not return a PDF/],
      [async () => new Response(null), /did not return a PDF/],
    ];
    for (const [fetchFn, message] of cases) {
      const error = await downloadPdf(URL_OK, { fetchFn }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PdfDownloadError);
      expect((error as Error).message).toMatch(message);
    }
  });

  it("rejects oversized PDFs by Content-Length and while streaming", async () => {
    const pdf = makePdf(["hello"]);
    const declared = async () => new Response(pdf, { headers: { "content-length": String(pdf.length) } });
    await expect(downloadPdf(URL_OK, { fetchFn: declared, maxBytes: 10 })).rejects.toThrow(/too large/);

    const undeclared = async () => new Response(pdf);
    await expect(downloadPdf(URL_OK, { fetchFn: undeclared, maxBytes: 10 })).rejects.toThrow(/too large/);
  });

  it("reports an interrupted download", async () => {
    const broken = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("%PDF-1.4"));
            controller.error(new Error("connection reset"));
          },
        }),
      );
    await expect(downloadPdf(URL_OK, { fetchFn: broken })).rejects.toThrow(/interrupted/);
  });
});
