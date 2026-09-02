/**
 * Local stand-in for n8n → Airtable, mapped to the real "Benefit Check — Lead
 * Flow" schema.
 *
 * The base is ONE ROW PER LEAD, upserted on `lead_key` as the user progresses —
 * not one row per event. That keeps writes well inside Airtable's 5 req/sec
 * limit and gives you a single record showing how far each lead got.
 *
 * Run:  node tools/mock-webhook.mjs
 * Then: VITE_WEBHOOK_URL=http://localhost:8787/hook npm run dev
 *
 * Env: AIRTABLE_TOKEN, AIRTABLE_BASE  (writes rows)
 *      META_PIXEL_ID, META_CAPI_ACCESS_TOKEN, META_TEST_EVENT_CODE  (sends CAPI)
 */

import { createServer } from 'node:http';

const PORT = 8787;
const {
  META_PIXEL_ID,
  META_CAPI_ACCESS_TOKEN,
  META_TEST_EVENT_CODE,
  AIRTABLE_TOKEN,
  AIRTABLE_BASE,
  AIRTABLE_TABLE = 'Leads',
  TEST_MODE, // marks rows status=test so they are easy to find and delete
} = process.env;

const sha256 = async (v) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

// --- mapping helpers ---------------------------------------------------------

/** Base allows a|b|c|ungraded — our D (disqualified) has no grade. */
const GRADE = { A: 'a', B: 'b', C: 'c', D: 'ungraded' };

/** Channel from the strongest available signal. */
function deriveChannel(clickIds = {}, referrer = '') {
  if (clickIds.fbclid) return ['paid_social_meta', 'click_id', 'fbclid'];
  if (clickIds.gclid || clickIds.gbraid || clickIds.wbraid)
    return ['paid_search_google', 'click_id', 'gclid'];
  if (clickIds.ttclid) return ['paid_social_tiktok', 'click_id', 'ttclid'];
  if (clickIds.msclkid) return ['paid_search_microsoft', 'click_id', 'msclkid'];

  const src = (clickIds.utm_source || '').toLowerCase();
  if (src) {
    if (/facebook|meta|ig|instagram/.test(src)) return ['paid_social_meta', 'utm', 'utm_source'];
    if (/google|adwords/.test(src)) return ['paid_search_google', 'utm', 'utm_source'];
    if (/tiktok/.test(src)) return ['paid_social_tiktok', 'utm', 'utm_source'];
    if (/bing|microsoft/.test(src)) return ['paid_search_microsoft', 'utm', 'utm_source'];
    if (/email|klaviyo/.test(src)) return ['email', 'utm', 'utm_source'];
    return ['paid_other', 'utm', 'utm_source'];
  }

  if (referrer) {
    const host = safeHost(referrer);
    if (/google|bing|duckduckgo|yahoo/.test(host)) return ['organic_search', 'referrer', 'referrer'];
    if (/facebook|instagram|tiktok|twitter|x\.com|reddit/.test(host))
      return ['organic_social', 'referrer', 'referrer'];
    return ['referral', 'referrer', 'referrer'];
  }
  return ['direct', 'none', 'none'];
}

const safeHost = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
};

function deviceType(ua = '') {
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone/i.test(ua)) return 'mobile';
  return 'desktop';
}

const num = (s, i) => Number(String(s ?? '').split('x')[i]) || null;

/**
 * Payload → Airtable fields.
 * Only non-null values are sent, so a later `funnel_step` never blanks a field
 * an earlier `lead_submitted` populated.
 */
