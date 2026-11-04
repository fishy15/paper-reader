# Known Issues / Design Notes

## Saving a search result trusts client-supplied metadata
`POST /api/papers/from-search` accepts the full search result (title, authors,
year, abstract, `externalId`, ...) from the client and stores it as-is with
`source: "search"`. The server does not verify it against Semantic Scholar, so a
client could store made-up metadata under a real `externalId`.

The invariant that matters is still enforced: the server hard-codes
`source: "search"`, and the database `CHECK` constraint requires `external_id`
exactly when `source = 'search'`. Uploads go through the separate
`POST /api/papers/upload` route and never carry an `externalId`.

**Why accepted:** this is a local, single-user tool, so tamper-proofing isn't
worth the cost.

**Possible fix:** have the client send only `{ externalId }` and let the server
fetch the metadata from Semantic Scholar. Trade-off: an extra API call per save,
which can hit Semantic Scholar's rate limit (429) even though the paper is
already displayed in the UI.

## Saving a paper that is already saved keeps the stored version
`POST /api/papers/from-search` dedupes on `externalId`. A repeat save returns 200 with the
stored paper and ignores the submitted details, even if the title or other fields differ
(a new save returns 201). The Search page already shows "Saved" for papers in the library, so
a duplicate only happens with a double click, a second tab or a stale results list.

**Why accepted:** a mismatch is rare and low-stakes (at worst a stale title), and a conflict
flow would add an API variant and UI for a case users can almost never reach.

**Possible change:** return 409 with the stored paper when `title`, `authors` or `year` differ,
accept an explicit replace flag, and ask the user (for example with `window.confirm`). Open
questions: which fields count as different (an abstract or open-access `pdfUrl` appearing later
is an improvement, not a conflict), and whether replacing should keep text already downloaded
from the old `pdfUrl`.

## The extracted text stays out of responses only by convention
A paper's extracted text can be up to 400,000 characters and is never meant to reach the client
(`papers.ts` says so). The list route leaves the column out of its `SELECT`. `GET /:id` and the
summarize update load every column and rely on `toPaper` to build the response from named fields.
The types do not enforce this: `toPaper`'s parameter type omits `fullText`, but TypeScript has no
exact object types and does not check properties that arrive through a spread, so a refactor to
`{ ...row, ... }` would compile and send the text with every response. The cost would be size, not
secrecy (this is a local, single-user tool).

**Why accepted:** nothing leaks today, and the response-shape test planned for `papers.test.ts`
would catch a regression.

**Possible fix:** make it impossible by construction. Select the safe columns (`paperColumns`) in
`GET /:id` and in the `returning()` of the summarize update, so the text never leaves the database
layer. Or run responses through the shared `Paper` schema, which strips unknown keys, at the cost of
a parse on every response.

## PDF upload limitations
- **Scanned PDFs are rejected.** Only PDFs with a text layer work; there is no OCR.
- **Duplicate uploads aren't detected.** Uploading the same file twice creates two papers
  (search results dedupe on `externalId`, uploads have no equivalent). A content hash column
  would fix this.
- **The 25 MB limit applies to the whole upload request, not just the file.** `bodyLimit` counts
  the multipart boundaries and headers too, so a file within a few hundred bytes of
  `MAX_PDF_BYTES` gets a 413 even though the message says "limit 25 MB" (checked: a file at
  `MAX_PDF_BYTES - 300` bytes is accepted, `-100` and exactly `MAX_PDF_BYTES` are rejected). Accepted
  because the gap is a few hundred bytes. Possible fix: let `bodyLimit` allow some overhead and check
  `file.size` against `MAX_PDF_BYTES` in the handler.
- **Uploaded PDFs can't be opened from the UI yet.** The file is stored, but there is no
  route serving it, so uploaded papers have no "View" link.
- **Metadata extraction needs `GEMINI_API_KEY`.** Without it, uploads fail with a message
  pointing at https://aistudio.google.com/apikey and nothing is stored.
