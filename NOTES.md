# Notes — assumptions, trade-offs, and what I added

## What I did first

Before writing any code I instrumented the reference funnel in a real browser and diffed its `dataLayer` pushes against what actually left the machine. Three findings shaped this build:

- Meta received **only `PageView` and the auto-collected `SubscribedButtonClick`** — no `Lead`, no CAPI, across a full 19-step walk.
- **No Google Ads conversion tag at all** (`AW-` absent).
- A rich `dl_context` object (40+ fields — grade, `contact_value`, `FB_event_ID`, `fbp`) sat in `localStorage` and reached *no* ad platform.

So the diagnosis wasn't "collect more data", it was **"activate the data you already have."** That framing drove everything below.

## Key decisions

**Deduplication is a shared contract, not a webhook feature.** Meta merges browser and server events only when both carry the same `event_id`. The browser must originate it — a webhook can't retroactively attach one. `track()` generates one UUID; the Pixel fires with `eventID`, n8n reuses it verbatim for CAPI. Verified live: `capi_event_id == browser eventID`, `events_received: 1`.

**Retries must be idempotent, not avoided.** My first outbox double-sent every event: the receiver had no CORS headers, so `fetch` *rejected on a request that had actually landed*, and my retry sent it again. Fixed by making retries safe — stable `event_id` + upsert on `idempotency_key` — rather than removing them.

**Conversion IDs are stable across retries.** A resubmit with a fresh `event_id` is a *second* conversion to Meta. IDs are generated once per session and reused, so a lost response can't double-count.

**Special-category data never reaches an ad platform.** Disability/financial answers travel in an `event.private` block gated by a `firstParty` flag; PII is gated by `acceptsPii`. Meta gets a derived `lead_quality_tier` (A–D) instead — same optimisation signal, none of the policy exposure. There's a test asserting the serialized CAPI body contains neither the raw answers nor a cleartext email.

**No blocking call on submit.** The outbox already guarantees delivery with retry + persistence. Blocking the user adds a failure mode without adding a guarantee — a request that succeeded but lost its response would show an error to someone whose lead we already have.

## Trade-offs

- **One row per lead, upserted on `lead_key`**, not one row per event. Keeps writes inside Airtable's 5 req/s limit and gives one record showing how far each lead got.
- **Airtable via HTTP Request nodes**, not n8n's Airtable node — uses the exact `performUpsert` call I'd already verified, avoiding node-version drift.
- **SHA-256 inlined** in the n8n Code nodes: the sandbox disallows `require('crypto')`. Verified byte-identical to `node:crypto`.
- **Tags load immediately**, not deferred. The reference funnel delays GTM 3s after `window.load`, buying Core Web Vitals at the cost of every conversion and bounce before it fires.
- **`api/lead.ts` is not wired in.** It's the self-hosted CAPI relay for teams who'd rather not depend on n8n. Kept as a documented alternative, not dead code in the live path.

## Extra, beyond the brief

- **Drop-off tracking** — `funnel_abandoned` on exit with step, step name and dwell time. Distinguishes *confusing* (long dwell) from *hard stop* (fast exit); those need opposite fixes. Step-1 bounces are recorded rather than left blank.
- **Lead scoring → value-based bidding.** An A lead sends `value: 72`, a D sends `15.75`, so Meta optimises for quality rather than volume.
- **Attribution correctness** — `_fbc` follows the *latest* click (Meta's semantics) while `click_ids` keeps first touch. Getting this wrong credits a returning visitor's conversion to the wrong campaign.
- **Dead Letter table** + browser dead-letter beacon, so failures are visible and replayable.
- **Conversion gating**, modelled on the reference funnel's own logic. Reading its `/result` `executionLog` showed the conversion is gated behind `ctc_clicked != true`, `user_found == false` and a grade/age band — it is not fired on every submit. We implement the same three gates, with one deliberate difference: a lead below the grade bar still sends a conversion at low value rather than nothing, because Meta's model needs weak leads to learn what a strong one looks like.
- **`tools/verify-n8n.mjs`** — runs the n8n Code nodes against a captured payload, 28 assertions. Re-runnable after any edit.

## Bugs this process caught

Nine, all found by testing rather than review. Two came from the n8n dry run
alone: a `fields[]` query parameter that n8n silently collapsed (duplicate
object keys), which meant the ordering guard read `undefined` and never fired;
and the guard depending on that lookup at all. Correctness now sits in the
mapper, where no network call can undermine it, with the lookup as layer two. Three would have corrupted revenue data while looking healthy: the double-send, retry-as-second-conversion, and out-of-order replay downgrading a completed $72 lead back to a $0.50 partial.

## Known gaps

- **"Deduplicated" not visually confirmed** in Events Manager. I proved both halves send the same `event_id` and Meta accepted both; the UI verdict needs a Test Event Code.
- **First-time-visitor matching depends on Automatic Advanced Matching** being enabled — manual advanced matching can only be set on the Pixel's *first* `fbq('init')`; a later `init` or `set userData` is silently ignored (tested against a live pixel). AAM is on and verified emitting hashed `em`/`ph`.
- **No consent management platform.** Fine for US traffic; would be required before EU/UK.
- Time spent exceeded the 6–8h guide. I chose depth on tracking correctness and reliability over breadth, since that's what the role weighs.
