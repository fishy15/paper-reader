# Testing notes

## Coverage gaps

What each uncovered line or branch in the `npm run coverage` report corresponds to. Some entries are
lines that never ran; others are lines where only one side of a branch ran (for example
`useAskQuestion.ts` 48-53 has 100% line coverage but not branch coverage).

Snapshot from the first coverage run:

|            | Statements | Branches | Functions | Lines  |
| ---------- | ---------- | -------- | --------- | ------ |
| **server** | 94.08%     | 90.34%   | 93.84%    | 94.98% |
| **web**    | 98.45%     | 95.10%   | 96.66%    | 99.37% |

Paths are relative to `server/src` or `web/src`.

### Behavior with no test (worth covering)

| Location                            | What it is                                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/app.ts:22`                  | The `notFound` handler. No test requests an unknown route and checks for a JSON 404.                                                                  |
| `server/routes/papers.ts:74`        | `DELETE` for a paper that doesn't exist returns 404.                                                                                                  |
| `server/routes/upload.ts:81-82`     | If saving to the database fails after the PDF is written to disk, the file is deleted and the error re-thrown. A cleanup path with no test.            |
| `server/routes/qa.ts:72-73`         | The client disconnects mid-stream, so the server stops pulling from the LLM generator (`answer.return`).                                              |
| `server/services/semanticScholar.ts:99` | An upstream non-OK status other than 429 maps to 502. Only the 429 case is tested.                                                                |
| `web/components/UploadBox.tsx:33`   | Clicking "Choose file" to open the picker. Tests use `user.upload` and drop events, so this `onClick` never runs.                                     |
| `web/useAskQuestion.ts:48`          | The request fails with something that isn't an `Error`, so `String(err)` is used.                                                                     |
| `web/useAskQuestion.ts:53`          | A newer question replaces `controller.current`, so the old request must not clear it. This is a race. Planned fix and test: see the `useAskQuestion.test.tsx` section.                                                 |
| `web/components/Chat.tsx:17`        | The submit guard (`!question \|\| streaming`). The UI can't reach it (Ask is disabled for blank input, and the button is Stop while streaming), so drive it with `fireEvent.submit`. Planned: see the `Chat.test.tsx` section. |
| `web/pages/Search.tsx:53`           | A save in flight for a different paper must not disable this paper's Save button.                                                                     |
| `server/services/rateLimiter.ts:12` | The default real clock (`Date.now`, `setTimeout`). Every test injects a fake clock. Now planned: see the `rateLimiter.test.ts` section. |
| `web/api.ts:80` | A 200 response with no body gives "The server sent an empty response". Testable with `new HttpResponse(null)`. Now planned: see the `api.test.ts` section. |

Effort: mostly small tests. The `useAskQuestion.ts:53` race and the disconnect case at `qa.ts:72-73`
are the most work.

### Unexpected errors passing through

`server/routes/qa.ts:42` and `:62`, `server/routes/summary.ts:26` and `:34`, and
`server/services/paperText.ts:33` are each a `throw err` for errors that aren't the expected kind (not a
`PaperTextError`, a rate limit, or a `PdfDownloadError`). If the LLM or PDF code throws something
unexpected, the app should respond with a 500, but no test checks that. Cheap to cover.
The `qa.ts:62` case has its own planned test with details under
"More edge cases in `server/src/routes/qa.test.ts`".

### Probably not worth testing

- **`server/routes/papers.ts:29`**: guard for a "search paper with no `externalId`". The database `CHECK`
  constraint (`source_external_id`) already makes that state impossible.
- **`server/db/schema.ts:35`**: the `() => papers.id` foreign-key callback. Drizzle only calls it when
  generating migrations, not at runtime.
- **`server/db/client.ts:17`**: creating the directory for a file-based database. Tests always use `:memory:`.
- **`server/services/llm.ts:109`**: constructing the real `GoogleGenAI` client. Tests use fakes on purpose.
- **`web/qaStream.ts:37`**: the `?? ""` fallback after `lines.pop()`. `split` always returns at least one
  element, so it's dead code.

## Planned test additions

### More edge cases in `server/src/app.test.ts`

The file has one test (an unexpected error becomes a 500 with the real message and is logged).

- A malformed JSON body returns 400 through the `HTTPException` branch of `onError` (`app.ts`). Send `{bad`
  with a JSON content-type to `POST /api/papers/from-search`. Assert status 400, an `{ error: string }`
  body, and that `console.error` was not called. No test reaches this branch today, so removing it would
  turn every malformed request into a 500.
- Extend the planned notFound test (`app.ts:22`, listed under coverage gaps) into `it.each` over an unknown
  path, a wrong method on a known route (for example `DELETE /api/search`, since Hono has no 405
  handling), and a path without the `/api` prefix. Also assert the JSON content-type on those 404s and on
  the existing 500 test.
- A thrown non-`Error` value (for example `throw "boom"`). Hono's `compose` only calls `onError` when
  `err instanceof Error`, so a non-`Error` value would skip our handler, and the `{ error }` 500 shape would
  not apply. This is from reading Hono's source, not from running it. Run it first to see what actually
  happens, then pin that behavior. The test needs a cast, because `makeApp` types `search` as
  `Promise<never[]>`.

Skipped on purpose: route mounting (every route test goes through `createApp`, so a wrong prefix already
breaks them), "no stack in the 500 body" (the existing `toEqual` covers it), and "next request still works
after a 500" (the handler holds no state).

### More edge cases in `server/src/routes/papers.test.ts`

- A repeat save keeps the stored paper. Post a second paper with the same `externalId` but a different
  title. Assert 200, the same `id`, the original title, and a list length of 1. The existing dedupe test
  checks only the status and the list length. This pins the behavior recorded in `ISSUES.md` (a repeat save
  keeps the stored version), so a later change to overwrite or return 409 is deliberate.
- DELETE returns `{ ok: true }`. Removing the PDF file on delete (`papers.ts:75`) is already tested in
  `upload.test.ts` ("deletes the stored PDF file together with the paper"), through the upload route, so it
  needs no separate test here.
- DELETE succeeds when the PDF file is already missing. The row points at a file that doesn't exist and
  the DELETE still returns 200, which covers `fs.rm(..., { force: true })`. The paper row is deleted
  before the file is removed, so a failure here would leave the database changed while the client sees
  an error.
- Response shape. Assert the whole body with `toEqual` on the save, list and `GET /:id` responses:
  `source: "search"`, `externalId`, `hasPdf`, `summary: null`, and a `createdAt` matching an ISO-UTC
  regex. Seed a paper with `fullText` and a `localPdfPath` and assert neither appears in the body and
  that `hasPdf` is true. `GET /:id` selects every column and relies on `toPaper` to drop `fullText`.
- The list is newest first (`orderBy(desc(papers.id))`). Save three papers with distinct `externalId`s and
  check the ids come back descending. Give two of them the same title to confirm that dedupe is by
  `externalId`, not title.
- Optional and unusual values round-trip: `year: null`, `pdfUrl: null`, `authors: []`, a non-null
  `abstract`, and a non-ASCII title and author. This covers the JSON-stored `authors` column and the
  nullable fields, none of which the current sample exercises.
- Strengthen the existing tests (no new tests): make `GET /:id` compare the body (`id` and `title`), not
  just the status, and save two papers, delete one and check the other remains. The "saves, lists, fetches
  and deletes" test mixes four behaviors, so also split it into separate tests.

Skipped on purpose: a search save colliding with an upload row. Upload rows have a null `externalId` and
the database `CHECK` constraint forbids a search paper without one, so there is nothing to collide.

### More invalid-input tests in `server/src/routes/papers.test.ts`

The file has one invalid-input test (empty title). Planned additions, as a table-driven test with `it.each`.
Every rule and boundary of the schema is tested in the `schemas.test.ts` section below, so here one
representative row per category is enough, to confirm that validation is wired up to the route.

**`POST /api/papers/from-search`** (schema: `SearchResult` in `shared/src/schemas.ts`)

- Missing or empty `externalId`. The route dedupes on it and the database `CHECK` needs it for search papers.
- One representative per schema category: a wrong type (`year` as `"2017"`), a malformed URL (`pdfUrl` set to
  `"not a url"`), an over-length field (a 2001-character title), and a missing required field (`{}`, and a body
  with `abstract` omitted, because `nullable` fields are still required).
- Malformed bodies are not repeated here. Invalid JSON is in the `app.test.ts` section (it exercises
  `onError`), and a missing content-type or a non-object body is in the `validate.test.ts` section.
- Error shape: the 400 body is `{ error: "Invalid request (...)" }` and names the failing field, not just
  the status.
- No side effects: after a rejected request the list is still empty.

**`GET` and `DELETE /api/papers/:id`** (`IdParam` is a positive integer)

- Bad ids (`abc`, `0`, `-1`, `1.5`) return 400.
- A valid id that doesn't exist returns 404 for both methods. DELETE-404 is also listed under coverage
  gaps (`papers.ts:74`).

### More edge cases in `server/src/routes/qa.test.ts`

Compared with `qa.ts`. Unexpected-error rethrows (`qa.ts:42`, `62`) and client disconnect mid-stream
(`72-73`) are already under coverage gaps.

**Higher value**

- The model returns nothing. If the generator yields no chunks, the route saves an empty assistant message
  (`content: ""`) and sends only `done`. Decide whether that is intended and test it.
- Long paper text is truncated. The model should get truncated text ending in `[Text truncated]`.
  `paperText.test.ts` tests `limitPaperText` itself, but no route test checks the wiring.
- A chunk containing a newline. The stream is NDJSON split on `\n`, so a delta like `"line1\nline2"` should
  arrive intact as one event.
- Search papers without saved text. Missing: a download failure mapping to 502, a corrupted PDF mapping to
  422, and a second ask reusing the stored text without downloading again. Only the "no PDF link" 422 is
  tested now.
- History only includes this paper's messages. The history query in `/ask` filters with
  `where(eq(qaMessages.paperId, id))`, and no test covers that. The existing "per paper" test checks the
  separate `GET /messages` query, and the default fake LLM never looks at `history`. Without the filter, other
  papers' conversations would go into this paper's prompt and every test would still pass. Insert messages
  with distinct text for papers A and B, ask on A with a mock `answer`, and assert `history` has A's
  messages and none of B's.
- A failure before the first chunk that is not a rate limit returns 500 (`qa.ts:62`, also listed under
  unexpected errors). The mock generator throws a plain `Error("boom")` before yielding, as a missing
  `GEMINI_API_KEY` does in `llm.ts`. Assert status 500, body `{ error: "boom" }`, a JSON content-type (not
  `application/x-ndjson`, so no stream was opened), nothing saved, and that `console.error` was called
  (silence it with a spy). This is the third outcome next to the 429 test and the mid-stream test.

**Boundaries and validation**

- History boundary. Only `HISTORY_MESSAGES + 4` is tested. Add exactly 20 and 21 messages, and a history
  shorter than the limit but not empty.
- More invalid questions and ids on `/ask`: `question` as a number or `null`, invalid JSON, a missing
  content-type, and ids `0`, `-1`, `1.5` (only `abc` is tested).
- Strengthen the test "validates the id and question, and 404s for a missing paper" (line 126). It has five
  assertions across three behaviors and checks only status codes, so a failure doesn't say which case broke
  and a 400 could come from the wrong validator (the bad-id case sends no body at all). Turn it into
  `it.each` rows (blank, over-long, missing question) that assert the 400 body names `question`. Make the
  missing-paper 404 and the bad-id 400 (matching `/id/`) separate small tests. The extra cases above become
  more rows. Keep the literal `4001`.
- Bad id on `GET /:id/messages`. The `IdParam` validation on that route has no test.
- Message response shape: `createdAt` is a valid ISO timestamp, and `id` and `paperId` are present. Also run
  each message through `QaMessage.parse` from `shared`. That schema is only used as a type today, and the
  `messages()` helper casts with `as QaMessage[]`, which checks nothing. `createdAt` is a plain string
  there, so keep the ISO regex.

Not planned: concurrent asks on the same paper. Each pair is saved in one synchronous insert, so the two
rows stay adjacent.

Skipped on purpose:
- A rate-limit error after the first chunk. The 429 test and the mid-stream test cover both branches, and
  the stream's `catch` doesn't check the error type.
- Checking the database from inside the generator to show a message is saved only after the full answer.
  The failure tests already prove nothing is saved when a request fails.
- The paper `title` reaching the LLM. The first test already asserts `title: "A Paper"`. Optionally give
  that test paper a distinctive title so a hard-coded value would fail.
- A search paper with `fullText` set using it without downloading. The planned "reuses the stored text" test
  and `paperText.test.ts` cover it.
- An invalid body on a missing paper returning 400 rather than 404. It pins an arbitrary order that nothing
  depends on.

### More edge cases in `server/src/routes/search.test.ts`

The file has five tests. The route validates `query` (trimmed, at least 1 character) and `limit` (an integer
from 1 to 50, default 20).

- Accepted limit boundaries. The tests reject 0 and 51 but only accept 5, so a schema changed to `.min(2)` or
  `.max(49)` would still pass. Use `it.each` over `limit=1` and `limit=50` and assert the provider receives
  exactly that number.
- Other `limit` formats, in one `it.each` table (not one test per format), pinning today's behavior. I probed
  these against the real route: `limit=` (empty) gives 400, a repeated `limit=3&limit=4` gives 400, and
  `%205` (a leading space) gives 5, `5.0` gives 5, `1e1` gives 10, `0x10` gives 16. The accepted ones come
  from `z.coerce.number()` using `Number()`. The existing rejected-inputs table keeps `0`, `51`, `1.5` and
  `x`, and the empty `limit=` row lives only in this new table so nothing is checked twice. Decide whether
  hex and exponent forms should be accepted. Pinning them makes a later change deliberate.
- Query special characters arrive decoded, in one table. Probed results: `a%26b%20c` gives `a&b c`,
  `c%2B%2B` gives `c++`, and `a%20%20b` keeps its inner spaces (`a  b`). Add a Unicode query. Also pin that
  a raw `?query=c++` reaches the provider as `c`, because an unencoded `+` is a space and the ends are
  trimmed, so clients must encode it as `%2B`.

**Strengthen the existing tests**

- Rejected-inputs table: carry the expected field for each row and assert the 400 message names `query` or
  `limit`, not just `Invalid request`.
- Provider errors: the 429 and 502 loop is inside one `it`. Use `it.each` so a failure names the status.
- "does not swallow unexpected errors" doesn't silence `console.error`. A verbose run shows
  `stderr | ... Error: boom` in the output. Add a silenced spy and assert it was called with the error, which
  also shows `onError` handled it. This ties into the restore-mocks cleanup.
- "trims the query and passes an explicit limit" has the provider return `[]`. Also assert the status is 200
  and the body is `[]`, which covers the empty-results case.

Skipped on purpose:
- A later request working after an error. The route holds no state.
- POST (or another method) to `/api/search` returning 404. It is already in the `app.test.ts` plan, in the
  wrong-method row of the notFound `it.each`.
- The response being JSON or passing through extra fields. `c.json` does that and the route doesn't
  re-validate, so a test would only restate the code.
- The provider being called with `("a", 20)` on the error path. The first test already checks the arguments.

### More edge cases in `server/src/routes/summary.test.ts`

The file has eight tests and is the strongest of the route files. The rethrows at `summary.ts:26` and `34`
are already under coverage gaps.

- A rate limit after a successful download keeps the stored text. `loadFullText` stores the downloaded text
  before the LLM call, and the free-tier limit makes a 429 right after a download likely. The first call
  downloads and gets a 429. Assert `fullText` is stored. Then a retry with a working LLM succeeds with no
  second `fetch`. Today the "downloads once" test only covers an LLM that succeeds.
- Summarizing one paper leaves other papers' summaries alone. The update uses `where(eq(papers.id, id))`.
  Without it every paper's summary would be overwritten, and all current tests use one paper. Insert two
  papers, summarize one and assert the other's `summary` stays null.
- Extend the planned rethrow test (`summary.ts:34`, any non-rate-limit LLM error becomes a 500): also assert
  the old summary, or null if there was none, is unchanged. The 429 test already covers that for rate
  limits. For the `summary.ts:26` rethrow (an unexpected error while loading the text), assert nothing was
  stored.

**Strengthen the existing tests**

- The download-failures test loops four cases inside one `it` and re-spies on `fetch` each time. Use
  `it.each` so each case gets a fresh app and a named failure.
- Split "returns 404 for a missing paper and 400 for a bad id" into two tests.
- In the downloads-once test, replace `toContain("Body of the paper")` with `toBe(...)` for the
  single-page text.
- Remove the file-level `afterEach(() => vi.restoreAllMocks())` once `restoreMocks: true` is in the server
  config (see Cleanups).

Skipped or moved:
- Exact page joining and trimming of a downloaded PDF, the stored text not being truncated, and text exactly
  `MAX_PAPER_CHARS` not being marked. These test `loadFullText` and `limitPaperText`, so they belong in
  `paperText.test.ts`. The route's existing truncation test already checks that the cut reaches the LLM.
- More bad ids. The route uses the shared `IdParam`, covered once in the `papers.test.ts` plan.
- Non-PDF content-type or redirect handling. `pdfDownload.test.ts` covers it, and the existing "did not
  return a PDF" case reaches it from the route.
- The response having no `fullText`. The response-shape item in `papers.test.ts` covers `toPaper`, and the
  cleanup below would enforce it by construction.
- Regenerate re-sending the same text. The route sends only the paper text and never the old summary, so
  regeneration already starts from scratch. Don't pin the input, so regeneration stays free to change
  (different prompt, temperature, and so on).

### More edge cases in `server/src/routes/upload.test.ts`

The file has nine tests. The cleanup when the database insert fails after the file is written
(`upload.ts:81-82`) is already under coverage gaps.

- The saved row and file match the upload. The existing test only checks that one file exists in `pdfs/`.
  Read the row and assert `fullText` is all pages joined and trimmed, `localPdfPath` is relative and matches
  `pdfs/<uuid>.pdf` (the code says paths are relative so the database stays portable), and the file's bytes
  equal the uploaded bytes. Q&A and summarize depend on that `fullText`.
- Year boundaries, in one `it.each` table. Only `20217` is tested. Cases: `0` ("not stated") and `999`
  become null, `1000` and next year are kept, the year after next, `2021.5` and `NaN` become null. The upper
  bound depends on today, so fix the clock with `vi.setSystemTime`.
- Title fallbacks, in one `it.each` table. Only `my-notes.pdf` is tested. Add `UPPER.PDF` giving `UPPER` (the
  regex is case-insensitive), and `.pdf` and an empty name giving `Untitled`. Also pad an author name in the
  first test (`"  Ada Lovelace "`) to check trimming.
- Metadata input is capped at 12,000 characters. The test checks the 2-page limit but not
  `METADATA_MAX_CHARS`. Upload a page with more than 12,000 characters and assert the string sent to
  `extractMetadata` is at most 12,000.
- A non-file `file` field returns 400 naming `file`. The current test sends an empty form and checks only the
  status. Use `it.each` over "no field" and "`file` sent as text", and assert the error body names `file`.
- Two uploads of the same file stay independent. Upload the same file twice and expect two rows and two
  files. Delete one and check the other's file still exists. This would catch a stored path derived from the
  name or contents.
- A file just under the limit is accepted. Probed against the real route: files at `MAX_PDF_BYTES - 10,000`,
  `-1,000` and `-300` bytes get 201, while `-100` bytes and exactly `MAX_PDF_BYTES` get 413. `bodyLimit` counts
  the whole multipart body (boundaries and headers), so the effective file limit is a few hundred bytes under
  the stated 25 MB. It is tiny in practice, but the error says "limit 25 MB". The test uploads a valid PDF
  padded to `MAX_PDF_BYTES - 1000` and expects 201. The few-hundred-byte gap is an accepted design decision
  (recorded in `ISSUES.md`), so also pin the current edge: a file of exactly `MAX_PDF_BYTES` gets 413. If the
  limit is later changed to apply to the file alone, that test is the one to update.

**Strengthen the existing tests**

- "rejects files over the size limit": also assert the body is `{ error: "PDF is too large (limit 25 MB)" }`.
- "rejects corrupt PDFs": also assert the message matches `/Could not read/`.
- The first test covers storage, trimming, the blank-author filter, the 2-page limit and the list in one
  `it`. It is acceptable, but splitting it would give clearer failures.
- "stores nothing when metadata extraction fails" restores the spy at the end of the test body. This is
  covered by the restore-mocks cleanup.

Skipped on purpose:
- A single-page PDF. `slice(0, 2)` can't break on one page.
- An encrypted PDF. It needs a fixture and reaches the same 422 branch as the corrupt test.
- Q&A or summarize using the upload's stored text. The saved-row item covers the text, and those routes'
  tests insert `fullText` directly.

### More edge cases in `server/src/schemas.test.ts`

The file has six tests on the shared zod schemas. Only some of them run at request time: `SavePaperInput`
(from `SearchResult` and `PaperMetadata`) validates `POST /from-search`, `QaInput` validates `POST /:id/ask`,
and `QaStreamEvent.parse` is used by the web stream reader. `Paper` and `QaMessage` are never parsed at
runtime, they only provide types.

- Size limits, both sides of each boundary, in one `it.each` table of `[field, accepted at the limit,
  rejected one over]` using literals: title 2000/2001, one author 500/501, authors 1000/1001, abstract
  50,000/50,001, `url` and `pdfUrl` 2048/2049, `externalId` 200/201. Also `pdfUrl: "not a url"`. Today only title
  2001 and 1001 authors are tested, and only over the limit. This replaces the existing test that loops four
  unrelated rules in one `it`.
- Nullable fields are still required, and types are strict. Omitting `abstract`, `year` or `url` must fail
  (`nullable` is not `optional`), so a client has to send an explicit `null`. Also `year: "2020"`, `authors`
  as a string, and `authors: [1]`.
- `QaInput` trims before it checks the length (`.trim().min(1).max(4000)`). A question of 4000 characters
  padded with spaces is accepted, `"\n\t "` is rejected, and inner newlines are kept. Trimming first keeps a
  pasted question with a trailing newline from being rejected, and it is required for the minimum check
  (three spaces would otherwise pass `min(1)`). Keep the literals.
- `QaStreamEvent` edge rules the web reader depends on: an empty `text` is accepted, and `error` without
  `message`, a non-string `text` and a missing `type` are rejected. The web `qaStream.test.ts` keeps only the
  reader's behavior (an unreadable line becomes an error), not these rules again.

**Strengthen the existing tests**

- Most assertions are `.success === false`, which passes for the wrong reason. For example,
  `SavePaperInput.safeParse(metadata)` fails because `externalId` and `pdfUrl` are both missing, and the test
  can't tell. Assert the failing issue paths (for example `["externalId"]`) through a small helper.
- Leave the `Paper` test as it is. It documents the shape of a type only used at compile time.

Skipped on purpose:
- `QaMessage` strictness. It is never parsed at runtime. The planned `QaMessage.parse` in the `qa.test.ts`
  route test is what gives it a job.
- `Paper` strictness (non-integer id, missing fields, an upload with an `externalId`). Same reason. If
  responses are ever parsed with `Paper` (the second option in the `fullText` note in `ISSUES.md`), revisit.
- Unknown keys being stripped. That is zod's default, and the routes build values field by field.
- A JSON round-trip of each event. The `qa.test.ts` helper `readEvents` already parses real route output
  with `QaStreamEvent.parse`.
- The `ZodError` path format. It belongs to `validate.test.ts`.
- `Paper.pdfUrl` having no length cap and `Paper.externalId` no min or max, unlike `SearchResult`. Harmless:
  stored values come from validated input, and `Paper` is only a type.

### More edge cases in `server/src/validate.test.ts`

The file has four tests on the `validate` wrapper around Hono's `zValidator`. I probed the real wrapper in a
standalone Hono app for the cases below.

- Malformed JSON and an empty body (with a JSON content-type) return 400, but as `text/plain`
  ("Malformed JSON in request body"), not the `{ error }` JSON. Hono's validator throws its own
  `HTTPException` before our hook runs, so `validate`'s `{ error }` shape doesn't apply. In the real app
  `onError` in `app.ts` turns it into `{ error }` JSON (see the `app.test.ts` section). This difference is
  accepted. Assert a 400 whose body matches `/malformed/i` (not Hono's exact wording), so the behavior is
  pinned. The doc comment on `validate` ("the same `{ error }` body as every other failure") overstates
  this. Leave it, or reword it (a source change, ask first).
- A missing or non-JSON content-type with valid JSON gets a field-level 400 (`name: ...`), because the body
  is treated as empty. A client that forgets the header sees which fields are missing.
- An array index in the path. With a schema using `z.array(z.string())` and input `["a", 1]` the message
  names `items.1:`. This is how a user would be told which author entry is wrong. It needs a second route in
  the test app.

**Strengthen the existing tests**

- Replace the `toContain` checks with a regex that pins the separator, parentheses and order, for example
  `^Invalid request \(name: .+; nested\.n: .+\)$`. Don't hardcode zod's wording, which changes between
  versions. Also assert the JSON content-type.
- The query success test only checks the status. Use `z.coerce.number()` and assert the handler receives a
  number, since routes rely on the parsed value (search `limit`, `QaInput` trimming).
- Split "validates query strings", which holds one success and one failure.

Skipped on purpose:
- A missing nested object, such as `{ name: "a" }` without `nested`. The path is one segment, the same branch
  as `name:`, and the existing tests already cover one segment (`name:`), several (`nested.n:`) and none
  (`json:`). Only zod's message wording differs.
- Other targets (`param`, `form`, `header`). Each target the app uses already goes through `validate` in a
  route test: `param` through the bad-id tests, `form` through the upload "no file" test, and `query` and
  `json` also directly here. The target-name fallback only appears when the root value is not an object, which
  only happens for `json`. The planned body assertions (`/id/`, `file`) pin the prefix in those route tests.
- A handler not running after a failure. A 400 from the hook means Hono never reaches the handler.
- Symbol keys in paths. No schema here has them.

### More edge cases in `server/src/env.test.ts`

The file has five tests on `loadEnv`. Every one passes a hand-made object, and the rejected-values test only
checks that something throws. `index.ts` calls `loadEnv()` at startup, the server scripts load `../.env` with
`--env-file-if-exists`, and `.env.example` has blank lines such as `GEMINI_API_KEY=`, which become empty
strings. I probed the current behavior: `PORT=0`, `-1` and `70000` are accepted, `PORT=" "` becomes 0,
`HOST=" "` is kept, `GEMINI_RPM=Infinity` and `NaN` are rejected, `0.5` is accepted, and an undefined value
falls back to the default. The thrown error is a raw JSON dump of the zod issues that includes the variable
name in `path`.

**Tests for the planned code changes** (recorded under "Configuration" in `ISSUES.md`). These describe the
fixed behavior, so they fail until the schema is changed, which needs approval first.

- `PORT` range, in one `it.each` table: `0`, `-1`, `70000` and `1.5` are rejected, `1` and `65535` are
  accepted.
- Whitespace-only values count as unset: `PORT=" "`, `HOST=" "` and `GEMINI_RPM=" "` give the defaults.
- A relative `DATA_DIR` is resolved against the repo root, and an absolute one is left alone.

**Tests that pass today**

- `loadEnv()` with no argument reads `process.env`. Every test passes its own object, and the default
  parameter is the real startup path. Use `vi.stubEnv("PORT", "4321")` and `vi.unstubAllEnvs()`.
- The repo's `.env.example` loads. Parse its `KEY=value` lines (ignoring comments) and run them through
  `loadEnv`. Assert it doesn't throw, blank values come back as defaults or undefined, every key in the
  file is a key the schema knows, and every schema key appears in the file. The last check fails until
  `DATA_DIR` is added to `.env.example`, which belongs to the second planned fix.
- Unrelated variables are ignored. In real use `process.env` is full of them. Pass `{ PATH: "/x", FOO: "bar" }`
  and assert no throw and no extra keys. Every current test passes only known keys, so a `.strict()` change
  would go unnoticed.
- The `DATA_DIR` default points at the repo's `data/`. The current test only checks the path is absolute, so
  a wrong relative step would pass and the database would silently be created elsewhere. Assert something
  that doesn't repeat the code, such as the parent of the default containing `server/package.json`.

**Strengthen the existing tests**

- Rejected values: `it.each` rows that assert the error names the variable (`/PORT/`, `/GEMINI_RPM/`). Add
  `GEMINI_RPM` of `Infinity` and `NaN`, which are rejected today.
- Empty strings: one table over every key (`DATA_DIR`, `GEMINI_MODEL`, `GEMINI_RPM`, `S2_API_KEY`, as well
  as the three already covered), plus an `undefined`-valued key as a row.
- Coercion: add `GEMINI_RPM=0.5` (accepted, so rates below one per minute work).

Skipped on purpose:
- The `GEMINI_MODEL` default. It pins a model id that is expected to change.
- The source object not being mutated. The code builds a new object.
- A rate limiter receiving `0`, `NaN` or `Infinity` from configuration. `GEMINI_RPM` rejects all three, so
  those inputs are unreachable from `.env`.

### More edge cases in `server/src/db/time.test.ts`

The file has two tests on a one-line function. `toIsoUtc` has two callers (`toPaper` and the messages
route), and both pass a column that SQLite fills in with `datetime('now')`. The tests only use hand-typed
strings.

- Real SQLite timestamps. Use `it.each` over `papers` and `qa_messages`: insert a row without `createdAt`,
  read it back, pass it through `toIsoUtc`, and assert the ISO-UTC shape and that the instant is within a few
  seconds of `Date.now()`. Closeness to now is what catches a mistake: a column default changed to
  `datetime('now', 'localtime')` still matches the regex but is off by hours. It also covers both column
  defaults, which are separate expressions. The `createdAt` checks in the `papers.test.ts` and `qa.test.ts`
  shape items stay regex-only, so this isn't repeated there.

**Tests for the planned code change** (recorded under "Timestamps" in `ISSUES.md`). The format is a branded
`SqliteTimestamp` type with one checked constructor, `parseSqliteTimestamp`, used as the `fromDriver` of the
`created_at` columns, and `toIsoUtc` takes only that type. These tests fail until `time.ts` and the schema
are changed, which needs approval first.

- The constructor accepts `"2026-10-08 12:00:00"` and returns it unchanged.
- The constructor throws, in one `it.each` table, for an already-ISO string (`"2026-10-08T12:00:00Z"`), `""`,
  `"not a date"` and a date with no time.
- Reading a corrupt row fails at the read. Insert a row with a raw SQL statement that sets `created_at` to
  an ISO string, then select it through drizzle and assert it throws. This shows the check runs at the
  database boundary, before any response is built.
- Type-level checks, written as `// @ts-expect-error` lines: `toIsoUtc` called with a plain `string` or a
  string literal does not compile, and inserting a plain `string` into `created_at` does not compile. A
  positive case passes the constructor's result and a row's `createdAt` and compiles. `tsc` reports an error
  if one of the expected-error lines starts to compile.

`server/tsconfig.json` includes `src`, so `npm run typecheck` (`tsc --noEmit`) checks the type-level lines.
`vitest run` does not type-check, so only `typecheck` enforces them. The real-SQLite test above also
verifies the default: a changed format (for example `datetime('subsec')`) now throws at the read, in
addition to failing the shape assertion.

Skipped on purpose:
- Year and midnight boundaries. It is a string replace with no date arithmetic.
- Only the first space being replaced. It would pin behavior for input that can't occur.

### More edge cases in `server/src/services/llm.test.ts`

The file has ten tests using fake Gemini clients. In production `index.ts` passes no `acquire`, so the rate
limiter comes from the default parameter `acquire = createRateLimiter(requestsPerMinute)`, and every test
injects its own.

- Non-429 errors pass through unchanged. `toLlmError` should convert only a 429. Use `it.each` over `ApiError`
  statuses (400, 401, 403, 500, 503) and a plain `Error`, and assert the same error object is rethrown and is
  not a `LlmRateLimitError`. Cover `extractMetadata` and `answer`, before and during the stream. If the
  mapping became too broad, an invalid API key (401 or 403) would show as "rate limit reached". Only 429 is
  tested today.
- The default rate limiter is wired in. Use fake timers: call `createLlm` without `acquire` and with
  `requestsPerMinute: 60`, and assert a second immediate call stays pending until one second passes. This
  protects the only place production rate limiting is connected.
- Closing the answer early stops the Gemini stream. When the browser disconnects, `qa.ts` calls
  `answer.return()` (the `qa.ts:72-73` gap). Pull one chunk, call `return()`, and assert the source stream's
  cleanup ran and no more chunks were requested. `for await` closes the SDK stream on early exit, so this
  checks the Gemini request actually stops.
- A block in the middle of a stream. Only a block on the first chunk is tested. Send a text chunk and then a
  blocked chunk, and assert the text arrived and then the "declined" error is thrown.
- The finish reason survives later chunks. The code keeps `finishReason` across chunks (`?? finishReason`),
  and with one chunk a regression to `?? "unknown"` would pass. Send `[reason SAFETY, {candidates: []}, {}]`
  and assert the error says SAFETY. Also assert an empty stream says "unknown", and the same fallbacks for
  `generate` (a reason on the candidate, and "unknown" without one).
- "Not stated" values are accepted. The model reports a missing year as `0` and a missing abstract as `""`,
  and `upload.ts` turns those into null. If `year` gained `.positive()`, a legitimate `0` would fail every
  upload. Also reject `year: "2021"` and a missing `authors`.
- A missing key doesn't consume the rate limiter. `getClient()` runs before `acquire()`. With no key, assert a
  spy `acquire` is never called. For `answer`, assert a rejecting `acquire` propagates and no request is
  made.
- System prompts keep the untrusted-text instruction. One table over metadata, summarize and answer: the
  system instruction contains `untrusted`, and the paper text is wrapped in `<paper_text>`. For `answer`, also
  assert the paper text is in the system instruction and not in the user turns. This guards the
  prompt-injection defense from accidental deletion.
- A whitespace-only response is treated as no content. This tests the planned fix recorded under "Summaries"
  in `ISSUES.md`: a response of spaces or newlines throws the "no content" error with the finish reason and
  nothing is returned. It fails until `generate` is changed, which needs approval first.

**Strengthen the existing tests**

- The four-case failure loop (blocked, empty, bad JSON, schema mismatch) sits in one `it`. Use `it.each`.
- "maps HTTP 429" covers two methods in one `it`. Use `it.each` over `extractMetadata` and `summarize`, and
  assert the message matches `/rate limit/i`, since it is the text shown to users.
- Give the summarize test a multi-paragraph sample so trimming inner newlines would fail it.
- Split "skips chunks without text and waits for the rate limiter", which tests two things with an awkward
  mock wrapper.

Skipped on purpose:
- Client reuse. It has no observable behavior.
- Paper text containing `</paper_text>`. A test would pin a known limit of the delimiter approach, and the
  trust model in `ISSUES.md` already says to upload only public papers.
- Answer with an empty history. The first answer test covers the same code.

### More edge cases in `server/src/services/paperText.test.ts`

The file has eight tests. Two ideas from the `summary.test.ts` review are already covered here: text of exactly
`MAX_PAPER_CHARS` is left alone (the first `limitPaperText` test), and the exact page joining
(`"page one\n\npage two"`) is asserted in the third `loadFullText` test.

- Blank leading or trailing pages are dropped. `extractPages` trims each page, but the `.trim()` after the
  join in `loadFullText` is a separate step. A PDF with a blank cover or last page gives `["", "body", ""]`,
  which should come out (and be stored) as `"body"`.
- Stored text isn't truncated. Use a PDF whose text is longer than `MAX_PAPER_CHARS` and assert `loadFullText`
  returns and stores all of it, with no `[Text truncated]`. If truncation were moved into `loadFullText`, the
  cut and the marker would be saved permanently. This pins that `limitPaperText` is a separate step.
- The unexpected-error rethrow (`paperText.ts:33`, also under coverage gaps). A rejecting `fetch` doesn't reach
  it, because `downloadPdf` already converts that into a `PdfDownloadError`. Use `vi.mock("./pdfDownload.js")`
  (keeping the real `PdfDownloadError`) so `downloadPdf` throws a plain `Error("boom")`. Assert the same
  error comes out, it is not a `PaperTextError`, and nothing is stored.
- Truncation never leaves half of a character outside the basic plane. This tests the planned fix recorded
  under "Summaries" in `ISSUES.md`. `limitPaperText` cuts with `slice(0, MAX_PAPER_CHARS)`, which counts
  UTF-16 units, so a character such as the math italic 𝑥 that straddles the boundary leaves a lone high
  surrogate. Use `it.each` over two cases: `"x".repeat(MAX_PAPER_CHARS - 1) + "𝑥" + "y"` (the character
  straddles the cut) should give `"x".repeat(MAX_PAPER_CHARS - 1)` plus the marker, and
  `"x".repeat(MAX_PAPER_CHARS - 2) + "𝑥" + "y"` (the character ends exactly at the cut) should keep it. In
  both, assert the output is well-formed (`isWellFormed()` if the TypeScript lib includes it, otherwise a
  lone-surrogate regex). The first case fails until `limitPaperText` is changed, which needs approval first.

**Strengthen the existing tests**

- `limitPaperText` truncation: assert `toBe("x".repeat(MAX_PAPER_CHARS) + "\n\n[Text truncated]")` instead of
  `length < MAX_PAPER_CHARS + 50`, which would let a changed marker through.
- Check messages, not just statuses: `/Upload its PDF/` for the no-link case, `/returned 500/` for the 502,
  and `/Could not read/` for the unparseable PDF (which today can't be told apart from "No text found").
- Replace `.catch((e) => e)` with `await expect(...).rejects.toMatchObject({ status: 422, message:
  expect.stringMatching(...) })`. The `.catch` result is untyped.
- Each test hand-wraps `try/finally` around `stubFetch`. Use `vi.unstubAllGlobals()` in an `afterEach`, or
  `unstubGlobals: true` in the config next to the planned `restoreMocks`.

Skipped on purpose:
- Whitespace-only text counting as empty. The existing `["", ""]` test already needs the trim, because
  joining gives `"\n\n"`.
- A second call reusing the stored text. The stored-text test (no fetch) and the download-and-store test
  together cover both halves, and the summary route test checks `fetch` is called once.
- An empty-string `fullText` falling through to a download. The app never writes an empty `fullText`.

### More edge cases in `server/src/services/pdf.test.ts`

The file has six tests. I probed the real `extractPages` for the cases below. A page of `"  padded  "` gives
`["padded"]`, a zero-page PDF resolves to `[]`, empty input rejects with `InvalidPDFException`, a valid PDF cut at
30%, 60% or 90% rejects with `InvalidPDFException: Invalid PDF structure`, a view into a larger buffer (offset
100) works, 12 pages come back in order, and a fixture with escaped parentheses and a Latin-1 WinAnsi font
round-trips `"f(x) = a\\b (nested (parens))"` and `"café naïve Zürich"`.

- Padded page text is trimmed. The test named "returns the trimmed text of each page" uses `"first page"` and
  `"second page"`, which have nothing to trim. Use `makePdf(["  padded  "])` and expect `["padded"]`. Don't
  assert that inner spaces collapse (`"a   b"` gives `"a b"`), because that is pdf.js behavior.
- A truncated PDF is rejected. A cut-off upload or download should fail, not be accepted with partial text.
  Use `it.each` over 30%, 60% and 90% of a valid multi-page PDF, plus an empty (0-byte) row. All reject
  today, and the routes map any thrown error to a 422.
- A zero-page PDF resolves to `[]`. The routes join the pages and treat an empty result as "No text found"
  (422), not "Could not read".
- Many pages stay in order. Use 12 pages (`p1` to `p12`) and assert the exact order and count, so a
  lexicographic sort (`p10` before `p2`) or a merge would fail.
- Special characters round-trip. Assert that parentheses and a backslash (`f(x) = a\\b (nested (parens))`) and
  Latin-1 accents (`café naïve Zürich`) come back unchanged. The `makePdf` fixture can't produce these today:
  it doesn't escape `(`, `)` or `\`, it encodes as UTF-8 while the PDF `/Length` counts string length, and its
  font has no encoding entry. Without `/Encoding /WinAnsiEncoding` the accents come out garbled
  (`cafØ na ve Z rich`). The fix is to escape those characters, write Latin-1 bytes, and add the encoding to
  the font. Either extend `makePdf` in `test-utils.ts` (an existing helper used by the upload, summary and
  qa tests, and ASCII text produces the same bytes, but ask first) or add a local helper in `pdf.test.ts`.
  Non-Latin scripts need embedded CID fonts and can't be made by hand, so they are out of scope.
- `MAX_PDF_BYTES` is 25 MiB. One line: `expect(MAX_PDF_BYTES).toBe(26_214_400)`. The upload error says "limit 25
  MB", and the `MAX - 1000` upload test is written relative to the constant, so this keeps the two tied.
- `isPdf` rejects non-text bytes. Add a row `[0xFF, 0xFE, 0x00, 0x00, 0x00]` to the existing rejects table. It
  returns false and doesn't throw.

**Strengthen the existing tests**

- In "does not consume the caller's buffer", also assert the second result equals the first. It compares only
  the input bytes now.

Skipped on purpose:
- Views with a non-zero offset. Probed: it works, and every caller passes a buffer starting at offset 0.

### More edge cases in `server/src/services/pdfDownload.test.ts`

The file has five tests. I probed the real `downloadPdf`: an oversized streamed body is rejected as "too large"
and the stream is cancelled, `content-length: "abc"` is ignored for a small valid body, two chunks of 8 and
12 bytes with a limit of 15 and no header are rejected as "too large" (not "interrupted"), `timeoutMs: 20`
with a fetch that waits on the signal gives "host unreachable or timed out" after about 21 ms, and
`HTTP://EXAMPLE.ORG/a.pdf` is accepted. Reaching private addresses is already recorded in `ISSUES.md` as an
accepted limit.

- Multiple chunks reassemble correctly. The tests only use one-chunk bodies, so an offset bug in
  `bytes.set(chunk, offset)` would pass. Stream 3 chunks and assert the result equals them concatenated, byte
  for byte.
- Size-limit boundaries, in one `it.each` table. Today only `maxBytes: 10` against a larger PDF is tested.
  Rows:
  - A body of exactly `maxBytes` is accepted and `maxBytes + 1` is rejected, both streamed and by
    `Content-Length`.
  - Two chunks that are each under the limit but exceed it together are rejected as "too large", so the sum
    matters.
  - A non-numeric `Content-Length` doesn't block a small body, and the limit is still enforced while
    streaming.
  - A declared length of `MAX_PDF_BYTES + 1` with the default limit gives a message saying "limit 25 MB" (no
    body needs reading).
  - With tiny limits the message shows "limit 0 MB" because of rounding. That is harmless, so assert
    `/too large/` there.
- The timeout is wired to the signal. Today only "a signal exists" is checked. Use `timeoutMs: 20` and a fetch
  that rejects on abort, and assert the "unreachable or timed out" message. A wrong unit would hang or fail.
- Request shape. Assert the URL is passed through unchanged and the headers include
  `accept: application/pdf`. The existing signal check (`signal` is an `AbortSignal`) moves here.
- An oversized stream is cancelled. Pin what was probed: `cancel` is called and the stream isn't read to the
  end. This guards against rewriting the loop with `reader.read()` and forgetting to cancel.
- Add `HTTP://EXAMPLE.ORG/a.pdf` to the protocol table as an accepted row. `URL` lowercases the scheme.

**Strengthen the existing tests**

- The four-case failure loop (403, network error, HTML page, empty body) becomes `it.each` with a typed
  `rejects.toBeInstanceOf(PdfDownloadError)` plus the message, in place of `.catch`.
- The protocol-rejection loop becomes `it.each`.
- "returns the bytes... and sends a timeout signal" does two things. Split them (the signal check moves to the
  request-shape test).

Skipped on purpose:
- Redirects. `fetch` follows them by default, and reaching private addresses is an accepted limit in
  `ISSUES.md`.
- More non-PDF prefixes (short input, leading whitespace). `pdf.test.ts` tests `isPdf` directly, and two
  existing cases reach the wrapper's message.
- More HTTP statuses. The message only interpolates the status.
- A timeout during the body read. It uses the same wiring as the timeout test, and the "interrupted" test
  covers its message.

### More edge cases in `server/src/services/rateLimiter.test.ts`

The file has three tests using a fake clock: sequential spacing of 60 s / rpm, no wait after a long gap, and
queued concurrent callers (`[10_000, 20_000]`). The source computes `start = max(now, nextSlot)`, then
`nextSlot = start + interval`, and sleeps for `start - now` if that is positive.

- A partial wait sleeps only the remainder. Today every sleep is either 0 or a full interval. At 5 rpm (12 s),
  acquire, advance 5 s, acquire again, and assert the sleeps are exactly `[7000]`. This is the case when a user
  asks a question 5 seconds after a summary, and it is the only test of the `start - now` arithmetic.
- Spacing resumes after an idle gap. The existing gap test makes one call afterward, so it can't tell "the slot
  was reset" from "limiting stopped". Acquire, advance well past the interval, then acquire three times: the
  first doesn't sleep and the next two sleep a full interval each. This also strengthens "does not wait when
  enough time has passed".
- Callers resume in order, using the default clock. The fake clock's `sleep` ignores the duration, so the
  existing concurrency test only checks durations. Use `vi.useFakeTimers()` and `createRateLimiter(60)` with no
  clock. Start three labelled acquirers together and assert they resolve at 0, 1000 and 2000 ms, in order. This
  also exercises the default `Date.now` and `setTimeout`, which no test does today, and replaces the old
  "not worth testing" note on `rateLimiter.ts:12`.
- Independent limiters. Two limiters on one clock don't delay each other. This guards against moving
  `nextSlot` to module level.

**Tests for the planned code change** (recorded under "Rate limiter" in `ISSUES.md`). These describe the fixed
behavior, so they fail until `createRateLimiter` is changed, which needs approval first.

- In one `it.each` table: `0`, `-1`, `NaN` and `Infinity` throw a `RangeError`, and `0.5` is accepted (one
  request every two minutes).

Skipped on purpose:
- Fractional intervals (`rpm=7` gives 8571.43 ms). There is no rounding contract, and the timer accepts it.
- A separate default-clock smoke test. The ordering test above covers it.

### More edge cases in `server/src/services/semanticScholar.test.ts`

The file has seven provider tests plus a `describe("search route")` block that does not belong here (see the
cleanup below). I probed the real provider, and the results are quoted in the items. Three behaviors are
recorded in `ISSUES.md` under "Paper search (Semantic Scholar)".

**Tests for the planned code changes.** These describe the fixed behavior, so they fail until the code is
changed, which needs approval first.

- A bad response body is a 502. In one `it.each` table, a 200 with an HTML body, a 200 with an empty body, and
  a body read that is aborted each reject with a `SearchProviderError` of status 502. Today the first two
  escape as a raw `SyntaxError` and the third as a `DOMException`, so the route returns a 500.
- Author names are trimmed and blank ones are dropped. With names `"  Ada "`, `"   "`, `""` and `"Bob"`, expect
  `["Ada", "Bob"]`. Today the result is `["  Ada ", "   ", "Bob"]`.

**Tests that pass today**

- The timeout is wired to the signal. Use `timeoutMs: 20` with a fetch that rejects on abort, and assert a
  `SearchProviderError` of status 502 ("Could not reach Semantic Scholar"). The existing network-error test
  only throws a plain `Error`.
- Non-429 failures, in `it.each` over 404, 500 and 503: a 502 saying "returned N" and exactly one fetch call
  (no retry). This covers the coverage gap `semanticScholar.ts:99`. Add 429 followed by 500 (a 502 "returned
  500") and 429 followed by a network error (a 502 "Could not reach").
- Retry details, with fake timers: the retry waits `retryDelayMs`, uses the same URL and API key header, and
  gets a fresh signal. The current test uses a delay of 0.
- Request shape: with no key the headers are `{}`, special characters in the query are encoded
  (`a&b=c#` becomes `query=a%26b%3Dc%23`), and `fields` is sent.
- A normalization table: a title is trimmed, a whitespace-only title drops the paper, a blank abstract becomes
  null, and an arXiv id with spaces is trimmed.
- One malformed result fails the whole search. An item without a `paperId` gives a 502 "Unexpected response".
  This pins the accepted behavior recorded in `ISSUES.md`.

**Strengthen the existing tests**

- "normalizes results" checks 2 of the 6 results, with a cryptic `results[2]`. Compare the whole array and
  split the dropped-title and invalid-URL cases.
- "reports malformed responses and network errors as 502" holds two unrelated cases, and the malformed one
  doesn't check the status. Use `it.each` and assert the status.

Skipped on purpose:
- Route-level checks (limit boundaries, JSON passthrough, an unexpected error becoming a 500). They belong to
  the `search.test.ts` plan.

### More edge cases in `web/src/api.test.ts`

The file has thirteen tests of the typed API client with MSW. I probed `api.ts`: a 200 with no body gives
"The server sent an empty response", `{ error: "" }` gives an `ApiError` with an empty message, a network failure
(`HttpResponse.error()`) is a raw `TypeError: Failed to fetch`, `{ error: 123 }` and an empty 404 fall back to
"Request failed (N)", the first event arrives before the stream closes, and a pre-aborted signal rejects with
`AbortError`. An abort after the first chunk hangs under MSW but rejects with `AbortError` with native fetch
against a real server, so that hang is an MSW artifact, not an app bug.

**Test-environment fix** (in `web/src/test/setup.ts`, our own test setup). Under MSW, aborting after a response
has started does not error the body stream. In the `fetch` wrapper, when the request has a signal, pipe the
response body through it (`pipeThrough(new TransformStream(), { signal })`) so aborting errors the stream as a
real fetch does. The planned `useAskQuestion` and `Chat` stop tests need this too.

**Tests for the planned code changes** (recorded under "Web API client" in `ISSUES.md`). These fail until the
code is changed, which needs approval first.

- `{ error: "" }` with a 500 falls back to "Request failed (500)" (a row in the error-body table below).
- A network failure (`HttpResponse.error()`) rejects with an `ApiError` whose message is "Could not reach the
  server", while an abort still rejects with an `AbortError`.

**Tests that pass today**

- Each call surfaces the server's message. The "every call" test only checks the class, so a call that dropped
  `errorMessage` would still pass. Use `it.each` over all nine calls and assert the message is `"Down"`.
- Events arrive incrementally. Use a stream that sends one event and then waits, and assert the first event is
  yielded before the stream closes. This would catch a change to `await res.text()`. The Chat plan's "partial
  text visible mid-stream" test covers the UI layer, so both stay.
- An `error` event is yielded, not thrown. The doc comment promises that failures after the answer starts
  arrive as events. Send `[delta, error]` and assert both come out with no throw.
- Error-body table, in one `it.each`: `{ error: 123 }`, an empty 404, `null`, an HTML body and `{ message }`
  all give "Request failed (N)". It replaces the existing two-case fallback test.
- An empty response. `new HttpResponse(null)` gives the "empty response" `ApiError` (`api.ts:80`).
- Abort rows: a signal aborted before the call rejects with `AbortError`, and (with the `setup.ts` fix) an abort
  after the first chunk rejects with `AbortError`. Also replace the tautological
  `expect(controller.signal.aborted).toBe(true)` in the existing abort test with an `AbortError` assertion.

**Strengthen the existing tests**

- "listPapers, getPaper, listMessages and summarizePaper return the JSON body" covers four functions in one
  test, so the first failure hides the rest. Use `it.each`.
- "throws when the stream carries an unreadable line" mostly tests `qaStream.ts`. Keep it as a one-line check
  that reader errors propagate.

Skipped on purpose:
- Request paths and methods. MSW matches both, and `onUnhandledRequest: "error"` fails a wrong one. The tests
  already use ids 7 and 3.
- The upload sending the file. `UploadBox.test.tsx` already parses the form data through this same function.
- The signal being optional. Existing tests call `askQuestion` without one.
- Unicode or empty search queries. The encoding test covers `a b&c`, and validation is the server's job.

### More edge cases in `web/src/App.test.tsx`

The file has three tests: `/` redirects to the Search page, the Search and Library links navigate, and a test
named "renders the paper page at /papers/:id" that only checks the invalid-id message. `App.tsx` has a header
with a `NavLink` pair, a `Navigate` redirect from `/` (with `replace`), and routes for `/search`, `/library` and
`/papers/:id`, with no catch-all route.

**Test for the planned code change** (recorded under "Web routing" in `ISSUES.md`). It fails until the code is
changed, which needs approval first.

- An unknown route shows a not-found page. Use `it.each` over `/nope`, `/papers` (no id) and `/papers/1/extra`.
  Assert the header is still shown (so the header persisting across routes is covered here), the message
  "Page not found" is shown, and there is a link to Search.

**Tests that pass today**

- A valid id renders the paper page. The test named "renders the paper page at /papers/:id" uses `/papers/abc`,
  so it never reaches the paper view, and nothing tests the `:id` route wiring. Mock `GET /api/papers/5` and
  assert the title is shown. Rename the existing test to "shows an error for an invalid paper id".
- Navigate from Library to a paper and back. This is the only cross-page test: click a paper in the Library
  (mocked list and detail responses), see its page, click "← Library", and see the library again.
- The redirect replaces history. A `Navigate` without `replace` makes the Back button return to `/`, which
  redirects again and traps the user. Render a small location probe next to `<App />` and assert the path is
  `/search` and `useNavigationType()` is `REPLACE`.
- The active nav link is marked. At `/search` the Search link has `aria-current="page"` and Library doesn't, and
  they swap after clicking Library. It guards against replacing `NavLink` with `Link`, which would silently lose
  the active highlight.

**Strengthen the existing tests**

- The redirect test only passes by checking the Search label. Give it the location assertion above. Keep its
  `/api/papers` stub: `Search.tsx` calls `usePapers()` to mark results already in the library as "Saved", so the
  page does request it.
- The navigation test: add the `aria-current` check.

Skipped on purpose:
- `/papers/0`, `-1` and other invalid ids. They belong to the `Paper.test.tsx` plan.
- Library to Search keeping state. Nothing defines what it should do.

### More edge cases in `web/src/components/Chat.test.tsx`

The file has eight tests: saved messages shown, a load error, Ask disabled for blank input, a streamed answer that
becomes the saved messages, "Thinking…" with a Stop button while the request is pending, an error event keeping
the question, a request rejected up front (429), and a stream that ends without `done`. The `Chat.tsx:17` submit
guard is already under coverage gaps.

- The partial answer is visible mid-stream. The `turn` rendering with real text is never observed: the tests see
  only "Thinking…" or the final saved messages. Use a stream that sends one delta and then waits on a gate.
  Assert the partial text is in an assistant bubble, the question is already a user bubble, and the saved list is
  still empty. Then release it. Streams work under MSW, and only abort is affected.
- A retry clears the previous error, and asking again after Stop clears the notice. `ask` resets `error` and
  `stopped` at the start. Use `it.each`: after an error event, and after Stop, ask again with a good stream and
  assert the error or notice is gone, the input is cleared, and the answer shows. The code comment says the
  question stays for a retry, but no test performs the retry.
- Stop after partial text. Stop is mostly used mid-stream, and the existing test only stops while the request
  is pending. Show a partial answer, click Stop, and assert the "Answer stopped" notice, the partial text gone,
  and the input re-enabled. This needs the `setup.ts` abort fix described in the `api.test.ts` section. The
  `useAskQuestion.test.tsx` section should keep only the flags and the no-invalidation check, so the two aren't
  duplicated.
- Submit paths and the guard (`Chat.tsx:17`). Pressing Enter with a non-empty question should submit, since the
  tests only click Ask. The guard `!question || streaming` can't be reached from the UI: Ask is disabled for blank
  input, and while streaming the button is a non-submitting Stop. Drive the guard directly with
  `fireEvent.submit(form)`: a blank input sends no request, and a second submit while streaming sends no second
  request (count the requests).
- Loading state. "Loading conversation…" shows while the messages request is delayed, and is gone once it loads.
- The conversation is refetched after an answer. Count `GET /messages` requests and assert one more after a
  successful answer. The current test only passes because the mock array is mutated.

**Strengthen the existing tests**

- "reports a stream that ends without done as an error" accepts any text (`/.+/`). Assert the real message, "The
  answer was cut off before it finished".
- The error-event test should also assert the input and the Ask button are enabled afterwards.
- The streaming test bundles trimming, no duplicate bubble, input cleared, and "Thinking…" gone. It is
  acceptable, but the trimmed-request check could be its own test.

Skipped on purpose:
- Switching `paperId` showing the other paper's conversation. The remount is `key={id}` in `Paper.tsx`, so it
  belongs to the `Paper.test.tsx` plan, which already has it.
- Unmount aborting an in-flight answer. It is the hook's cleanup effect and belongs to
  `useAskQuestion.test.tsx`.
- A plain-text 500 or a network failure shown as an error. The `api.test.ts` error-body table and the planned
  network-error fix cover them.
- A whitespace-only question through Enter. The direct-submit guard test covers it.

### More edge cases in `web/src/components/PaperCard.test.tsx`

The file has four tests on a presentational component: title with year, authors and abstract; links with
`target="_blank"` and `rel="noreferrer"`; all optional parts omitted at once; and the badge, leading actions and
children. Each optional part has its own condition, but the tests only show them all together or all missing.

**Test for the planned code change** (recorded under "Web display" in `ISSUES.md`). It fails until the code is
changed, which needs approval first.

- A year of `0` shows nothing extra: the heading is exactly the title, with no stray `0` text. The same pattern
  is in `Paper.tsx`, so add the same check to the `Paper.test.tsx` plan.

**Tests that pass today**

- Each link appears independently. Use `it.each`: with only `pdfUrl` set there is one link (PDF), and with only
  `url` set there is one link (Semantic Scholar). Assert the single link's `href`. Today the two conditions are
  never separated.
- The abstract is collapsed inside `<details>`. The current test only checks the abstract text is in the DOM,
  which also passes if it is always visible or the wrapper is dropped. Assert there is a `<details>` without
  `open`, its summary is "Abstract", and the abstract text is not visible. Then open it (by clicking the summary,
  if jsdom supports it) and assert it is visible.
- Action order and the trailing wrapper. The component comments promise leading actions first, then the PDF and
  Semantic Scholar links, then the children last. Pass all four and assert the order of the `a` and `button`
  elements in the DOM. Also assert the children sit in the trailing wrapper, and that the wrapper is absent
  when there are no children (the `children &&` branch).
- HTML in metadata is shown as text. Titles and abstracts come from Semantic Scholar and the LLM, so treat them
  as untrusted. A title like `<img src=x onerror=alert(1)>` should appear as literal text with no `img`
  element. This guards against a future `dangerouslySetInnerHTML`.
- Add `level: 3` to the heading query in the first test and assert the `article` role, to check the page
  outline.

**Strengthen the existing tests**

- Check `target` and `rel` on both links, not only the PDF link.
- "omits missing parts" uses `document.querySelector(".byline")`, which is coupled to a class name. The heading
  name check already proves the year is absent, because a string name must match the whole text.
- "renders the badge, leading actions and children" doesn't check placement, which the order test now covers.

Skipped on purpose:
- A badge that is an empty string. `"" && x` renders nothing in React, so there is no bug.
- A single author. `join(", ")` is trivial.

### More edge cases in `web/src/components/UploadBox.test.tsx`

The file has four tests: a chosen file is uploaded with its name, type and contents checked and the library is
invalidated, progress text while uploading, the server's error message, and a dropped file with the dragging
style. The "Choose file" click (`UploadBox.tsx:33`) is already under coverage gaps.

**Tests for the planned code change** (recorded under "Web upload" in `ISSUES.md`). These fail until the code is
changed, which needs approval first.

- Several dropped files: only the first is uploaded (assert one request and its filename), and a notice such as
  "Only paper.pdf was uploaded" is shown.
- A drop during an upload is ignored: with a deferred upload pending, a second drop sends no second request.

**Tests that pass today**

- No file chosen sends nothing. `pick` only uploads `if (file)`. Use `it.each`: a change event with an empty
  list, and a drop with an empty file list, each make no request.
- The input is reset after picking. `e.target.value = ""` lets the user pick the same file again, for example
  after an error, since a change event only fires when the value changes. Assert the value is `""` after an
  upload, then upload the same file again and assert a second request.
- An error clears on a successful retry. Fail once, then succeed, and assert the error message is gone.
- A failed upload doesn't refresh the library. The first test checks the cache is invalidated on success. Add
  the counterpart: a 400 leaves `isInvalidated` false.
- The drag and drop handlers call `preventDefault`. Without it, dropping a PDF makes the browser navigate to the
  file and leave the app. `fireEvent.dragOver` and `fireEvent.drop` return `false` when the default was
  prevented, so assert that.
- The dragging style clears on drop. The existing test fires `dragLeave` before the drop, but browsers don't
  fire `dragLeave` after a drop, so the clear in `onDrop` is what matters. Do `dragOver` then `drop` and assert
  the class is gone.
- The prompt and button are hidden while uploading. The progress test only checks the progress text. Assert
  "Choose file" and the drop prompt are absent during the upload and back afterward.
- The "Choose file" click opens the picker (the coverage gap above). Spy on the hidden input's `click`, click
  the button, and assert one call.
- Input attributes: assert `accept="application/pdf"` and `hidden`, in the first test.

**Strengthen the existing tests**

- The progress test waits on a real 50 ms timer. Use a deferred promise.
- The drop test checks the style and the upload together. Split it.

Skipped on purpose:
- Non-JSON or network failures shown as an error. The `api.test.ts` error-body table and the planned
  network-error fix cover the messages.

### More edge cases in `web/src/pages/Library.test.tsx`

The file has six tests: a loading state then the empty message, a list with links and the "uploaded" badge, a
load error, delete after confirmation, a declined confirmation, and a delete error. Nearly all use a single
paper with id 1.

- Delete removes only the chosen paper. A single paper with id 1 can't catch a wrong-id or closure bug. Show two
  papers with ids like 7 and 12, delete the second, and assert the request goes to `/api/papers/12`, the confirm
  text uses that title, and the first paper is still listed.
- All Delete buttons are disabled while one delete is pending. They use `disabled={remove.isPending}`, and the
  tests only check the re-enable after an error. Hold the DELETE with a deferred promise, click one, assert every
  Delete button is disabled, then release and assert they re-enable and the paper is gone.
- A delete clears the cached detail and messages. `useDeletePaper` calls `removeQueries` for the paper's detail
  and its messages, with a comment that it stops the Back button flashing the deleted paper, and nothing tests
  it. Seed the query client (`renderApp` returns it) with both keys, delete, and assert both are gone.
- A delete error clears on a later success. Fail once, then succeed on a second attempt, and assert the error
  text is gone. The error line is only tested on failure.
- A load error shows no empty message. The empty-library message is shown only when the data is an empty list,
  so an error should show neither "Your library is empty" nor "Loading…". Assert both are absent in the error
  state.
- The upload control is present in every state. `UploadBox` renders above the list. Assert "Choose file" exists
  while loading, when the library is empty, and in the error state. Uploading is how an empty library gets
  filled.

**Strengthen the existing tests**

- "does nothing when the confirmation is declined" asserts `deleted === false` right after the click, which
  would also pass if the click never registered. Also assert `confirm` was called.
- The delete-error test should also assert the paper is still listed.
- The delete test passes because the mock array is mutated. Count the `GET /api/papers` requests and assert one
  more after the delete.
- Use ids other than 1 where a test could hide a hard-coded id.

Skipped on purpose:
- Card details (links, year, abstract). They are `PaperCard`'s concern and covered by its plan.

### More edge cases in `web/src/pages/Paper.test.tsx`

The file has seven tests: four invalid ids (`abc`, `0`, `-1`, `1.5`) via `it.each`, details with links and chat,
a missing abstract, an unknown paper, Summarize and then Regenerate, and a summarize failure that keeps the old
summary. All of them use paper id 1.

**Tests for the planned code changes** (recorded under "Web display" in `ISSUES.md`). These fail until the code
is changed, which needs approval first.

- The summarize state doesn't leak between papers. Render a link next to the routes, fail summarize on paper 1
  (`No PDF link`), navigate to paper 2, and assert the error is gone. Probed: today it stays. Also assert a
  pending "Summarizing…" doesn't carry over (not probed).
- A year of `0` shows nothing extra: the heading is exactly the title, with no stray `0` (the same planned fix
  as in the `PaperCard` section, since `Paper.tsx` has the same `year &&` pattern).

**Tests that pass today**

- Odd ids, in one `it.each` table, to capture what the page allows and what it doesn't. `PaperPage` uses
  `Number(id)` and requires a positive integer.
  - Accepted, and the request goes to the numeric id: `007` (7), `+5` (5), `1.0` (1), `%205` (a leading space,
    5), `1e3` (1000) and `0x10` (16).
  - Rejected with "Invalid paper id." and no request: `abc`, `0`, `-1`, `1.5`, `12abc`, `%20` (a lone space,
    which is 0), `Infinity` and `1e400`.

  The server's `IdParam` (`z.coerce.number().int().positive()`) coerces with `Number()` too, so the page and
  the API agree. The existing invalid-id test is replaced by this table.
- Optional fields are hidden when null, in one `it.each`: `year: null` (the heading is exactly the title),
  `authors: []` (no byline), only `pdfUrl`, only `url`, and neither. After the shared-header refactor recorded
  in `ISSUES.md`, this table moves to the shared component's tests.
- Summarize is replaced while pending. While "Summarizing…" shows, neither Summarize nor Regenerate is present,
  so a second click can't fire. Count the POSTs and assert exactly one.
- A summarize error clears on a successful retry. Fail once, then succeed: the error text is gone and the new
  summary shows. The error line is only tested on failure.
- The chat state resets when the id changes. The remount from `Chat`'s `key={id}` works per the probe, but
  nothing tests it. Render a link next to the routes, type a draft on paper 1, navigate to paper 2, and assert
  the input is empty and paper 2's messages show.
- A loading state. A delayed `GET` shows "Loading…" (`.muted`), then the paper.

**Strengthen the existing tests**

- "rejects the invalid id without any request" never checks that no request was made. Count requests with
  `server.events.on("request:start")` and assert zero (in the odd-ids table).
- Use an id other than 1 throughout, so a wrong id interpolation fails (the summarize POST and the paper GET).
- The details test packs the heading, byline, links, back link and chat into one test. Split it, and assert
  `target="_blank"` and `rel="noreferrer"` on both links.
- The summarize failure test should also assert "Regenerate summary" is back and enabled, so the user can retry.

Skipped on purpose:
- A server 500 or a network error on the paper fetch. The `api.test.ts` table covers the message mapping, and
  the 404 test covers the error branch.
- Messages loading into the chat. `Chat.test.tsx` owns it.

### More edge cases in `web/src/pages/Search.test.tsx`

The file has seven tests: Search disabled for blank input with no request on load, a trimmed query and the
results, "No papers found.", a server error, saving a result with the full payload, results already in the
library shown as "Saved", and a save error.

**Tests for the planned code changes** (recorded under "Web search" in `ISSUES.md`). These fail until the code
is changed, which needs approval first.

- Searching the same query again after an error issues a new request and clears the error. The first search
  fails with a 429, the second press succeeds, and the results show. Probed: today the second press makes no
  request.
- A failed save's error is gone after a new search. Fail a save, then submit a different search, and assert
  "Could not save" is no longer shown. Probed: today it stays.

**Tests that pass today**

- The button becomes "Saved" after saving. The existing save test only checks the POST body. Have the library
  mock return the new paper after the POST. Assert the button becomes "Saved" and disabled, and that the library
  was refetched. This is the invalidation and `savedIds` wiring.
- Only that paper's Save is disabled while its save is pending (the coverage gap `Search.tsx:53`). With two
  results, hold the POST for the first: its button is disabled and the second stays enabled. Then release.
- The "Searching…" indicator. A delayed search response shows "Searching…", which disappears when the results
  arrive. Nothing tests it.
- A blank query can't search even when submitted directly. Ask is disabled, but the form's `onSubmit` is the only
  other guard. Use `fireEvent.submit` with a blank input and assert no request.
- A new search replaces the old error and results. Fail a search, then search for something else that
  succeeds. The error is gone and the new results show.
- A library load failure doesn't break search. A 500 from `/api/papers` still shows results with enabled Save
  buttons and no error (the fallback `library.data ?? []`). The failure is silent, so the "Saved" marks are
  just missing.
- A save error clears on a later successful save. Fail once, then succeed, and assert the error is gone.

**Strengthen the existing tests**

- The save test ends with `await screen.findByRole("heading")`, which resolves at once because the heading is
  already there, so `expect(saved)` can run before the POST has arrived. Use `waitFor` on the recorded request.

Skipped on purpose:
- Card details through Search. They are `PaperCard`'s concern.
- Duplicate `externalId`s in results. The server dedupes saves, and a duplicate result would only cause a React
  key warning.
- A repeated identical search using the cache. The planned retry fix supersedes it.
- Giving the upload paper in the "already Saved" test an `externalId`. Upload papers have no `externalId` in the
  `Paper` type, and the `source === "search"` check is type-required narrowing, so the existing test is fine.

### More edge cases in `web/src/qaStream.test.ts`

The file has seven tests of the NDJSON reader: events sharing or split across chunks, a multi-byte character
split between chunks, a final event without a newline, an error event ending normally, unreadable lines and
unknown types, a stream cut off before `done`, and cancelling the stream when the consumer returns early.

**Test for the planned code change** (recorded under "Web API client" in `ISSUES.md`). It fails until the code is
changed, which needs approval first.

- A connection lost mid-answer is wrapped. A stream whose `pull` errors after the first event makes the
  generator reject with an `ApiError` ("The connection was lost before the answer finished"), while an abort
  still rejects with an `AbortError`. Today the raw error passes through, which is pinned by the same stream
  until the fix lands.

**Tests that pass today**

- Cancel runs after a parse failure. `finally` cancels the reader, but the failure tests don't pass a cancel
  spy. After an unreadable line, assert `cancel` was called once, so the connection is closed on a bad
  response.
- Events are identical however the bytes are chunked. Take one stream containing `é` and an emoji, split it into
  two chunks at every byte offset (and once with one byte per chunk), and assert the same events each time. It
  covers every split point, including the middle of a multi-byte character, not one hand-picked point.
- A bad trailing line fails as unreadable. All existing bad inputs end in a newline, so the end-of-stream flush
  never sees bad data. A `delta` followed by the unterminated `{"type":"do` rejects as "unreadable response",
  not "cut off".
- Blank lines and whitespace are skipped, in one `it.each`: leading blank lines, a trailing `"  "`, and CRLF line
  endings each give just the real events. The `!line.trim()` branch is never reached today.
- Streams with only a terminal event. A stream of only `done` (the server's empty-answer case in the
  `qa.test.ts` plan) and one of only an `error` both end normally, with no "cut off".
- A cancel that throws is ignored. The reader's `.catch(() => {})` means a failing `cancel` must not change the
  outcome. Use a `cancel` that throws and return early.

**Strengthen the existing tests**

- "yields events that share a chunk or are split" holds two scenarios with a weak `toHaveLength(3)`. Split it
  and compare with `toEqual`.
- "rejects unreadable lines and unknown event types" loops three cases in one test. Use `it.each`, and keep one
  schema-rule row as a smoke check, since the rules themselves belong to the `schemas.test.ts` plan.
- "fails if the stream ends without a done or error event" holds two cases. Use `it.each`.
- The multi-byte test only asserts `events[0]`, not the `done` event.

Skipped on purpose:
- Schema strictness (`text: 123`, an `error` without a message). The `schemas.test.ts` plan owns those rules.
- A consumer that throws inside its loop. It uses the same `return()` path as the early-return test, and the
  hook's early return on an `error` event takes it too.
- Events after `done`. No server sends them, and a test would pin an accident.
- A multi-byte split in the final unterminated chunk. The per-offset test covers every split, and removing
  `{ stream: true }` already fails the existing test.

### More edge cases in `web/src/useAskQuestion.test.tsx`

The file has nine tests of the hook that drives the chat: idle state, success (resolves true, invalidates the
messages, clears the turn), the question with an empty answer while pending, an error event, a rejected request,
`stop()` ending as "stopped", clearing the error on the next question, aborting on unmount, and `stop()` with
nothing in flight. The `Chat.test.tsx` plan covers what the user sees, so these check hook state and avoid
repeating it.

**Test for the planned code change** (recorded under "Web chat" in `ISSUES.md`). It fails until the code is
changed, which needs approval first.

- A second `ask` while one is in flight is ignored. With the first request pending, calling `ask` again returns
  `false`, sends no second request, and leaves the first unaffected (still streaming, with its turn). This also
  removes the need for the `controller.current === abort` race branch (`useAskQuestion.ts:53`, in the coverage
  gaps).

**Tests that pass today**

- Deltas accumulate into the turn. `setTurn((t) => ... t.answer + event.text)` is the core of streaming, and no
  test checks the answer text while streaming. Use a stream released step by step: after delta "A" the turn's
  answer is "A", and after "B" it is "AB", before `done`. The `Chat.test.tsx` plan checks one delta rendered, and
  this checks accumulation.
- Invalidation finishes before the turn is cleared. The code awaits `invalidateQueries` so the saved messages
  are loaded before the temporary turn disappears, which avoids a flicker. Make `invalidateQueries` return a
  deferred promise. While it is pending, `turn` is still set, `streaming` is still true, and `ask` hasn't
  resolved. After it settles, `ask` resolves true.
- Failures don't invalidate, in `it.each`. Rows: a delta followed by an error event, a delta-only stream ("cut
  off"), and an unreadable line. Each gives `ask` false, `error` set, `turn` null, and `invalidateQueries` not
  called. The existing error test has no deltas and no invalidation spy.
- A mid-stream Stop. After the first chunk, `stop()` leaves `stopped` true, `error` null, `turn` cleared, and no
  invalidation. This needs the `setup.ts` abort fix described in the `api.test.ts` section. The existing stop
  test only covers a pending request.
- A non-`Error` rejection (the coverage gap `useAskQuestion.ts:48`). Use `vi.mock("./api.js")` so `askQuestion`
  rejects with a plain string, and assert `error` is that string.
- The request uses the right paper id and question. Every test uses paper 1, and the mocks hard-code
  `/papers/1/ask`. Use `setup(7)` and capture the URL and body: `/api/papers/7/ask` and `{ question }`.
- `stop()` after completion does nothing. After a successful answer `controller.current` is reset, so `stop()`
  must not set `stopped`.
- Unmount with nothing in flight. The cleanup uses `controller.current?.abort()`, so unmounting an idle hook
  must not throw.

**Strengthen the existing tests**

- "clears the previous error and stopped flags on the next question" only checks `error`. Add the stopped path:
  ask, stop, ask again, and `stopped` is false. The Chat plan checks the visible notice, and this checks the
  state.
- `act(() => void result.current.ask(...))` discards the promise, so a hang would go unnoticed. Keep the promise
  and assert it resolves.
- The unmount test should also assert the `ask` promise resolves `false` after the abort.

Skipped on purpose:
- A network failure shown as an error, not "stopped". It takes the same branch as the rejected-request test, and
  the message wrapping belongs to the `api.test.ts` plan.

## Cleanups

- **Rename the `post` helper in `server/src/routes/papers.test.ts:20`** to something like `savePaper`. It
  calls `POST /api/papers/from-search` to create a paper, but the name `post` reads like a generic HTTP
  helper next to the plain GET calls in the same file.
- **Split the question-trimming check out of the history test in `server/src/routes/qa.test.ts:64`.**
  "sends earlier messages as history, at most the most recent ones" also sends `"  And now?  "` and
  asserts the trimmed question, so it covers two unrelated behaviors. Change it to send a plain
  question, and add a separate test that sends `"  Why?  "` and checks both that the LLM receives
  `"Why?"` and that the saved user message has `content: "Why?"`. The schema-level trim is already
  tested in `schemas.test.ts`, so the new test only needs to cover the route's wiring.
- **Restore mocks consistently in the server tests.** `server/vitest.config.ts` doesn't set
  `restoreMocks`, so spies stay in place after the test that created them. `qa.test.ts:98` and
  `app.test.ts:10` silence `console.error` and never restore it, which hides real errors in later tests
  in the same file. `summary.test.ts:25` and `upload.test.ts:117` restore by hand. Setting
  `restoreMocks: true` in the server config, as the web config does, would cover all of them and make
  the manual `vi.restoreAllMocks()` calls redundant. Also set `unstubGlobals: true`, which
  `paperText.test.ts` needs for its `vi.stubGlobal("fetch", ...)` (now hand-wrapped in `try/finally`).
  Optionally, assert on the `console.error` spy in `qa.test.ts:98` (it is currently only silenced), as
  `app.test.ts` does.
- **Name the question length limit in source, but keep the literal in the tests.** The limit is a
  literal `4000` in `shared/src/schemas.ts:47` (`QaInput`). Exporting a `MAX_QUESTION_LENGTH` constant
  from `shared` would let the web `Chat` input use it as `maxLength`, so the UI and server can't drift.
  The tests (`schemas.test.ts:37-38`, `qa.test.ts:130`) should keep hard-coded `4000` and `4001`. If they
  imported the constant they would still pass after an accidental change to the limit, whereas a literal
  makes the change fail a test. The `qa.test.ts` route test with `4001` only shows that validation is
  wired up, so it is fine as it is. This needs a change to `shared/src/schemas.ts`, which is source code,
  so ask first. Today the web `Chat` input has no `maxLength`, so an over-limit question only fails with
  the server's 400.
- **Split `server/src/routes/qa.test.ts:155` ("404s for a missing paper, and the messages are deleted with
  their paper").** It covers two unrelated behaviors. The `GET /api/papers/999/messages` 404 is the
  messages route's own branch and needs no setup, so it should be its own test. The delete cascade is
  driven by `DELETE /api/papers/:id` and the foreign key, so it fits better in `papers.test.ts` or its
  own `describe`. The cascade half also never checks that messages exist before the delete, so it would
  pass if `ask` stored nothing. Add `expect(await messages(app, id)).toHaveLength(2)` before the delete.
  The test at line 138 (ordering and per-paper isolation) shares one setup and can stay combined.
- **Keep the extracted `fullText` out of responses by construction, not by convention.** `toPaper` omits it
  from its parameter type, but TypeScript doesn't check properties that arrive through a spread, so a
  refactor to `{ ...row, ... }` would compile and send up to 400,000 characters per paper. The list route
  already avoids it by leaving the column out of its `SELECT`. Doing the same in `GET /:id` and in the
  summarize update's `returning()` (reusing `paperColumns`) would make a leak impossible. Alternatively,
  parse responses with the shared `Paper` schema, which strips unknown keys. This changes `papers.ts` and
  `summary.ts`, so ask first. Recorded in `ISSUES.md`. The response-shape test in `papers.test.ts` stays as
  the regression guard.
- **Remove the `describe("search route")` block from `server/src/services/semanticScholar.test.ts`.** It tests
  the route and repeats `routes/search.test.ts` (the query passed through, the 400 checks, a provider error
  mapped to its status), whose version is more complete. Removing it also drops its awkward `makeApp` typing.

