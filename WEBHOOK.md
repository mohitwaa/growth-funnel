# Webhook contract

Every event fires to `VITE_WEBHOOK_URL` as a single POST. One key — `action` — tells you which branch to run.

## The switch key

```
action: "track_only" | "meta_capi" | "meta_capi_and_crm" | "alert"
```

| `action` | Fired by | What your webhook should do |
|---|---|---|
| `track_only` | `funnel_start`, `funnel_step` | Store it. No ad platform. |
| `meta_capi` | `contact_captured`, `call_clicked` | Send to Meta CAPI. |
| `meta_capi_and_crm` | `lead_submitted` | Send to Meta CAPI **and** create the CRM record. |
| `alert` | `lead_failed` | Notify — a submission broke. |

`funnel_abandoned` also routes to `track_only`. It fires on `pagehide` /
`visibilitychange` when the user leaves without converting, and carries
`step_index`, `step_id` and `time_on_step_ms`. Map it to `dropped_at_step`,
`dropped_at` and `time_to_interactive_ms` — that is what turns "partial" into an
actual drop-off curve. It is deliberately NOT sent to Meta.

Change the mapping in `ACTIONS` at the top of `src/destinations.ts`. Nothing else changes.

## Resilience contract — three things n8n MUST do

The browser holds an **outbox**: events are persisted to `localStorage` before sending, retried with backoff, and replayed on the next page load. Nothing is dropped when your webhook is down. That safety depends on your side honouring three rules.

**1. Return CORS headers.** Set the Webhook node's *Allowed Origins (CORS)* to your funnel's origin (or `*`). Without it the browser cannot read the response, every send looks failed, and the outbox retries forever. Events aren't lost — but they pile up instead of clearing.

**2. Be idempotent on `event.id`.** The outbox retries, so the same event can arrive twice. Upsert on `idempotency_key` (or check-then-skip). A retry of a request that actually landed must be absorbed, never re-processed — otherwise every network blip becomes a double conversion.

**3. Guard high-water-mark fields.** Replayed events arrive **out of order** — a retried `funnel_start` can land *after* `lead_submitted`. Plain last-write-wins silently downgrades a completed $72 lead back to a $0.50 partial. Verified: it corrupted `phase`, `value_usd`, and `highest_event_type` before this guard existed.

Add an Airtable **Search** node on `lead_key` before the upsert, and drop these fields when the incoming `highest_event_rank` is lower than the stored one:

```
phase · status · value_usd · grade · grade_score · grade_version
highest_event_type · highest_event_rank · step_reached_at
email · first_name · last_name · phone_e164 · zip · answers_json
```

Guard `furthest_step` separately by numeric max — it advances independently of event rank.

`tools/mock-webhook.mjs` implements all three; use it as the reference.

## Receiving the body

Sent as `Content-Type: application/json` with `keepalive`, so the body parses normally in n8n.

This requires CORS (rule 1 above) — the outbox has to read the response status to know whether to retry or clear. An earlier version used `text/plain` + `no-cors` to dodge the preflight, but that made delivery unverifiable: a request that landed looked identical to one that failed. Retrying on that ambiguity double-sent every event. The outbox plus idempotency replaces it — retries are now safe *because* the receiver dedupes.

## Who does what

Deduplication is a **shared contract** — it cannot live entirely on your side:

| Browser (this app) | Your webhook |
|---|---|
| Generates `event.id` (UUID, one per event) | Reuses that id **verbatim** as CAPI `event_id` |
| Fires the Pixel with `eventID` | Makes the CAPI call |
| Collects `fbp`, `fbc`, click IDs | SHA-256 hashing |
| Sends everything below | Fills real `client_ip` |

Meta merges the browser event and your server event only when **both** carry the same `event_name` and the same `event_id`, within 48 hours. If you change or regenerate the id, you get double-counted conversions.

## Sending to Meta — three steps

The `meta` block is pre-built. You only need to:

1. **SHA-256 every non-null value in `meta.user_data.hash_these`, exactly as given.**
   They are already trimmed and lowercased to Meta's spec, and the phone is already E.164. Do not re-normalise — and never hash the `send_plain` values.
2. **Merge** `hash_these` (hashed) + `send_plain` (as-is), and set `client_ip_address` from the request socket. Never trust a client-supplied IP.
3. **POST** to `https://graph.facebook.com/v21.0/<PIXEL_ID>/events?access_token=<TOKEN>`:

