# n8n workflow

`workflow.json` — import into n8n via **Workflows → ⋯ → Import from File**.

```
Webhook
  → Map to Airtable schema        (Code)
  → Airtable — find existing lead (GET, high-water lookup)
  → High-water guard              (Code)
  → Airtable — upsert lead        (PATCH, performUpsert on lead_key)
  → Send to Meta?                 (IF meta.should_send)
      → Hash PII → CAPI body      (Code, SHA-256)
      → Meta Conversions API      (POST)
      → Airtable — record CAPI result
  → Respond 200

  ⚡ error outputs from "upsert lead" and "Meta Conversions API"
     → Airtable — Dead Letter
```

Airtable is called over **HTTP Request** rather than the Airtable node — it uses the exact `performUpsert` API call already verified against this base, and avoids n8n node-version differences.

## Setup

**1. Credential** — Settings → Credentials → New → **Header Auth**

| | |
|---|---|
| Name | `Airtable PAT` |
| Header Name | `Authorization` |
| Header Value | `Bearer patXXXXXXXX...` |

The workflow references it by that exact name. Scopes needed: `data.records:read`, `data.records:write`.

**2. Credential** — Settings → Credentials → New → **Query Auth**

| | |
|---|---|
| Name | `Meta CAPI Token` |
| Name (param) | `access_token` |
| Value | permanent **System User** token (`expires_at: 0`) with pixel access |

> The workflow uses **no n8n Variables** — those are a paid-plan feature and resolve to an empty string on Community, which silently produced `https://api.airtable.com/v0//Leads`. The base id and pixel id are inlined; both secrets live in credentials.

To verify dedupe before going live, set `TEST_EVENT_CODE` at the top of the
**Hash PII → CAPI body** node to your Test Events code, then clear it.

**3. Point the funnel at it**

```
VITE_WEBHOOK_URL=https://<your-n8n>/webhook/funnel-events
```

Use `/webhook-test/` while the canvas is open for a manual run; `/webhook/` once activated.

## What the nodes guarantee

The resilience contract is implemented end to end:

- **CORS** — the Webhook node sets `allowedOrigins: *`, and `Respond 200` returns the header. Without this the browser outbox can't read the status and retries forever.
- **Idempotency** — the upsert merges on `lead_key`, and each event carries `idempotency_key`. A retried event updates, never duplicates.
- **High-water guard** — replayed events arrive out of order. A late `funnel_start` would otherwise downgrade a completed $72 lead to a $0.50 partial. The guard strips regressive fields.
- **Dead Letter** — Airtable and CAPI failures route to the `Dead Letter` table with stage, payload and error, instead of vanishing.

## Pixel settings that must stay on

**Automatic Advanced Matching** (Events Manager → dataset → Settings). Verified
live: without it a first-time visitor's browser `Lead` carries only
`external_id`/`fbp`/`fbc`, because manual advanced matching can ONLY be set on
the pixel's first `fbq('init')` — a later `init` or `fbq('set','userData')` is
silently ignored. With AAM on, the same event carries `udff[em]`/`udff[ph]`
(`es=automatic`).

## Verified

The three Code nodes were executed against a real captured `lead_submitted` payload — **27 assertions pass**:

```
N1  lead_key / idempotency_key / grade a / value_usd 72 / phase complete
N1  client_ip taken from x-forwarded-for, NOT the client body
N1  phone +13125550144 · consent sha256 · 41 non-null fields
N2  fresh lead keeps all fields
N2  regressive event → phase + value_usd stripped, lead_key kept
N3  event_id matches the Pixel eventID exactly
N3  em/ph hashed · fbp/fbc sent UNhashed · client_ip from header
N3  NO raw answers and NO cleartext email reach Meta
```

Re-run after editing the Code nodes:

```bash
node tools/verify-n8n.mjs
```

## Gotchas

- **`event_id` must pass through untouched.** It is the only thing making Meta merge the browser and server events. Regenerating it double-counts every conversion.
- **Hash `hash_these` exactly as given.** Values arrive pre-normalised (trimmed, lowercased, phone E.164). Re-normalising or hashing raw input silently kills match quality.
- **Never hash `send_plain`.** `fbp`, `fbc`, IP and user-agent go in the clear.
- **Never forward `private` to Meta.** It holds health/disability answers — a policy violation. It belongs in Airtable only.
- Set `TEST_MODE = true` at the top of the first Code node to land rows as `status: test`.

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