async function toFields(p, clientIp) {
  const priv = p.private ?? {};
  const params = p.event.params ?? {};
  const firstTouch = p.attribution?.click_ids ?? {};
  const current = p.attribution?.click_ids_current ?? {};
  // Attribute to THIS visit's click, falling back to first touch. Meta's _fbc
  // is rebuilt from the current fbclid, so channel must agree with it.
  const click = Object.keys(current).length ? { ...firstTouch, ...current } : firstTouch;
  const [channel, confidence, decidedBy] = deriveChannel(
    Object.keys(current).length ? current : firstTouch,
    p.attribution?.referrer,
  );

  const isComplete = p.event.name === 'lead_submitted';
  const qualified = params.qualified;

  const f = {
    // Natural key — one row per funnel run, upserted on this.
    lead_key: p.identity.session_id,
    // Per-event key so a replayed webhook does not double-process.
    idempotency_key: p.event.id,

    phase: isComplete ? 'complete' : 'partial',
    status: TEST_MODE
      ? 'test'
      : isComplete
        ? qualified === false
          ? 'disqualified'
          : 'qualified'
        : 'new',

    // Attribution
    channel,
    channel_confidence: confidence,
    channel_decided_by: decidedBy,
    click_id_type: confidence === 'click_id' ? decidedBy : null,
    lead_source: 'Website leads',
    lead_sub_category: confidence === 'none' ? 'Direct' : confidence === 'click_id' ? 'Ads' : 'Organic',
    fbclid: click.fbclid ?? null,
    gclid: click.gclid ?? null,
    utm_source: click.utm_source ?? null,
    utm_medium: click.utm_medium ?? null,
    utm_campaign: click.utm_campaign ?? null,
    utm_term: click.utm_term ?? null,
    utm_content: click.utm_content ?? null,
    referrer: p.attribution?.referrer || null,
    referrer_host: safeHost(p.attribution?.referrer) || null,
    landing_path: (() => {
      try {
        return new URL(p.attribution.page_url).pathname;
      } catch {
        return null;
      }
    })(),

    // Match signals
    fbp: p.identity.fbp,
    fbc: p.identity.fbc,
    client_ip: clientIp,
    client_user_agent: p.identity.user_agent,

    // Device
    device_type: deviceType(p.identity.user_agent),
    viewport_w: num(p.device?.viewport, 0),
    viewport_h: num(p.device?.viewport, 1),
    timezone: p.device?.timezone ?? null,

    // Progression — monotonic, so the row shows how far they got
    // funnel_start has no step_index; record step 1 so bounces are visible
    furthest_step: params.step_index ?? (p.event.name === 'funnel_start' ? 1 : null),
    furthest_step_id: params.step_id ?? (p.event.name === 'funnel_start' ? 'landing' : null),
    step_reached_at: p.event.time_iso,
    last_click: p.event.name === 'call_clicked' ? 'call_button' : null,
    highest_event_type: p.event.name,
    highest_event_rank:
      { funnel_start: 1, funnel_step: 2, funnel_abandoned: 2, contact_captured: 3, lead_submitted: 4 }[p.event.name] ??
      null,

    // Drop-off — where and when they left, and how long they sat on that step
    dropped_at_step: p.event.name === 'funnel_abandoned' ? (params.step_index ?? null) : null,
    dropped_at: p.event.name === 'funnel_abandoned' ? p.event.time_iso : null,
    time_to_interactive_ms:
      p.event.name === 'funnel_abandoned' ? (params.time_on_step_ms ?? null) : null,

    // Grading
    grade: params.lead_quality_tier ? GRADE[params.lead_quality_tier] : null,
    grade_score: params.lead_score ?? null,
    grade_version: priv.funnel_version ?? null,
    value_usd: p.event.value ?? null,
  };

  // PII and answers only exist once the form is submitted.
  if (p.user) {
    Object.assign(f, {
      email: p.user.email ?? null,
      first_name: p.user.firstName ?? null,
      last_name: p.user.lastName ?? null,
      phone_e164: p.user.phone ? `+${p.user.phone}` : null,
      zip: p.user.zip ?? null,
    });
  }
  if (priv.answers) f.answers_json = JSON.stringify(priv.answers, null, 2);

  // TCPA evidence
  if (priv.consent?.text) {
    Object.assign(f, {
      consent_text: priv.consent.text,
      consent_text_sha256: await sha256(priv.consent.text),
      consent_timestamp: priv.consent.timestamp,
      consent_ip: clientIp,
      consent_user_agent: p.identity.user_agent,
    });
  }

  // Drop nulls so a later partial event cannot erase earlier data.
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== null && v !== undefined));
}

// --- Airtable ----------------------------------------------------------------

/*
 * HIGH-WATER MARK GUARD.
 *
 * Events can arrive out of order — a retried `funnel_start` may land after
 * `lead_submitted`. These fields must only ever ADVANCE; plain last-write-wins
 * silently downgrades a completed £72 lead back to a £0.50 partial.
 *
 * In n8n: add an Airtable "Search" node on lead_key before the upsert and apply
 * the same comparison, or you will hit this on every retry.
 */
