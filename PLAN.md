# Paper Reader Web App — Initial Plan

## Context
Build a web app (frontend + backend) that helps read research papers: search papers via an external API, save them in a local persistent DB, upload PDFs and extract metadata, summarize papers with an LLM, and ask natural-language questions about a selected paper. The directory `/Users/aaryan/school/fall2026/cs593/hw` is empty (not a git repo), so this is a greenfield build. Priority: strong typing to prevent runtime errors.

## Decisions
- Language: TypeScript (`strict`) everywhere, npm workspaces monorepo.
- Backend: Hono on Node (`@hono/node-server`), Zod validation (`@hono/zod-validator`).
- Frontend: React + Vite, TanStack Query for data fetching, React Router; typed API client via Hono's `hc` (types imported from backend `AppType`).
- DB: SQLite via `better-sqlite3` + Drizzle ORM (typed schema, migrations). File at `data/papers.db`; uploaded PDFs in `data/pdfs/`.
- Paper search: Semantic Scholar Graph API (`/paper/search`), optional `S2_API_KEY`. Behind a `PaperSearchProvider` interface so OpenAlex can be added later.
- PDF: `unpdf` (pdf.js wrapper) for text + embedded metadata; LLM fallback for metadata.
- LLM: Google Gemini free tier (`@google/genai`, `models.generateContent`), key via `GEMINI_API_KEY`, model via `GEMINI_MODEL` (default `gemini-3.5-flash-lite`). Free-tier prompts may be used by Google to improve its products, so only public papers should be uploaded. Google publishes no fixed free limits (see AI Studio), so an in-process limiter spaces requests to `GEMINI_RPM` (default 5) per minute and a 429 is reported to the user.

## Layout
```
hw/
  package.json            (workspaces: shared, server, web)
  tsconfig.base.json      (strict, noUncheckedIndexedAccess)
  .env.example
  shared/src/schemas.ts   Zod schemas + inferred types: Paper, SearchResult, QaMessage
  server/src/
    index.ts              Hono app, exports `AppType`
    routes/search.ts      GET  /api/search?query=
    routes/papers.ts      GET /api/papers, GET/DELETE /api/papers/:id, POST /api/papers/from-search
    routes/upload.ts      POST /api/papers/upload (multipart PDF)
    routes/summary.ts     POST /api/papers/:id/summarize
    routes/qa.ts          POST /api/papers/:id/qa (streamed), GET history
    db/schema.ts, db/client.ts, db/migrations/
    services/semanticScholar.ts, pdf.ts, llm.ts
  web/src/
    pages/Search.tsx      search box, result cards, "Save" button
    pages/Library.tsx     saved papers, upload dropzone, delete
    pages/Paper.tsx       metadata, summary (generate/regenerate), Q&A chat
    api.ts                hc client
```

## Data model (Drizzle)
- `papers`: id, title, authors (JSON string[]), year (nullable), abstract (nullable), url (nullable), externalId (nullable, unique; S2 paperId), source ('search'|'upload'), pdfUrl (nullable), localPdfPath (nullable), fullText (nullable), summary (nullable), createdAt.
- `qa_messages`: id, paperId (FK, cascade), role ('user'|'assistant'), content, createdAt.

## Feature plans
1. **Search**: server calls Semantic Scholar with `fields=title,authors,year,abstract,url,openAccessPdf,externalIds`; Zod-parse response (abstract/year/url nullable); return normalized `SearchResult[]`. Handle 429 with clear error and one retry.
2. **Save/persist**: "Save" POSTs the result to `/api/papers/from-search`; dedupe on `externalId`. Library page loads from DB, so data survives reload.
3. **PDF upload**: multipart upload (25MB cap, `%PDF-` magic-byte check) → extract text per page with `unpdf` → send the first 2 pages (capped at 12k chars) to the LLM, which returns `{title, authors, year, abstract}` via Gemini JSON-schema output (`responseJsonSchema` generated from the Zod schema, then validated with Zod; "not stated" is encoded as `0` / `""` because Gemini supports only a subset of JSON Schema). The LLM always runs because embedded PDF metadata never contains the abstract and is often wrong. Title falls back to the filename and implausible years become null → store the PDF under `data/pdfs/<uuid>.pdf` (path stored relative to `DATA_DIR`) and insert the paper with `fullText`. Deleting a paper deletes its file. Scanned PDFs (no text layer) are rejected.
4. **Summarize**: `POST /summarize` sends full text (or abstract if no full text) to the LLM with a structured summary prompt (problem, method, results, limitations); cache in `papers.summary`. Truncate/chunk text over the context budget. Papers saved from search without a PDF summarize from the abstract only, and the UI says so.
5. **Q&A**: qa endpoint sends paper text + last N messages + question, streams the response (SSE) to the UI, persists both messages. System prompt: answer only from the paper, say when unsure.

## Cross-cutting
- Env validation with Zod at startup. `GEMINI_API_KEY` is checked on the first LLM call, so search and the library work without it.
- Consistent error shape `{error: string}`; UI shows errors/loading states.
- Dev: `npm run dev` runs server (tsx watch) and Vite concurrently; Vite proxies `/api`. Prod: server serves built `web/dist`.
- Checks: `tsc --noEmit` per workspace, ESLint, Vitest.

## Build order
1. Scaffold monorepo, tsconfig, shared schemas.
2. Server skeleton + DB + papers CRUD.
3. Semantic Scholar search + frontend Search/Library pages (end-to-end save/persist).
4. PDF upload + metadata extraction.
5. Summarization.
6. Q&A with streaming.
7. Polish: error handling, tests, README.

## Verification
- `npm run typecheck && npm test` pass (unit tests: S2 response parsing with fixtures, metadata Zod fallback, DB CRUD using in-memory SQLite, mocked LLM).
- Manual end-to-end via `npm run dev`: search "attention is all you need" → save → reload page and confirm it persists → upload a real PDF and confirm title/authors/year/abstract extracted → generate summary → ask a question and see streamed answer, then reload and see history.
- Also test: PDF with no embedded metadata, non-PDF upload rejected, S2 rate-limit error shown.