```json
{ "data": [{
  "event_name":       meta.event_name,
  "event_time":       meta.event_time,
  "event_id":         meta.event_id,
  "action_source":    meta.action_source,
  "event_source_url": meta.event_source_url,
  "user_data":        { "em": ["<sha256>"], "ph": ["<sha256>"], "fbp": "...", "client_ip_address": "..." },
  "custom_data":      meta.custom_data
}]}
```

Skip the call when `meta.should_send` is `false`.

## ⚠️ Never forward `private`

The `private` block holds raw qualification answers — health condition, disability status, finances. **Meta and Google both prohibit receiving special-category data**, and enforcement is real.

`private` is for your CRM only. Meta gets `custom_data.lead_quality_tier` (`A`–`D`) instead, which carries the same optimization signal with none of the exposure.

## Full payload

```jsonc
{
  "action": "meta_capi_and_crm",          // ← switch on this
  "schema_version": 2,
  "sent_at": "2026-09-02T07:38:10.147Z",

  "event": {
    "name": "lead_submitted",
    "id": "a1e323fb-063d-45ae-8538-2e68ce285aa1",   // dedupe key
    "time": 1788334690,                             // unix seconds
    "time_iso": "2026-09-02T07:38:10.147Z",
    "value": 72,
    "currency": "USD",
    "params": {
      "funnel_id": "benefits_qualification",
      "lead_quality_tier": "A",
      "lead_score": 100,
      "qualified": true,
      "seconds_to_convert": 16,
      "session_id": "8da4bdce-..."
    }
  },

  "identity": {
    "user_id": "43cb29fb-...",            // stable across sessions
    "session_id": "8da4bdce-...",
    "fbp": "fb.1.1788300000000.9988776655",
    "fbc": "fb.1.1788334672990.FBX1",
    "user_agent": "Mozilla/5.0 ...",
    "client_ip": null                     // YOU fill this from the socket
  },

  "user": {                               // raw PII — hash before sending onward
    "firstName": "Jordan",
    "lastName": "Rivera",
    "email": "jordan.rivera@example.com",
    "phone": "15551234567",
    "zip": "90210"
  },

  "attribution": {
    "click_ids": { "fbclid": "FBX1", "gclid": "GX1", "utm_source": "meta", "utm_campaign": "q4" },
    "page_url": "https://...",
    "referrer": ""
  },

  "device": { "language": "en-US", "timezone": "Asia/Calcutta", "screen": "1920x1080" },

  "meta": {
    "should_send": true,
    "event_name": "Lead",                 // Meta standard event
    "event_id": "a1e323fb-...",           // same as event.id
    "event_time": 1788334690,
    "action_source": "website",
    "event_source_url": "https://...",
    "user_data": {
      "hash_these": {                     // SHA-256 each, exactly as given
        "em": "jordan.rivera@example.com",
        "ph": "15551234567",
        "fn": "jordan",
        "ln": "rivera",
        "zp": "90210",
        "external_id": "43cb29fb-..."
      },
      "send_plain": {                     // never hash these
        "fbp": "fb.1....",
        "fbc": "fb.1....",
        "client_user_agent": "Mozilla/5.0 ...",
        "client_ip_address": null         // YOU fill this
      }
    },
    "custom_data": {
      "lead_quality_tier": "A", "lead_score": 100, "qualified": true,
      "value": 72, "currency": "USD"
    }
  },

  "private": {                            // ⚠️ CRM ONLY — never to an ad platform
    "answers": { "age_band": "50_64", "condition_duration": "gt_12m", "...": "..." },
    "score": { "percent": 100, "grade": "A", "qualified": true },
    "funnel_version": "v1"
  }
}
```

## Event → Meta standard event

| Our event | Meta | Fires when |
|---|---|---|
| `funnel_start` | `ViewContent` | Page load |
| `funnel_step` | — | Each answer (no Meta event) |
| `contact_captured` | `InitiateCheckout` | Form submitted, before the request |
| `lead_submitted` | `Lead` | Lead accepted |
| `call_clicked` | `Contact` | Phone tapped on the result screen |

## Verify

1. Events Manager → Test Events, with `test_event_code` on the CAPI call
2. The browser and server event must show **Deduplicated** — not two rows
3. Event Match Quality should be **8+/10** with `fbp` + IP + UA + hashed email/phone

If you see two rows instead of one, your `event_id` is not matching the Pixel's.
