import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";
import { createApp, type AppDeps } from "./app.js";
import { createDb, IN_MEMORY_DB } from "./db/client.js";
import type { Llm } from "./services/llm.js";

/** An LLM that returns canned answers; override only the methods a test cares about. */
export function fakeLlm(overrides: Partial<Llm> = {}): Llm {
  return {
    extractMetadata: async () => ({
      title: "Fake Title",
      authors: ["A. Author", "B. Author"],
      year: 2020,
      abstract: "Fake abstract.",
    }),
    summarize: async () => "Fake summary.",
    answer: async function* () {
      yield "Fake ";
      yield "answer.";
    },
    ...overrides,
  };
}

/** Builds an app backed by an in-memory DB, a temp data dir and fake search/LLM services. */
export function makeTestApp(overrides: Partial<AppDeps> = {}) {
  const dataDir = overrides.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "paper-reader-test-"));
  if (!overrides.dataDir) onTestFinished(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const deps: AppDeps = {
    db: createDb(IN_MEMORY_DB),
    searchProvider: { search: async () => [] },
    llm: fakeLlm(),
    dataDir,
    ...overrides,
  };
  return { app: createApp(deps), deps };
}

/** Builds a minimal valid PDF with one page per string (ASCII text without parentheses). */
export function makePdf(pageTexts: string[]): Uint8Array<ArrayBuffer> {
  const objects: string[] = [];
  const pageId = (i: number) => 4 + 2 * i;
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageTexts.map((_, i) => `${pageId(i)} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pageTexts.forEach((text, i) => {
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "";
    objects[pageId(i)] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId(i) + 1} 0 R >>`;
    objects[pageId(i) + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

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
  return new TextEncoder().encode(pdf);
}
