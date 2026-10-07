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

## PDF upload limitations
- **Scanned PDFs are rejected.** Only PDFs with a text layer work; there is no OCR.
- **Duplicate uploads aren't detected.** Uploading the same file twice creates two papers
  (search results dedupe on `externalId`, uploads have no equivalent). A content hash column
  would fix this.
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
- **A Gemini rate limit during an upload is shown as a 500,** unlike summaries, which return 429.
