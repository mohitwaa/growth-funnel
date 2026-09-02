# Notes — assumptions, trade-offs, and what I added

## What I did first

I instrumented the reference funnel in a real browser and diffed its `dataLayer`
against what actually left the machine. Across a full 19-step walk Meta received
only `PageView` and an auto-collected button click — no `Lead`, no CAPI, and no
Google Ads tag at all — while a 40-field `dl_context` (grade, `FB_event_ID`,
`fbp`) sat unused in `localStorage`. So the problem wasn't "collect more data",
it was **activate the data already there**. That framing drove everything below.

## Key decisions

**One identity, three layers.** The phone *is* the lead in this vertical — TCPA
consent attaches to it — so it drives all three: `event_id = hash(phone, event)`
for deduplication, `external_id = [anon_id, phone]` for matching, and the
Airtable lookup for duplicate suppression. A per-session id is wrong in a
specific way: it tells Meta that one person on two devices is two people.

**Deduplication is a browser-originated contract.** Meta merges Pixel and CAPI
only on an identical `event_id`; a webhook cannot attach one retroactively.
`track()` mints it, the Pixel fires with `eventID`, n8n reuses it verbatim.
Verified live: `capi_event_id == browser eventID`, `events_received: 1`.

**Retries are idempotent rather than avoided.** My first outbox double-sent
everything — with no CORS headers `fetch` rejected on requests that had actually
landed. Fixed by making the retry safe (stable `event_id`, upsert on
`idempotency_key`), not by removing it.

**Special-category data never reaches an ad platform.** Disability and financial
answers travel in `event.private` behind a `firstParty` flag; Meta gets a derived
`lead_quality_tier` — same optimisation signal, none of the policy exposure.

**No blocking call on submit.** The outbox persists, retries with backoff and
replays on next load. Blocking adds a failure mode without adding a guarantee.

## Trade-offs

- One row per lead, upserted on `lead_key` (the session) rather than one row per
  event. The row must exist before a phone does, so identity is a second column,
  never the row key.
- Airtable via HTTP Request nodes, not n8n's Airtable node — the exact
  `performUpsert` I had already verified, with no node-version drift.
- SHA-256 inlined in the n8n Code nodes: the sandbox blocks `require('crypto')`.
- Tags load immediately. Deferring them buys Core Web Vitals at the cost of every
  conversion and bounce that happens before they fire.

## Extra, beyond the brief

Drop-off tracking with step and dwell time, separating *confusing* from *hard
stop*; lead scoring driving value-based bidding ($72 for an A, $5 for a D);
`_fbc` following the latest click while `click_ids` keeps first touch; a Dead
Letter table plus a browser dead-letter beacon; and conversion gating modelled on
the reference funnel's own `user_found` logic.

## Bugs this process caught

Ten, all found by testing rather than review. Four would have corrupted revenue
while looking healthy: the double-send, retry-as-second-conversion, an
out-of-order replay downgrading a closed $72 lead back to a $0.50 partial, and a
cross-device duplicate. The last taught the most — suppressing the server call
does not fix it, because the browser Pixel has already reported the conversion.
The bug was upstream, in what `event_id` identified.

## Known gaps

"Deduplicated" is not visually confirmed in Events Manager; I proved both halves
send one id and Meta accepted both, but the UI verdict needs a test event code.
First-visit matching leans on Automatic Advanced Matching, because advanced
matching can only be set on the Pixel's first `init` — verified against a live
pixel. No consent platform: fine for US traffic, required before EU. Time
exceeded the 6–8h guide; I chose depth on tracking correctness over breadth.