const RANK_GUARDED = [
  'phase',
  'status',
  'value_usd',
  'grade',
  'grade_score',
  'grade_version',
  'highest_event_type',
  'highest_event_rank',
  'step_reached_at',
  'email',
  'first_name',
  'last_name',
  'phone_e164',
  'zip',
  'answers_json',
];

/** lead_key → { rank, furthestStep } seen so far. Seeded from Airtable once. */
const highWater = new Map();

async function loadHighWater(leadKey) {
  if (highWater.has(leadKey)) return highWater.get(leadKey);
  let hw = { rank: 0, furthestStep: 0 };
  if (AIRTABLE_TOKEN && AIRTABLE_BASE) {
    try {
      const url =
        `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}` +
        `?maxRecords=1&filterByFormula=${encodeURIComponent(`{lead_key}='${leadKey}'`)}`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${AIRTABLE_TOKEN}` } });
      const f = (await res.json())?.records?.[0]?.fields ?? {};
      hw = { rank: f.highest_event_rank ?? 0, furthestStep: f.furthest_step ?? 0 };
    } catch {
      /* cold start — treat as new */
    }
  }
  highWater.set(leadKey, hw);
  return hw;
}

/** Strip fields that would move the record backwards. */
async function applyHighWater(fields) {
  const leadKey = fields.lead_key;
  const hw = await loadHighWater(leadKey);
  const rank = fields.highest_event_rank ?? 0;

  if (rank < hw.rank) {
    for (const k of RANK_GUARDED) delete fields[k];
    console.log(`    (rank ${rank} < ${hw.rank} — regressive fields dropped)`);
  } else {
    hw.rank = rank;
  }

  // furthest_step advances independently of event rank.
  const step = fields.furthest_step ?? 0;
  if (step < hw.furthestStep) {
    delete fields.furthest_step;
    delete fields.furthest_step_id;
  } else {
    hw.furthestStep = step;
  }

  highWater.set(leadKey, hw);
  return fields;
}

/** Upsert on lead_key — creates the row, then updates it as the lead advances. */
async function upsert(fields) {
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE) return { skipped: true, fields };
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}`,
    {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${AIRTABLE_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        performUpsert: { fieldsToMergeOn: ['lead_key'] },
        records: [{ fields }],
        typecast: true,
      }),
    },
  );
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function deadLetter(stage, leadKey, payload, error, httpStatus) {
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE) return;
  await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/Dead%20Letter`, {
    method: 'POST',
    headers: { authorization: `Bearer ${AIRTABLE_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      records: [
        {
          fields: {
            dlq_key: `${leadKey}:${stage}:${Date.now()}`,
            lead_key: leadKey,
            stage,
            raw_payload: JSON.stringify(payload).slice(0, 90000),
            error: String(error).slice(0, 90000),
            http_status: httpStatus ?? null,
            retryable: (httpStatus ?? 500) >= 500,
            attempts: 1,
            first_failed_at: new Date().toISOString(),
            last_failed_at: new Date().toISOString(),
          },
        },
      ],
      typecast: true,
    }),
  }).catch(() => {});
}

// --- Meta CAPI ---------------------------------------------------------------

async function hashAll(hashThese) {
  const out = {};
  for (const [k, v] of Object.entries(hashThese)) {
    if (v != null && v !== '') out[k] = [await sha256(String(v))];
  }
  return out;
}