- **Gemini integration is untested against the live API.** No key was available while building
  it, so the tests use a fake client. Things to check on first real use: that the model id
  (`gemini-3.5-flash-lite`, taken from Google's pricing page) exists for your key, and that the
  JSON schema from `z.toJSONSchema` is accepted.
- **Free-tier data use.** Google's free tier may use prompts to improve its products; only
  upload public papers.
- **Rate limiting is approximate.** Google publishes no fixed free-tier numbers. The limiter
  only spaces requests (`GEMINI_RPM`, default 5/min) and does not track daily quotas or token
  limits; a 429 from Gemini is shown to the user. Check your real limits in AI Studio.
- **Blocked or declined requests fail the upload.** If Gemini blocks a paper, the upload errors
  with the block reason.

## Summaries

- **Search-saved papers are summarized from their `pdfUrl`.** The server downloads it on the
  first summarize request and stores the text. Links that lead to a web page instead of a PDF
  fail with an error, and the paper has to be uploaded manually. The downloaded PDF itself is
  not kept (only its text), so it still can't be opened from the UI.
- **The download follows the stored `pdfUrl` as-is.** Only http(s) is allowed, but nothing blocks
  private or localhost addresses. The URL comes from the client at save time, which is accepted
  for a single-user local tool.
- **Long papers are truncated, not chunked.** Text over 400,000 characters is cut and marked
  `[Text truncated]` for the model; the UI is not told.
- **The truncation cut can split a character outside the basic plane.** `limitPaperText` uses
  `slice(0, MAX_PAPER_CHARS)`, which counts UTF-16 units, so a character such as the math italic 𝑥 that
  straddles the boundary leaves a lone half at the end of the text sent to the model. It needs a paper over
  400,000 characters and bad luck at the boundary, and how Gemini reacts is unchecked. **Fixed:** back
  off one unit when the last kept unit is a high surrogate.
- **A Gemini rate limit during an upload is shown as a 500,** unlike summaries, which return 429.
- **A whitespace-only Gemini response is stored as an empty summary.** `generate` in `llm.ts` checks
  `!response.text` before trimming, so a response of just spaces or newlines passes, `summarize` trims it
  to `""`, and the summary route saves it. **Fixed:** treat a whitespace-only response like an empty
  one and throw the existing "no content" error (with the finish reason), so nothing is saved.

## Q&A

- **Only complete answers are saved.** If the stream fails or the browser disconnects partway,
  neither the question nor the partial answer is stored, so retrying asks the question again.
- **The model sees the last 20 messages.** Older turns stay in the database and on screen but
  are not sent. The whole paper text (up to 400,000 characters) is sent with every question.
- **No way to clear a conversation** yet (it is deleted with its paper).

## Configuration (`.env`)

- **`PORT` has no range check, and whitespace-only values are not treated as unset.** `loadEnv`
  only drops empty strings, so `PORT=" "` becomes 0, `PORT=-1` and `PORT=70000` pass validation, and
  `HOST=" "` is kept as a blank host. The server then fails later at `listen` with a Node error instead
  of a config message. **Fixed:** trim values before the empty check, and accept `PORT` only as an
  integer from 1 to 65535 (0 would pick a random port, and the Vite dev proxy in `web/vite.config.ts`
  is hard-coded to `127.0.0.1:3000`, so a random port could not be followed anyway). Related: because
  of that hard-coded proxy, changing `PORT` or `HOST` in `.env` currently breaks `npm run dev`.
- **A relative `DATA_DIR` resolves against the current directory, and `DATA_DIR` is not in
  `.env.example`.** The scripts run from `server/`, so `DATA_DIR=data` ends up in `server/data`, while
  the default is the repo's `data/`. **Fixed:** resolve a relative `DATA_DIR` against the repo
  root (the same base as the default), leave absolute paths alone, and add `DATA_DIR` to `.env.example`.

## Timestamps

- **`toIsoUtc` accepts any string.** It replaces the first space with `T` and appends `Z`, so a value that
  is already ISO becomes `...ZZ` and an empty string becomes `"Z"`, neither of which is a valid date.
  Nothing hits this today: both callers (`toPaper` and the messages route) pass a column that SQLite fills
  in with `datetime('now')`, and no code writes `createdAt` itself. It would start to matter if someone
  stores an ISO string in `created_at` or changes the default (for example to `datetime('subsec')`).
  **Planned fix:** make the format a type with one checked constructor.
  - A branded type `SqliteTimestamp` (a string in SQLite's `YYYY-MM-DD HH:MM:SS` format), and
    `parseSqliteTimestamp(value: string): SqliteTimestamp`, which asserts the format and throws on anything
    else (an ISO string, an empty string, a date with no time). This is the only place the assertion lives.
  - A drizzle `customType` column for `created_at` on both tables whose `fromDriver` is
    `parseSqliteTimestamp`. Every value read from the database then goes through the constructor, so
    corrupt data or a changed default fails at the read, not later in a response. The `datetime('now')`
    default and the `text` column type stay the same, so no migration should change (check with
    `db:generate`).
  - `toIsoUtc` takes only `SqliteTimestamp`. A plain `string` or a string literal fails to compile, and it
    needs no runtime check, because the type guarantees the format.
  As with `toPaper` for a search paper with no `externalId`, one corrupt row would turn a list response
  into a 500.

## Rate limiter

- **`createRateLimiter` doesn't check `requestsPerMinute`.** The env schema rejects `0`, negatives, `NaN` and
  `Infinity`, so configuration can't produce them, but the function is exported and typed `number`. With `0`
  the interval is `Infinity`, and `NaN` and negatives are worse. With a real timer, Node treats a delay that
  overflows or is `NaN` as 1 ms, so limiting would silently stop. **Fixed:** assert at the start that the
  value is a finite number greater than 0, and throw a `RangeError` otherwise. This is the single place the
  limiter is constructed, so it is defense in depth for the env check.

## Paper search (Semantic Scholar)

- **A bad response body is a 500, not a 502.** In `semanticScholar.ts`, `await res.json()` is not inside any
  try/catch. A 200 with an HTML body, an empty body, or a body read that is aborted by the timeout escapes as a
  raw `SyntaxError` or `DOMException`, and the search route turns it into a 500 with a parser message. The
  `timeoutMs` comment says it covers reading the body. **Fixed:** map those failures to a
  `SearchProviderError` with status 502.
- **Author names in search results are not trimmed or blank-filtered.** `toSearchResult` only drops empty
  names, so `"  Ada "` and `"   "` are kept. The upload route's `cleanMetadata` trims names and drops blank
  ones. **Fixed:** do the same for search results.
- **One malformed result fails the whole search.** An item without a `paperId` makes the response a 502
  ("Unexpected response from Semantic Scholar"). Accepted: a missing `paperId` means the API contract broke,
  such an item could not be saved anyway, and a 502 reports it honestly.

## Web API client

- **An empty `{ error: "" }` shows a blank message.** `ErrorBody` in `web/src/api.ts` accepts any string, so
  a server `throw new Error()` (which `onError` returns as `{ error: "" }`) becomes an `ApiError` with an
  empty message and a blank error in the UI. **Fixed:** require a non-empty string
  (`z.string().min(1)`), so an empty one falls back to "Request failed (N)".
- **A network failure reaches the user as the raw `Failed to fetch`.** The client only wraps failed HTTP
  responses. A fetch that rejects (server down) surfaces as a `TypeError`. **Fixed:** wrap non-abort
  fetch rejections in an `ApiError` with a message like "Could not reach the server", and leave
  `AbortError` unchanged so cancelling a request still works.
- **A connection lost mid-answer also shows the browser's raw error.** If the connection drops while an
  answer is streaming (the server crashes, the network goes), `reader.read()` in `qaStream.ts` rejects with
  the browser's own message (such as "network error" or "Load failed"), and the chat shows it as is.
  **Fixed:** wrap non-abort read failures in an `ApiError` such as "The connection was lost before
  the answer finished", and leave `AbortError` unchanged.

## Web routing

- **Unknown URLs show a blank page.** `App.tsx` has routes for `/search`, `/library` and `/papers/:id` only,
  so `/nope`, `/papers` (no id) and `/papers/1/extra` render the header and an empty `main`, which looks
  broken after a typo. **Fixed:** add a catch-all route that shows "Page not found" with a link to
  Search.

## Web display

- **A year of `0` renders as a literal "0".** `PaperCard.tsx` and `Paper.tsx` use `{paper.year && ...}`, and
  React prints `0` for a falsy number. Nothing produces a year of 0 today (upload turns it into null), but
  the schema allows it. **Fixed:** use a ternary or `!= null` in both places, so a year of 0 shows
  nothing extra.
- **The summarize state leaks between papers.** `Paper.tsx` renders `<PaperDetail id={id} />` with no `key`,
  and the summarize mutation lives in `PaperDetail`, so an error from one paper is still shown after navigating
  to another (checked by probe: a "No PDF link" error from paper 1 stayed on paper 2, while the chat draft did
  reset because `Chat` has `key={id}`). A pending "Summarizing…" state would carry over the same way.
  **Fixed:** put `key={id}` on `PaperDetail`. The `key` on `Chat` is now redundant but was left in place.
- **`PaperDetail` repeats `PaperCard`'s markup.** Both render the title with the year, the byline, and the PDF
  and Semantic Scholar links, so the same logic (and the year-of-0 bug above) exists twice, and the same
  optional-field tests are needed in both files. **Planned refactor:** extract a shared component for the
  header (title, year, byline, links) and use it in `PaperCard` and `PaperDetail`. The detail page shows the
  abstract expanded under its own heading and has a summary section, so the shared piece is the header, not
  the whole card. After it, the optional-field tests live once, in the shared component's tests.

## Web chat

- **`ask` can be called while an answer is already streaming.** `useAskQuestion` overwrites the controller
  without aborting the old request, so the first call's `finally` sets `streaming` to false and clears the
  turn while the second request is still running (the `controller.current === abort` check only stops it
  from clearing the new controller). The Chat form prevents this (the input is disabled and `onSubmit`
  checks `streaming`), but the hook itself allows it. **Fixed:** ignore a second `ask` while one is
  in flight, returning `false` and checking the controller ref, not React state. That also makes the race
  branch at `useAskQuestion.ts:53` unreachable.

## Web upload

- **Extra dropped files are silently ignored, and a drop during an upload starts another upload.**
  `UploadBox.tsx` uploads `files[0]` and ignores the rest without telling the user. The drop zone also
  stays active while an upload is pending (only the button is hidden), so a second drop starts a second
  upload. **Fixed:** ignore drops while an upload is pending, and show a short notice when several
  files are dropped (for example "Only paper.pdf was uploaded"). One file per request fits the free-tier
  rate limit, so uploading all of them is not planned.

## Web search

- **Retrying the same query after an error does nothing.** `Search.tsx` keys the search query on the
  submitted text, so pressing Search again with the same text changes nothing: no new request is made and
  the error stays (checked by probe: a "Rate limited" error stayed after a second press, with one request in
  total). A 429 says "try again shortly", so the user has to edit the query or reload to retry.
  **Fixed:** when the trimmed query equals the submitted one, call `results.refetch()`.
- **A failed save's error survives a new search.** The save mutation's error is not cleared when a new
  search is submitted, so "Could not save" stays under unrelated results (checked by probe).
  **Fixed:** call `save.reset()` when a search is submitted.

