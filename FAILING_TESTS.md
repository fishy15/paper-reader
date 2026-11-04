# Failing tests to address

These 34 tests fail on purpose. Each describes behavior that `ISSUES.md` lists as a planned fix, and the source
doesn't have it yet. Every other test in the repo passes (server 326, web 175). They are written as ordinary tests,
not `it.fails`, so each one goes green once its source change is made.

**Source changes need approval.** This file lists the work for the agents that will make these changes, and it does
not authorize them. The rule that source files aren't edited without asking first still applies.

Paths are relative to `server/src` or `web/src`. The failure text is what the test reports today.

## Suggested split (7 agents, one per area)

| # | Area | Tests | Source files to change |
| --- | --- | --- | --- |
| 1 | Server config | 8 | `server/src/env.ts`, `.env.example` |
| 2 | Timestamps | 1 | `server/src/db/time.ts`, `server/src/db/schema.ts` |
| 3 | Rate limiter | 4 | `server/src/services/rateLimiter.ts` |
| 4 | Server services | 6 | `services/llm.ts`, `services/paperText.ts`, `services/semanticScholar.ts` |
| 5 | Web API client | 3 | `web/src/api.ts`, `web/src/qaStream.ts` |
| 6 | Web routing and display | 7 | `web/src/App.tsx`, `components/PaperCard.tsx`, `pages/Paper.tsx` |
| 7 | Web chat, upload, search | 5 | `web/src/useAskQuestion.ts`, `components/UploadBox.tsx`, `pages/Search.tsx` |

## Order

Wave 1: agents 1, 3, 4, 5, 6, 7 in parallel (disjoint source files). Wave 2: agent 2 alone, after wave 1, because the
`SqliteTimestamp` type change can break compilation across the server.

## Ground rules for each agent

- Read only the `ISSUES.md` section named in your area, the source files listed, and the test files that contain
  your failing tests. Don't read all of `ISSUES.md` or `TESTING.md`.
- Make the smallest source change that follows the "Planned fix" in `ISSUES.md`. Don't refactor beyond it.
- Run only the test files for your area while you work. At the end the listed tests must pass, and no other
  test in those files may change status.
- If a test that passes today breaks, it probably pinned the old behavior. Don't edit it silently: report which
  test and why, and wait for a decision.
- Don't edit a failing test to make it pass. If you think a test is wrong, report it.
- Run `npx tsc --noEmit -p server` or `-p web` for the workspace you changed.
- Don't edit `ISSUES.md`. Put the text for the "fixed" note in your report; the coordinator marks the entries.
- Don't commit.
- Report in under 250 words: what changed in which file, tests now passing, and anything unexpected.

---

## 1. Server config (8 tests)

`ISSUES.md`: "Configuration (`.env`)". Test file: `env.test.ts`.

**Planned fix:** trim values before the empty check, and accept `PORT` only as an integer from 1 to 65535. Resolve
a relative `DATA_DIR` against the repo root (the same base as the default), leave absolute paths alone, and add
`DATA_DIR` to `.env.example`.

| Test | Fails today with |
| --- | --- |
| `.env.example` has every key the schema knows | `DATA_DIR` is missing from the file |
| PORT range / planned fixes: rejects PORT=0 | `loadEnv` doesn't throw |
| PORT range / planned fixes: rejects PORT=-1 | `loadEnv` doesn't throw |
| PORT range / planned fixes: rejects PORT=70000 | `loadEnv` doesn't throw |
| planned fixes: treats whitespace-only PORT as unset | `PORT` is `0`, expected the default `3000` |
| planned fixes: treats whitespace-only HOST as unset | `HOST` stays `" "`, expected `127.0.0.1` |
| planned fixes: treats whitespace-only GEMINI_RPM as unset | throws a `ZodError` instead of using the default |
| planned fixes: resolves a relative DATA_DIR against the repo root and leaves an absolute one alone | returns `'my-data'` unchanged |

Add `DATA_DIR=` to `.env.example` as a blank line, not a real value (the blank-values test relies on that).