async function sendCapi(p, clientIp) {
  const m = p.meta;
  const body = {
    data: [
      {
        event_name: m.event_name,
        event_time: m.event_time,
        event_id: m.event_id, // MUST equal the browser Pixel's eventID
        action_source: m.action_source,
        event_source_url: m.event_source_url,
        user_data: {
          ...(await hashAll(m.user_data.hash_these)),
          ...Object.fromEntries(
            Object.entries(m.user_data.send_plain).filter(([, v]) => v != null),
          ),
          client_ip_address: clientIp,
        },
        custom_data: m.custom_data,
      },
    ],
    ...(META_TEST_EVENT_CODE && { test_event_code: META_TEST_EVENT_CODE }),
  };

  const identifierCount = Object.keys(body.data[0].user_data).length;

  if (!META_PIXEL_ID || !META_CAPI_ACCESS_TOKEN) {
    return { skipped: true, identifierCount, body };
  }

  const res = await fetch(
    `https://graph.facebook.com/v21.0/${META_PIXEL_ID}/events?access_token=${META_CAPI_ACCESS_TOKEN}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );
  const json = await res.json().catch(() => null);
  return { status: res.status, json, identifierCount };
}

// --- server ------------------------------------------------------------------

/** Event ids already processed — makes retries idempotent. n8n should use the
 *  Airtable upsert on `idempotency_key` for the same guarantee across restarts. */
const processed = new Set();

createServer((req, res) => {
  // CORS: the browser must be able to READ the status, or every send looks
  // failed and the outbox retries forever. In n8n this is the Webhook node's
  // "Allowed Origins (CORS)" field.
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
  };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  if (req.method !== 'POST') return res.writeHead(405, cors).end();

  const isDeadLetter = (req.url || '').includes('dead_letter=1');

  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    let p;
    try {
      p = JSON.parse(raw); // body arrives as text/plain — see WEBHOOK.md
    } catch {
      res.writeHead(400, cors).end('bad json');
      return;
    }

    if (isDeadLetter) {
      console.error(`
!!! DEAD LETTER  ${p.event?.name}  id=${p.event?.id}`);
      await deadLetter('n8n_webhook', p.identity?.session_id, p, 'browser outbox gave up', 0);
      res.writeHead(200, cors).end('{"ok":true}');
      return;
    }

    // Idempotency: a retry of a request that already landed must be absorbed,
    // never double-counted. This is what makes the outbox safe to retry.
    if (processed.has(p.event.id)) {
      console.log(`    (duplicate ${p.event.id.slice(0, 8)} absorbed — no re-processing)`);
      res.writeHead(200, cors).end('{"ok":true,"duplicate":true}');
      return;
    }
    processed.add(p.event.id);

    // Never trust a client-supplied IP.
    const clientIp =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.socket.remoteAddress?.replace('::ffff:', '') ||
      null;

    const leadKey = p.identity?.session_id;
    console.log(`\n─── ${p.action}  ←  ${p.event.name}   lead_key=${leadKey?.slice(0, 8)}`);

    const fields = await applyHighWater(await toFields(p, clientIp));

    // THE SWITCH
    if (p.action === 'meta_capi' || p.action === 'meta_capi_and_crm') {
      if (p.meta?.should_send) {
        const capi = await sendCapi(p, clientIp);

        // The base has ONE set of capi_* fields, so they track the Lead
        // conversion only. `contact_captured` (InitiateCheckout) is still sent
        // to CAPI, but must not overwrite the Lead's dedupe key — these two
        // events fire in the same tick and would otherwise race.
        const isLead = p.meta.event_name === 'Lead';
        if (isLead) {
          fields.capi_event_id = p.meta.event_id;
          fields.capi_attempted_at = new Date().toISOString();
          fields.capi_attempts = 1;
          fields.identifier_count = capi.identifierCount;
        }

        if (capi.skipped) {
          console.log(`    CAPI dry-run · event_id=${p.meta.event_id} · ${capi.identifierCount} identifiers`);
        } else if (capi.status === 200) {
          if (isLead) {
            fields.capi_sent_at = new Date().toISOString();
            fields.capi_fbtrace_id = capi.json?.fbtrace_id ?? null;
            fields.capi_events_received = capi.json?.events_received ?? null;
          }
          console.log(`    CAPI ok · received=${capi.json?.events_received} · trace=${capi.json?.fbtrace_id}`);
        } else {
          fields.capi_messages = JSON.stringify(capi.json);
          console.error(`    CAPI FAILED ${capi.status}`, capi.json);
          await deadLetter('capi', leadKey, p, JSON.stringify(capi.json), capi.status);
        }
      }
    } else if (p.action === 'alert') {
      console.warn('    ALERT: submission failed');
    }

    const air = await upsert(fields);
    if (air.skipped) {
      console.log('    airtable dry-run:', Object.keys(air.fields).length, 'fields');
    } else if (air.status === 200) {
      const r = air.body?.records?.[0];
      const created = air.body?.createdRecords?.length ? 'created' : 'updated';
      console.log(`    airtable ${created} ${r?.id}`);
    } else {
      console.error(`    airtable FAILED ${air.status}`, JSON.stringify(air.body));
      await deadLetter('airtable_upsert', leadKey, p, JSON.stringify(air.body), air.status);
    }

    res.writeHead(200, { 'content-type': 'application/json', ...cors }).end('{"ok":true}');
  });
}).listen(PORT, () => console.log(`mock n8n → Airtable on :${PORT}/hook`));
