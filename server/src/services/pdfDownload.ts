import { isPdf, MAX_PDF_BYTES } from "./pdf.js";

/** A download failure with a message that is safe to show the user. */
export class PdfDownloadError extends Error {}

export interface DownloadOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Downloads a PDF, refusing anything that isn't a PDF or is larger than `maxBytes`. */
export async function downloadPdf(
  url: string,
  { fetchFn = fetch, timeoutMs = 30_000, maxBytes = MAX_PDF_BYTES }: DownloadOptions = {},
): Promise<Uint8Array> {
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
    throw new PdfDownloadError("The PDF link is not an http(s) URL");
  }

  let res: Response;
  try {
    res = await fetchFn(url, { headers: { accept: "application/pdf" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new PdfDownloadError("Could not download the PDF (host unreachable or timed out)");
  }
  if (!res.ok) throw new PdfDownloadError(`Could not download the PDF (the host returned ${res.status})`);

  const tooLarge = new PdfDownloadError(`The PDF is too large (limit ${Math.round(maxBytes / 1024 / 1024)} MB)`);
  if (Number(res.headers.get("content-length")) > maxBytes) throw tooLarge;

  // Content-Length can be missing or wrong, so enforce the limit while reading too.
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for await (const chunk of res.body ?? []) {
      received += chunk.byteLength;
      if (received > maxBytes) throw tooLarge;
      chunks.push(chunk);
    }
  } catch (err) {
    if (err === tooLarge) throw err;
    throw new PdfDownloadError("The PDF download was interrupted");
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!isPdf(bytes)) throw new PdfDownloadError("The link did not return a PDF (it may be a web page)");
  return bytes;
}