Notes: `web/vite.config.ts` hard-codes the dev proxy to `127.0.0.1:3000`, so changing `PORT` or `HOST` in `.env`
still breaks `npm run dev`. That is a separate issue and not part of these tests.

## 2. Timestamps (1 test now, more after the change)

`ISSUES.md`: "Timestamps". Test file: `db/time.test.ts`.

| Test | Fails today with |
| --- | --- |
| toIsoUtc: fails when a corrupt created_at is read from the database | reading a row with an ISO `created_at` doesn't throw |

**Planned fix:** a branded `SqliteTimestamp` type with one checked constructor, `parseSqliteTimestamp` (throws on an
ISO string, an empty string, `"not a date"`, a date with no time). A drizzle `customType` for `created_at` on both
tables, whose `fromDriver` is `parseSqliteTimestamp`. `toIsoUtc` takes only `SqliteTimestamp`. The `datetime('now')`
default and the `text` column type stay the same. Run `db:generate` and check that it produces no new migration.

**After the change, write the tests that were left out** (they can't compile until the type exists), described in
`TESTING.md` under `db/time.test.ts`:
- the constructor accepts `"2026-10-08 12:00:00"` and returns it unchanged,
- it throws for an ISO string, `""`, `"not a date"` and a date with no time (one `it.each`),
- type-level `// @ts-expect-error` checks: `toIsoUtc` with a plain `string` or a string literal doesn't compile,
  inserting a plain `string` into `created_at` doesn't compile, and the constructor's result compiles.

## 3. Rate limiter (4 tests)

`ISSUES.md`: "Rate limiter". Test file: `services/rateLimiter.test.ts`.

**Planned fix:** at the start of `createRateLimiter`, assert `requestsPerMinute` is a finite number greater than 0
and throw a `RangeError` otherwise.

| Test | Fails today with |
| --- | --- |
| rejects 0 requests per minute | function doesn't throw |
| rejects -1 requests per minute | function doesn't throw |
| rejects NaN requests per minute | function doesn't throw |
| rejects Infinity requests per minute | function doesn't throw |

## 4. Server services (6 tests)

`ISSUES.md`: "Summaries" (the truncation and whitespace-only items) and "Paper search (Semantic Scholar)".

| Test file | Test | Fails today with | Planned fix |
| --- | --- | --- | --- |
| `services/llm.test.ts` | gemini llm: treats a whitespace-only response as no content | the promise resolves `''` instead of rejecting | In `generate`, treat a whitespace-only response like an empty one and throw the existing "no content" error (with the finish reason), so nothing is saved. |
| `services/paperText.test.ts` | limitPaperText: never splits a character outside the basic plane when it straddles the cut | the output ends in a lone surrogate | In `limitPaperText`, back off one UTF-16 unit when the last kept unit is a high surrogate. |
| `services/semanticScholar.test.ts` | trims author names and drops blank ones | gets `['  Ada ', '   ', 'Bob']`, expected `['Ada', 'Bob']` | In `toSearchResult`, trim author names and drop blank ones, as the upload route's `cleanMetadata` does. |
| `services/semanticScholar.test.ts` | reports an HTML body as a 502 | a raw `SyntaxError` escapes | Map failures from `await res.json()` to a `SearchProviderError` with status 502. |
| `services/semanticScholar.test.ts` | reports an empty body as a 502 | a raw `SyntaxError` escapes | same |
| `services/semanticScholar.test.ts` | reports a body read that is aborted as a 502 | a raw `DOMException` escapes | same |

For the three 502 tests: wrap only `await res.json()` in a try/catch and throw
`SearchProviderError("Unexpected response from Semantic Scholar", 502)`. Don't wrap the whole of `search()`, so the
429 and `!res.ok` errors keep their own handling. The only abort in this file is its own `AbortSignal.timeout`, so
mapping an abort to 502 is correct here, the same as `request()` does for the fetch.

## 5. Web API client (3 tests)

`ISSUES.md`: "Web API client".

| Test file | Test | Fails today with | Planned fix |
| --- | --- | --- | --- |
| `api.test.ts` | falls back to the status code for an empty error message | message is `''`, expected "Request failed (500)" | In `ErrorBody` require a non-empty string (`z.string().min(1)`), so an empty one falls back. |
| `api.test.ts` | turns a network failure into an ApiError | a raw `TypeError: Failed to fetch` | Wrap non-abort fetch rejections in an `ApiError` with a message like "Could not reach the server". Leave `AbortError` unchanged. |
| `qaStream.test.ts` | wraps a connection lost mid-answer in an ApiError | a raw `TypeError: terminated` | In `qaStream.ts` wrap non-abort `reader.read()` failures in an `ApiError` such as "The connection was lost before the answer finished". Leave `AbortError` unchanged. |

Keep `AbortError` untouched: the abort tests in the same files pass today and must keep passing.

## 6. Web routing and display (7 tests)

`ISSUES.md`: "Web routing" and "Web display".

| Test file | Test | Fails today with | Planned fix |
| --- | --- | --- | --- |
| `App.test.tsx` | shows a not-found page for /nope | "Page not found" isn't found (empty `main`) | Add a catch-all route in `App.tsx` that shows "Page not found" with a link to Search. |
| `App.test.tsx` | shows a not-found page for /papers | same | same |
| `App.test.tsx` | shows a not-found page for /papers/1/extra | same | same |
| `components/PaperCard.test.tsx` | shows no extra text for a year of 0 | the heading reads "…You Need0" (a stray `0`) | Use a ternary or `!= null` instead of `{paper.year && ...}`. |
| `pages/Paper.test.tsx` | shows no stray 0 when the year is 0 | the heading is "Ancient" and "0" as separate nodes | same, in `Paper.tsx` |
| `pages/Paper.test.tsx` | does not carry a summarize error over to another paper | "No PDF link" is still shown on paper 2 | Put `key={id}` on `PaperDetail` in `Paper.tsx`. |
| `pages/Paper.test.tsx` | does not carry a pending summarize over to another paper | "Summarizing…" is still shown on paper 2 | same |

The optional refactor in `ISSUES.md` (a shared header component for `PaperCard` and `PaperDetail`) isn't needed for
these tests. Don't do it unless asked.

## 7. Web chat, upload and search (5 tests)

`ISSUES.md`: "Web chat", "Web upload", "Web search".

| Test file | Test | Fails today with | Planned fix |
| --- | --- | --- | --- |
| `useAskQuestion.test.tsx` | ignores a second ask while one is in flight | `ask` resolves `true`, expected `false` | Ignore a second `ask` while one is in flight: return `false` and check the controller ref, not React state. This should make the race branch at `useAskQuestion.ts:53` unreachable. Confirm that before removing it; if it can still be reached, leave it and report. |
| `components/UploadBox.test.tsx` | ignores a drop while an upload is pending | uploads were `['first.pdf', 'second.pdf']` | Ignore drops while an upload is pending. |
| `components/UploadBox.test.tsx` | tells the user when only the first of several dropped files was uploaded | "Only paper.pdf was uploaded" is never shown | Show a short notice when several files are dropped, such as "Only paper.pdf was uploaded". |
| `pages/Search.test.tsx` | searches again when the same query is submitted after an error | no second request, "Second try" never appears | When the trimmed query equals the submitted one, call `results.refetch()`. |
| `pages/Search.test.tsx` | clears a save error when a new search is submitted | "Could not save" stays under the new results | Call `save.reset()` when a search is submitted. |

There is deliberately no test for the `useAskQuestion.ts:53` branch (see `TESTING.md`). After the fix, the
coverage report may show that line as gone.

---

## Done when

- All 34 tests above pass, and the server and web suites are green.
- No test outside this list changes status, and `tsc --noEmit` is clean for both workspaces.
- Each matching `ISSUES.md` entry is marked fixed.
- The tests left out for the timestamp change (section 2) are written.
