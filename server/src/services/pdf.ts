import { extractText, getDocumentProxy } from "unpdf";

const PDF_MAGIC = "%PDF-";

/** True if the bytes start with the PDF header (the client-reported MIME type is not trusted). */
export function isPdf(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes.subarray(0, PDF_MAGIC.length)) === PDF_MAGIC;
}

/** Extracts the text of each page. Throws if the PDF can't be parsed (corrupt, encrypted, ...). */
export async function extractPages(bytes: Uint8Array): Promise<string[]> {
  // pdf.js may take ownership of the buffer it is given, so hand it a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return text.map((page) => page.trim());
}
