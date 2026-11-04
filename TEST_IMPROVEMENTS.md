# Test improvements

Findings from the review of the tests implemented from `TESTING.md`. Seven reviewers (one per group of test
files) compared the tests with the plan and the source. They agreed on three points:

- No plan item is missing.
- Every failing test is an intentional one, and each fails for the reason the plan gives.
- Nothing uses `it.fails`, `it.skip` or `it.todo`.

The items below are what is left to improve. Nothing here has been changed yet. Paths are relative to
`server/src` or `web/src`, and line numbers are from the review, so they may have moved.

## Status

The "could pass when they shouldn't" table, the conflicting race test and the "Style" items have been addressed in
the tests. The "Minor test issues" and "Plan corrections" sections below have not been touched.

Style work: the `use*` helpers in the page tests are now `serve*`; casts on response bodies are replaced by
schema parsing (`errorOf`, `Paper.parse`, `z.array(QaMessage)`) in the server route tests; `llm.test.ts` has a
typed `fakeResponse` helper; `deferred` is shared from `web/src/test/deferred.ts`; `api.test.ts` has a typed
`rejection` helper; duplicate tests were folded or removed in `qa.test.ts` and `semanticScholar.test.ts`; and
class-name queries were replaced with role queries except where there is no role (those carry a comment).

- Upload cap: the old test is removed, and `server/routes/upload.metadataCap.test.ts` mocks `extractPages` to
  return long pages and asserts the exact cut (`toBe` on the 12,000-character text).
- Blank query, invalid id, library error, second submit, drop while pending, refetch count: each now waits
  (for a later real request, for the library query to fail, or a short settle) before its negative assertion.
- `env.test.ts`: `ENV_KEYS` is derived from `loadEnv`.
- `pdf.test.ts`: truncated and garbage PDFs assert `InvalidPDFException`, and the empty file is its own test.
- `time.test.ts`: the default-timestamp test pins `TZ=Asia/Tokyo`, so it catches a `localtime` default on a UTC machine.
- `PaperCard.test.tsx`: asserts the card contains only the title and "No abstract available.".
- `qa.test.ts`: the invalid-JSON test asserts the body. It is `{ "error": "Malformed JSON in request body" }`,
  the same shape as other errors, so the earlier note about a plain-text body was wrong for this route.
- `useAskQuestion.test.tsx`: the overlapping-ask race test is deleted, since the planned change removes that branch.
- Input reset (`UploadBox.test.tsx`) needed no change. A probe showed that without the reset the input keeps
  `C:\fakepath\paper.pdf` and a second upload of the same file fires no `change` event, so both assertions
  in that test discriminate.

## Tests that could pass when they shouldn't

