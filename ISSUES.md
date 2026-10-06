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
