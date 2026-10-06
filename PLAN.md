# Paper Reader Web App — Initial Plan

## Context
Build a web app (frontend + backend) that helps read research papers: search papers via an external API, save them in a local persistent DB, upload PDFs and extract metadata, summarize papers with an LLM, and ask natural-language questions about a selected paper. The directory `/Users/aaryan/school/fall2026/cs593/hw` is empty (not a git repo), so this is a greenfield build. Priority: strong typing to prevent runtime errors.

## Decisions (defaults; confirm Anthropic + Semantic Scholar)
- Language: TypeScript (`strict`) everywhere, npm workspaces monorepo.
- Backend: Hono on Node (`@hono/node-server`), Zod validation (`@hono/zod-validator`).
- Frontend: React + Vite, TanStack Query for data fetching, React Router; typed API client via Hono's `hc` (types imported from backend `AppType`).
- DB: SQLite via `better-sqlite3` + Drizzle ORM (typed schema, migrations). File at `data/papers.db`; uploaded PDFs in `data/pdfs/`.
- Paper search: Semantic Scholar Graph API (`/paper/search`), optional `S2_API_KEY`. Behind a `PaperSearchProvider` interface so OpenAlex can be added later.
- PDF: `unpdf` (pdf.js wrapper) for text + embedded metadata; LLM fallback for metadata.
- LLM: Anthropic API (`@anthropic-ai/sdk`), key via `ANTHROPIC_API_KEY`, model via env (default `claude-sonnet-5-5`).

## Layout
```
hw/
  package.json            (workspaces: shared, server, web)
  tsconfig.base.json      (strict, noUncheckedIndexedAccess)
  .env.example
  shared/src/schemas.ts   Zod schemas + inferred types: Paper, SearchResult, ChatMessage
  server/src/
    index.ts              Hono app, exports `AppType`
    routes/search.ts      GET  /api/search?q=
    routes/papers.ts      GET/POST/DELETE /api/papers, GET /api/papers/:id
    routes/upload.ts      POST /api/papers/upload (multipart PDF)
    routes/summary.ts     POST /api/papers/:id/summarize
    routes/chat.ts        POST /api/papers/:id/chat (streamed), GET history
    db/schema.ts, db/client.ts, db/migrations/
    services/semanticScholar.ts, pdf.ts, llm.ts
  web/src/
    pages/Search.tsx      search box, result cards, "Save" button
    pages/Library.tsx     saved papers, upload dropzone, delete
    pages/Paper.tsx       metadata, summary (generate/regenerate), Q&A chat
    api.ts                hc client
```

## Data model (Drizzle)
- `papers`: id, title, authors (JSON string[]), year (nullable), abstract (nullable), url (nullable), externalId (nullable, unique; S2 paperId), source ('search'|'upload'), pdfPath (nullable), fullText (nullable), summary (nullable), createdAt.
- `messages`: id, paperId (FK, cascade), role ('user'|'assistant'), content, createdAt.

## Feature plans
1. **Search**: server calls Semantic Scholar with `fields=title,authors,year,abstract,url,openAccessPdf,externalIds`; Zod-parse response (abstract/year/url nullable); return normalized `SearchResult[]`. Handle 429 with clear error and one retry.
2. **Save/persist**: "Save" POSTs the result to `/api/papers`; dedupe on `externalId`. Library page loads from DB, so data survives reload.
3. **PDF upload**: multipart upload (size cap ~25MB, `application/pdf` check) → store file → extract text with `unpdf` → read embedded metadata → if title/authors missing or implausible, send first ~2 pages of text to the LLM asking for JSON `{title, authors, year, abstract}`, validated with Zod (one retry on invalid JSON) → insert paper with `fullText`. If open-access search results include a PDF URL, optionally allow "download PDF" later (out of scope initially).
4. **Summarize**: `POST /summarize` sends full text (or abstract if no full text) to Claude with a structured summary prompt (problem, method, results, limitations); cache in `papers.summary`. Truncate/chunk text over the context budget. Papers saved from search without a PDF summarize from the abstract only, and the UI says so.
5. **Q&A**: chat endpoint sends paper text + last N messages + question, streams the response (SSE) to the UI, persists both messages. System prompt: answer only from the paper, say when unsure.

## Cross-cutting
- Env validation with Zod at startup (fail fast on missing `ANTHROPIC_API_KEY`).
- Consistent error shape `{error: string}`; UI shows errors/loading states.
- Dev: `npm run dev` runs server (tsx watch) and Vite concurrently; Vite proxies `/api`. Prod: server serves built `web/dist`.
- Checks: `tsc --noEmit` per workspace, ESLint, Vitest.

## Build order
1. Scaffold monorepo, tsconfig, shared schemas.
2. Server skeleton + DB + papers CRUD.
3. Semantic Scholar search + frontend Search/Library pages (end-to-end save/persist).
4. PDF upload + metadata extraction.
5. Summarization.
6. Q&A chat with streaming.
7. Polish: error handling, tests, README.

## Verification
- `npm run typecheck && npm test` pass (unit tests: S2 response parsing with fixtures, metadata Zod fallback, DB CRUD using in-memory SQLite, mocked LLM).
- Manual end-to-end via `npm run dev`: search "attention is all you need" → save → reload page and confirm it persists → upload a real PDF and confirm title/authors/year/abstract extracted → generate summary → ask a question and see streamed answer, then reload and see history.
- Also test: PDF with no embedded metadata, non-PDF upload rejected, S2 rate-limit error shown.

## Open items
- Confirm Anthropic as LLM provider (needs an API key) and Semantic Scholar for search.