| Location | Problem | Suggested fix |
| --- | --- | --- |
| `web/pages/Search.test.tsx:166-174` (blank query submitted directly) | The `queries` list is filled when a request reaches the mock server, which is after the test reads it, so that half can't fail. The "Searching…" check might catch a removed guard, but this was not verified. The plan's premise is also off: the real guard is `enabled: submitted !== ""` on the query, and `onSubmit` has no guard of its own. | Wait for any request before asserting none was made, and describe the real guard in the test name. |
| `web/pages/Paper.test.tsx:73-80` (rejects an invalid id) | The "Invalid paper id." assertion does catch a removed guard, because only the guard renders that message. The `paths` equal `[]` half can't fail: requests are recorded asynchronously and the list is read right after render. So it would miss code that shows the error and also sends a request. (The review first said the whole test would pass without the guard, which was too strong.) | Await a flush (`waitFor` or similar) before asserting no request. Add a positive control from the accepted-ids table. |
| `web/pages/Search.test.tsx:196-207` (library fails to load) | The negative checks (`queryByText("Library down")`, `.error` is null) run as soon as the heading appears, before the `/api/papers` 500 has arrived. A regression that shows a library error could pass. | Wait for the library request or its failure first. Replace `document.querySelector(".error")` with a role query. |
| `web/components/Chat.test.tsx:288-307` (second submit while streaming) | Counts requests only after the stream finishes. A broken guard fires its second request asynchronously, so this could pass anyway. | Wait for a settled state before counting, or assert the count at a point where a late request would already have arrived. |
| `web/components/UploadBox.test.tsx:190-203` (drop while pending) | No wait after the second drop, so a second request sent late could slip through. | Wait after the second drop before asserting. |
| `web/components/UploadBox.test.tsx:136-144` (input reset) | Only the `value === ""` assertion discriminates. The re-upload assertion may pass without the reset, because `user.upload` fires `change` anyway. Not confirmed that the value assertion fails when the reset is removed. | Confirm the value assertion fails without the reset, or make the re-upload assertion depend on it. |
| `server/env.test.ts:7, 41, 106-109` | `ENV_KEYS` is a hardcoded list. "has every key the schema knows" and the all-empty-strings test won't notice a new schema key. | Derive the list from `Object.keys(loadEnv({ GEMINI_API_KEY: "k", S2_API_KEY: "s" }))`, as the test at line 102 does. |
| `server/routes/upload.test.ts:60-66` (12,000-character cap) | Always passes. pdf.js extracts only 81 characters from the 13,000-character page the `makePdf` fixture builds, so `toBeLessThanOrEqual(12_000)` holds even if the cap were removed. `toBe(12_000)` would fail for the same reason, because only 81 characters arrive. | Build a PDF with enough pages for more than 12,000 extracted characters (about 150 at this rate, as the 4600-page `paperText` test does for its own limit), then assert `toBe(12_000)`. |
| `server/services/pdf.test.ts:99-102` | Truncated-PDF rows assert only `rejects.toThrow()`, so any error type passes. The `0` fraction gives the unclear name "cut off at 0 of its length". | Assert the error type the plan names (`InvalidPDFException`). Rename the zero row. |
| `server/db/time.test.ts:28-33` | The "within 5s of now" check catches a `datetime('now', 'localtime')` mistake only when the machine's timezone isn't UTC. On a UTC CI machine it passes either way. An environmental limit. | Run the file with a non-UTC `TZ`, or note the limit in a comment. |
| `web/components/PaperCard.test.tsx` ("omits missing parts") | No longer checks that an empty authors list renders no byline. The `.byline` query was removed and nothing replaced it. | Add a role-based assertion for the missing byline. |
| `web/components/Chat.test.tsx` ("refetches") | Checks that the fetch count reaches 2, not that it stays at 2. | Also assert it stays at 2 after a settle. |
| `server/routes/qa.test.ts:188-193` (invalid JSON) | Checks only the status, not the error body. | Also assert the `{ error }` body. |

## A test that conflicts with the plan

`web/useAskQuestion.test.tsx:337`, "lets stop() reach a newer question after an older one finished":

- It starts a second `ask` while the first is in flight. The planned change makes `ask` ignore that call (it
  returns false immediately), so this test breaks once the change lands.
- It depends on request order: `responses.shift()` assumes request one reaches the MSW handler before
  request two, and `waitFor(streaming)` doesn't guarantee that.
- It passes today, and it does exercise the `controller.current === abort` check.

Delete it, or mark it clearly as pinning behavior that the planned change removes.

## Minor test issues

- `web/useAskQuestion.test.tsx:265`: `mockImplementationOnce` with `restoreMocks: true` may leak into the next
  test if `ask` never reaches it. Only matters when the test is already failing.
- `web/pages/Library.test.tsx:112-135`: `release()` has no `try/finally`, unlike the Paper and Search pending
  tests. If an assertion fails the DELETE stays blocked.
- `web/components/Chat.test.tsx:310`: `deferred` stays pending if the test fails before `gate.resolve()`.
  Harmless, because cleanup aborts.
- `web/pages/Paper.test.tsx:143-147` (year 0): the `toHaveTextContent` line is redundant with the heading
  query.
- `web/pages/Search.test.tsx:176-194`: the `failing` flag is an awkward way to check that a second request
  happened.
- `server/routes/summary.test.ts:193`: `update.mockRestore()` is redundant now that `restoreMocks` is on.
- `server/services/paperText.test.ts`: `vi.clearAllMocks()` in `afterEach` is redundant with `restoreMocks`.
- `server/routes/qa.test.ts:203`: the empty-answer test pins a behavior the plan said to decide on, but has no
  comment saying so.
- `server/env.test.ts:93-99`: the `.env.example` "loads" test asserts blank values only for the two API keys.
- `server/env.test.ts:40`: the empty-strings test is one test over all keys, so a failure won't say which key.

## Plan corrections in `TESTING.md`

- **Empty upload filename.** The plan says it gives `Untitled`. An empty-named file arrives as a plain string,
  so the route returns 400. `Untitled` is reachable only for the name `.pdf`. The implemented 400 test is the
  right substitute.
- **Unparseable PDF note (around lines 568-569).** It says the case "can't be told apart from No text found".
  The source (`paperText.ts:39` vs `:42`) already has distinct messages, so this is outdated.
- **Blank search query guard.** The plan treats the form's `onSubmit` as a guard. The real guard is
  `enabled: submitted !== ""` on the query.
