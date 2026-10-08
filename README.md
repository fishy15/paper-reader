# Paper Reader

A local web app for reading research papers. It can:

- search papers on Semantic Scholar (title, authors, year, abstract, link) and save them to a local library,
- upload a PDF and extract the same metadata with Gemini,
- summarize a paper from its full text,
- answer natural-language questions about a paper, streamed as they are written, with the conversation saved.

Everything is stored locally in SQLite under `data/`. The only external services are Semantic Scholar
(search) and Google Gemini (metadata, summaries, answers).

## Setup

Requires Node.js 22.9 or newer (the server uses `--env-file-if-exists`).

```sh
npm install
cp .env.example .env
```

Then edit `.env`:

| Variable         | Purpose                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `GEMINI_API_KEY` | Free key from https://aistudio.google.com/apikey. Needed for uploads, summaries and Q&A.     |
| `GEMINI_MODEL`   | Model id to use (default in `.env.example`).                                                 |
| `GEMINI_RPM`     | Requests per minute the server allows itself (default 5). Raise it if your quota is higher.  |
| `S2_API_KEY`     | Optional Semantic Scholar key. Search works without one but is rate limited more strictly.   |
| `HOST`, `PORT`   | Where the server listens (default `127.0.0.1:3000`).                                         |

Search and the library work without a Gemini key; everything that calls the LLM needs it.

## Running

```sh
npm run dev
```

This starts the API server (port 3000) and the Vite dev server together. Open the URL Vite prints
(http://localhost:5173 by default); it proxies `/api` to the server.

## Checks

```sh
npm run typecheck   # all workspaces
npm test            # server and web tests (no network or API key needed)
```

## Layout

```
shared/   Zod schemas and the types inferred from them, used by both sides
server/   Hono API, Drizzle + SQLite, Semantic Scholar and Gemini clients
web/      React + Vite UI; talks to the API through Hono's typed client
data/     SQLite database and uploaded PDFs (created on first run, git-ignored)
```

API routes (all under `/api`):

| Route                                | Purpose                                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| `GET /search?query=`                 | Search Semantic Scholar                                     |
| `GET /papers`, `GET /papers/:id`     | Library list and one paper                                  |
| `POST /papers/from-search`           | Save a search result                                        |
| `POST /papers/upload`                | Upload a PDF (multipart `file`), extract metadata           |
| `DELETE /papers/:id`                 | Delete a paper, its messages and its stored PDF             |
| `POST /papers/:id/summarize`         | Generate and store a summary                                |
| `GET /papers/:id/messages`           | Saved conversation                                          |
| `POST /papers/:id/ask`               | Ask a question; streams newline-delimited JSON events       |

## Limitations

Known limitations and design trade-offs are listed in [ISSUES.md](ISSUES.md). The Gemini integration
has only been tested against a fake client, so check the model id and your quota on first real use.
Because Google's free tier may use prompts to improve its products, only use public papers.
