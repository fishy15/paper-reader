import { describe, expect, it, vi } from "vitest";
import { makePdf } from "../test-utils.js";
import { MAX_PDF_BYTES } from "./pdf.js";
import { downloadPdf, PdfDownloadError } from "./pdfDownload.js";

const URL_OK = "https://example.org/paper.pdf";

const bytesOf = (text: string) => new TextEncoder().encode(text);

/** A body of `size` bytes that starts with the PDF header. */
const pdfBody = (size: number) => bytesOf("%PDF-".padEnd(size, "x"));

/** A response that streams the given chunks one by one. */
function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { headers });
}

describe("downloadPdf", () => {
  it("returns the bytes of a PDF", async () => {
    const pdf = makePdf(["hello"]);
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(pdf));
    expect(await downloadPdf(URL_OK, { fetchFn })).toEqual(pdf);
  });

  it("reassembles a body that arrives in several chunks", async () => {
    const pdf = makePdf(["hello world"]);
    const cuts = [7, 100];
    const chunks = [pdf.slice(0, cuts[0]), pdf.slice(cuts[0], cuts[1]), pdf.slice(cuts[1])];
    const fetchFn = async () => streamed(chunks);
    expect(await downloadPdf(URL_OK, { fetchFn })).toEqual(pdf);
  });

  it("requests the URL unchanged, asking for a PDF, with a timeout signal", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(makePdf(["hello"])));
    await downloadPdf(URL_OK, { fetchFn });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(URL_OK);
    expect(new Headers(init?.headers).get("accept")).toBe("application/pdf");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["an https URL", "https://example.org/a.pdf"],
    ["an http URL", "http://example.org/a.pdf"],
    ["an uppercase scheme", "HTTP://EXAMPLE.ORG/a.pdf"],
  ])("accepts %s", async (_name, url) => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(makePdf(["hello"])));
    await downloadPdf(url, { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["not a URL", "not a url"],
    ["a file URL", "file:///etc/passwd"],
    ["an ftp URL", "ftp://example.org/a.pdf"],
  ])("rejects %s without fetching", async (_name, url) => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(downloadPdf(url, { fetchFn })).rejects.toThrow(/not an http\(s\) URL/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each<[string, () => Promise<Response>, RegExp]>([
    ["an HTTP error", async () => new Response("nope", { status: 403 }), /returned 403/],
    ["a network failure", async () => Promise.reject(new Error("offline")), /unreachable or timed out/],
    ["an HTML page", async () => new Response("<html>landing page</html>"), /did not return a PDF/],
    ["an empty body", async () => new Response(null), /did not return a PDF/],
  ])("reports %s", async (_name, fetchFn, message) => {
    const result = downloadPdf(URL_OK, { fetchFn });
    await expect(result).rejects.toBeInstanceOf(PdfDownloadError);
    await expect(result).rejects.toThrow(message);
  });

  it("gives up when the request does not finish within the timeout", async () => {
    const fetchFn = (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const result = downloadPdf(URL_OK, { fetchFn, timeoutMs: 20 });
    await expect(result).rejects.toBeInstanceOf(PdfDownloadError);
    await expect(result).rejects.toThrow(/unreachable or timed out/);
  });

  describe("size limit", () => {
    const declared = (size: number, declaredLength: string) => async () =>
      new Response(pdfBody(size), { headers: { "content-length": declaredLength } });

    it.each<[string, number | undefined, () => Promise<Response>, number | RegExp]>([
      ["a streamed body of exactly the limit", 20, async () => streamed([pdfBody(20)]), 20],
      ["a streamed body one byte over the limit", 20, async () => streamed([pdfBody(21)]), /too large/],
      ["a declared length of exactly the limit", 20, declared(20, "20"), 20],
      ["a declared length one byte over the limit", 20, declared(20, "21"), /too large/],
      [
        "two chunks that are each under the limit but over it together",
        15,
        async () => streamed([pdfBody(8), bytesOf("xxxxxxxxxxxx")]),
        /too large/,
      ],
      ["a non-numeric length with a small body", 100, declared(30, "abc"), 30],
      ["a non-numeric length with a body over the limit", 20, async () => streamed([pdfBody(30)], { "content-length": "abc" }), /too large/],
      ["a declared length over the default limit", undefined, declared(30, String(MAX_PDF_BYTES + 1)), /limit 25 MB/],
      ["a tiny limit (rounds to 0 MB)", 5, async () => streamed([pdfBody(30)]), /too large/],
    ])("handles %s", async (_name, maxBytes, fetchFn, expected) => {
      const options = maxBytes === undefined ? { fetchFn } : { fetchFn, maxBytes };
      if (typeof expected === "number") {
        expect((await downloadPdf(URL_OK, options)).byteLength).toBe(expected);
      } else {
        const result = downloadPdf(URL_OK, options);
        await expect(result).rejects.toBeInstanceOf(PdfDownloadError);
        await expect(result).rejects.toThrow(expected);
      }
    });

    it("cancels the stream instead of reading an oversized body to the end", async () => {
      const cancel = vi.fn();
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          controller.enqueue(pdfBody(8));
        },
        cancel,
      });
      const fetchFn = async () => new Response(body);
      await expect(downloadPdf(URL_OK, { fetchFn, maxBytes: 15 })).rejects.toThrow(/too large/);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(pulls).toBeLessThan(10);
    });
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