- **`useAskQuestion.ts:53` gap entry.** It should say outright that there is no race test, because the planned
  change removes that branch.
- **Skipped on purpose.** The type-level `@ts-expect-error` checks and the `parseSqliteTimestamp` tests in
  `db/time.test.ts` are not written, because `SqliteTimestamp` doesn't exist yet. They wait for the source
  change.

## Style (lower priority)

- **Test titles and names**
  - `server/routes/upload.test.ts:107` and `:125`: `it.each` titles print the expected value in the wrong
    slot ("treats the year 999 as 999" when the result is null). Use a label column for the expected outcome.
    The title-table names are also awkward ("uses the title .pdf from the filename as Untitled").
  - `web/components/Chat.test.tsx:194-233`: the `it.each` field `gone` holds the element that should be
    present. `present` would be clearer.
  - `server/env.test.ts:120`: names like "PORT=0: accepted is false" read awkwardly, and the intentionally
    failing rows are marked only by a comment.
  - `web/pages/Search.test.tsx:199`: `saveError` is used for a library load failure.
  - `useAskQuestion.test.tsx:225-227`: the `it.each` table mixes a string and a RegExp for `toMatch`, so the
    string row is a substring match.
- **Typing**
  - `server/services/llm.test.ts`: many `as never` casts (lines 103, 171, 181, 233, 296, 299, 304, 315) and
    `as GenerateContentResponse` / `as GeminiClient[...]` casts. A typed `fakeResponse` helper would remove most
    of them.
  - `web/api.test.ts` (lines 84-86, 98-100, 105-107, 166-168): `.catch((e) => e)` is implicitly `any`, and line
    114 types it as `unknown`. A small helper returning `unknown` or `Error` would fix it.
  - `server/routes/qa.test.ts:37`: the `messages()` helper still casts `as QaMessage[]`.
  - `as { error: string }` and `(await (await upload(...)).json()) as Paper` repeat across `qa`, `summary` and
    `upload`. A small `errorOf(res)` helper would help.
  - `web/pages/Search.test.tsx:10` has an unnecessary `[] as SearchResult[]`, and `Paper.test.tsx:37` uses
    `ReturnType<typeof makeMessage>[]` instead of `QaMessage[]`.
  - `schemas.test.ts:45`: `metadata as Record<string, unknown>` and an unused `_omitted` binding may trip lint.
    `web/components/UploadBox.test.tsx` has `as File` casts and an untyped `saved` fixture.
- **Queries**
  - Class-name queries where role queries would work: `.message` (including the brittle count at
    `Chat.test.tsx:173`), `.actions-end`, `.badge`, `.dropzone`, `container.querySelector("details")`.
  - "Choose file" is found with `getByText` and not by role.
  - The helpers `usePaper`, `useLibrary` and `useBackend` in the page tests use a `use` prefix but aren't hooks,
    which risks the react-hooks lint rule. Something like `servePaper` would be clearer.
- **Duplication**
  - `deferred` is duplicated across the Chat and UploadBox test files.
  - The trimmed-question check is in both the Chat "streams an answer" test and "sends the trimmed question".
  - `semanticScholar.test.ts:104-114` and `:147` repeat the whole-array assertion at `:67` and the table at
    `:116`. The fixture's `total: 4` is stale, since it has 7 items.
  - `qa.test.ts:73` ("HISTORY_MESSAGES + 4") largely duplicates the new boundary table, so it could become a
    table row.
  - `upload.test.ts`: the first test still bundles mapping, trimming, the blank-author filter and the list check.
    The plan marked splitting it as optional.
  - `papers.test.ts:187-193`: a loop inside `it.each` means the first failing method hides the second.
  - `papers.test.ts:150-166`: the round-trip uses `toMatchObject` and not `toEqual`, and the second author set
    is checked only on the save response.
  - `papers.test.ts:171-185`: the field regex `.*${field}:` is loose, so `title:` could match an unrelated part
    of the message.
  - `papers.test.ts:169`: an unused `_abstract` destructure.

## Behaviors the tests pin that you may want to decide on

- A thrown non-`Error` value (for example a string) escapes `app.request` with no 500 and no log
  (`app.test.ts:37-46`, commented as pinned behavior).
- An empty upload filename gives a 400 (`file: expected File, received string`) (`upload.test.ts:135`).
- An empty model answer saves an empty assistant message (`qa.test.ts:203`).
- Exactly `MAX_PDF_BYTES` gets a 413 (`upload.test.ts`, commented).
