# Growth Funnel

A React lead-gen funnel, built so growth-automation work can be added later without touching funnel code.

```bash
npm install
cp .env.example .env.local
npm run dev
```

`?debug=1` logs every event with its dedupe key to the console.

## Seven files

```
src/
├── main.tsx          entry — starts tracking, fires funnel_start        19
├── App.tsx           all funnel state + every tracking call            134
├── funnel.ts         the funnel as data + lead scoring                 193
├── tracking.ts       identity + track()                                172
├── destinations.ts   ← every place events go. THE EXTENSION POINT.     123
├── screens.tsx       3 screens + validation + shared bits              302
└── styles.css        tokens + styling                                  237

api/lead.ts           server relay: Meta CAPI + your CRM                139
```

No context, no provider, no state manager. `App.tsx` holds the state, screens take props, tracking is a module singleton.

## Adding a platform

Open `destinations.ts`, write one object, append it to the array:

```ts
const tiktok: Destination = {
  name: 'tiktok',
  acceptsPii: true,
  init(id) { /* load sdk */ },
  send(event) {
    window.ttq?.track('CompleteRegistration', event.params, { event_id: event.id });
  },
};

export const destinations = [webhook, meta, tiktok];
```

No call site changes. Every destination gets the same event with the same `event.id`, so the dedupe key is shared automatically and no platform can be silently skipped.

## Adding a step

Append to `steps` in `funnel.ts`:

```ts
{
  kind: 'question',
  id: 'income_band',                              // stable key — analytics depends on it
  question: 'What is your household income?',
  when: (a) => a.work_status !== 'not_working',   // optional
  choices: [{ value: 'lt_2k', label: 'Under $2,000', score: 20 }],
}
```

## Meta event quality

**Dedupe.** Meta merges a browser and a server event only when both carry the same `event_name` **and** the same `event_id`. `track()` generates one UUID and returns it; the Pixel fires with `{ eventID }` and `App.tsx` sends the same value to `/api/lead` → CAPI.

> Must be unique **per event**. A user or session id makes every event dedupe into one — silently.

**Match quality.**

| Signal | Source |
|---|---|
| `fbp` | Cookie, re-read right before each send (the Pixel writes it async, so a boot snapshot misses the first event) |
| `fbc` | Cookie, or built from `fbclid` in `index.html`. **Overwritten on every new `fbclid`** so a returning visitor's conversion isn't credited to the old campaign |
| `client_ip_address` | Request socket, server-side — never a client field |
| `em ph fn ln` | SHA-256, trimmed + lowercased; phone as E.164 |
| `external_id` | Hashed stable id — cross-session matching, zero PII |

**Value.** Every conversion carries a value from the lead grade. An A lead is worth ~4.5× a D lead, so Meta optimizes for quality not volume.

## The webhook

Full contract in [WEBHOOK.md](WEBHOOK.md).

**Every** event POSTs to `VITE_WEBHOOK_URL`. Until it's set, the payload is logged instead (`?debug=1`) and nothing is sent.

One key routes it:

```jsonc
{
  "action": "meta_capi_and_crm",   // ← switch on this
  "event":       { "id": "…", "name": "lead_submitted", "value": 72, "params": {…} },
  "identity":    { "fbp": "…", "fbc": "…", "user_agent": "…", "client_ip": null },
  "user":        { "email": "…", "phone": "…", … },      // raw PII
  "attribution": { "click_ids": { "gclid": "…", "fbclid": "…" }, … },
  "device":      { "language": "…", "timezone": "…", "screen": "…" },
  "meta":        { "should_send": true, "user_data": { "hash_these": {…}, "send_plain": {…} }, … },
  "private":     { "answers": {…}, "score": {…} }        // ⚠️ CRM only
}
```

| `action` | Do |
|---|---|
| `track_only` | Store only |
| `meta_capi` | Send to Meta CAPI |
| `meta_capi_and_crm` | CAPI **and** create the CRM record |
| `alert` | Notify — a submission failed |

Remap in `ACTIONS` at the top of `destinations.ts`.

Your receiver fills `client_ip` from the socket and SHA-256s `meta.user_data.hash_these` **exactly as given** — those values are pre-normalised to Meta's spec, so re-normalising or hashing raw input silently kills matching.

## Privacy boundary

Qualification answers are special-category data (health, disability, finances) that Meta and Google both prohibit receiving. Enforced in two layers:

- `event.private` carries the raw answers and reaches **only** destinations flagged `firstParty` — never Meta.
- `event.user` (PII) reaches only destinations flagged `acceptsPii`.
- Ad platforms get `adParams()` instead: `lead_quality_tier`, `lead_score`, `qualified` — same optimization signal, none of the exposure.

## Deploying `api/lead.ts`

Web Fetch types, so: Vercel as-is · Next.js App Router `export const POST = handleLead` · Cloudflare/Deno/Bun `export default { fetch: handleLead }`.

Server-only vars (never `VITE_`-prefixed — that compiles into the public bundle):

```
META_PIXEL_ID=
META_CAPI_ACCESS_TOKEN=
META_TEST_EVENT_CODE=
LEAD_WEBHOOK_URL=
```

## Verifying

1. `?debug=1` — each event fires once with a unique dedupe key
2. Events Manager → Test Events with `META_TEST_EVENT_CODE`
3. Confirm the pair shows **Deduplicated**, not two events
4. Check Event Match Quality — expect 8+/10

## Notes

- Pinned to Vite 6 / TS 5.7 for Node 20.14; on Node ≥20.19 you can move to Vite 8.
- Tags load immediately. Deferring the tag manager buys Core Web Vitals at the cost of every conversion before it fires.
