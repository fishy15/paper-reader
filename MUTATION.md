# Mutation testing notes

Run with `npm run mutation -w server` (about 3 minutes) or `npm run mutation -w web` (about 2 minutes).

Setup notes:
- Stryker runs in place because `server/tsconfig.json` extends `../tsconfig.base.json`, which the default sandbox copy can't resolve.
- There is no TypeScript checker, because TypeScript 7 has no JS API for Stryker to load. Mutants that don't compile count as errors (3).
- Incremental mode is off. It reused stale results after test edits and made the first baseline look better than it was.
- Don't run Stryker while other processes edit the tree. For a clean number, delete `server/reports` and `server/.stryker-tmp` first.

## Server scores

Both rows are clean runs (no cache).

| Snapshot      | Score  | Killed | Timeout | Survived | No coverage |
| ------------- | ------ | ------ | ------- | -------- | ----------- |
| Baseline      | 92.53% | 572    | 35      | 45       | 4           |
| After round 2 | 98.32% | 601    | 44      | 10       | 1           |

Per file, baseline to after (files that changed):

| File                          | Baseline | After   |
| ----------------------------- | -------- | ------- |
| `db/client.ts`                | 41.67%   | 83.33%  |
| `db/schema.ts`                | 80.00%   | 100.00% |
| `routes/qa.ts`                | 93.85%   | 100.00% |
| `routes/summary.ts`           | 90.91%   | 100.00% |
| `routes/upload.ts`            | 94.37%   | 100.00% |
| `services/llm.ts`             | 95.88%   | 100.00% |
| `services/paperText.ts`       | 95.00%   | 100.00% |
| `services/rateLimiter.ts`     | 95.45%   | 100.00% |
| `services/semanticScholar.ts` | 93.51%   | 97.40%  |
| `services/pdfDownload.ts`     | 96.15%   | 98.08%  |
| `env.ts`                      | 92.86%   | 100.00% |

## Remaining survivors (11, all judged equivalent or unreachable)

| Location                              | Why it survives                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `routes/papers.ts:29` (2 mutants)     | A CHECK constraint (`source='search'` iff `externalId` is not null) makes the branch unreachable. It only narrows the type. |
| `routes/papers.ts:37`, `search.ts:12` | `.get("/")` vs `.get("")` behave the same in Hono.                                                                           |
| `db/client.ts:17`                     | Running `mkdirSync(".")` for `:memory:` is a no-op.                                                                          |
| `db/client.ts:21`                     | The `schema` option only matters for relational `db.query`, which nothing uses.                                              |
| `services/pdf.ts:16`                  | unpdf's `mergePages` already defaults to false.                                                                              |
| `services/pdf.ts:17`                  | unpdf already trims page text, so `page.trim()` looks redundant. Candidate for removal.                                      |
| `services/pdfDownload.ts:17`          | A URL protocol always ends at its colon, so the `$` anchor can't matter.                                                     |
| `services/semanticScholar.ts:31`      | A non-object default still yields `[]` after `flatMap`.                                                                      |
| `services/semanticScholar.ts:105`     | An emptied catch leaves `body` undefined, so `safeParse` fails and throws the same 502.                                      |

## Web

Both rows are clean runs (no cache). Config is `web/stryker.config.json` (`src/**/*.{ts,tsx}` minus tests, `src/test/**` and `main.tsx`).

| Snapshot      | Score  | Killed | Timeout | Survived | No coverage |
| ------------- | ------ | ------ | ------- | -------- | ----------- |
| Baseline      | 94.50% | 410    | 2       | 23       | 1           |
| After round 2 | 97.71% | 424    | 2       | 9        | 1           |

| File                          | Baseline | After   |
| ----------------------------- | -------- | ------- |
| `components/UploadBox.tsx`    | 81.08%   | 94.59%  |
| `components/Chat.tsx`         | 97.56%   | 100.00% |
| `components/PaperCard.tsx`    | 94.44%   | 100.00% |
| `pages/Search.tsx`            | 88.24%   | 94.12%  |
| `apiError.ts`                 | 83.33%   | 100.00% |
| `queries.ts`                  | 92.00%   | 100.00% |

New tests: `apiError.test.ts`, `queries.test.tsx` (each mutation invalidates only the library list), plus additions to the Chat, PaperCard, Search and UploadBox tests.

### Remaining (10, judged equivalent)

| Location                  | Why it survives                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `qaStream.ts:45`          | `lines.pop() ?? ""`: `split` always returns at least one element, so the fallback never runs (no coverage). |
| `api.ts:10`               | `hc("/")` vs `hc("")` resolve to the same URLs.                                                              |
| `api.ts:25`               | `.catch(() => undefined)` vs `null`: `safeParse` fails on both.                                              |
| `UploadBox.tsx:12`        | `files?.[0]`: `pick` only gets `files` from events where it is never null.                                   |
| `UploadBox.tsx:37`        | `inputRef.current?.click`: the ref is always set once the button is on screen.                               |
| `Search.tsx:21` (3)       | Only non-search papers' `externalId` is affected, and no search result can collide with it.                  |
| `Search.tsx:56`           | `save.variables?.`: `isPending` is checked first, so `variables` is always set.                              |
| `useAskQuestion.ts:21`    | A constant in the effect's dependency array behaves like `[]`.                                               |
