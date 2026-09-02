/**
 * Every place events are sent. THIS IS THE EXTENSION POINT.
 *
 * To add TikTok / Google Ads / Reddit: write one object with
 * { name, acceptsPii, firstParty, init?, send } and append it to the array at
 * the bottom. Nothing else changes, and it automatically receives the same
 * event with the same dedupe key as every other destination.
 */

import { config, post, type Destination, type Event, type User } from './tracking';

declare global {
  interface Window {
    fbq?: ((...args: unknown[]) => void) & { queue?: unknown[] };
  }
}

// --- Routing -----------------------------------------------------------------
// `action` is the single key your webhook switches on. Edit this map to change
// what the webhook does for an event — no other code changes.

export type WebhookAction = 'track_only' | 'meta_capi' | 'meta_capi_and_crm';

const ACTIONS: Record<Event['name'], WebhookAction> = {
  funnel_start: 'track_only',
  funnel_step: 'track_only',
  funnel_abandoned: 'track_only',
  contact_captured: 'meta_capi',
  lead_submitted: 'meta_capi_and_crm',
  call_clicked: 'meta_capi',
};

/** Our event names → Meta standard events, which optimize better than custom. */
const META_EVENTS: Partial<Record<Event['name'], string>> = {
  funnel_start: 'ViewContent',
  contact_captured: 'InitiateCheckout',
  lead_submitted: 'Lead',
  call_clicked: 'Contact',
};

// --- Meta Pixel: browser half of the browser+CAPI pair ------------------------
// The server half is your webhook, which must send the SAME event_id.

/** Meta's normalization rule before hashing: trim + lowercase. */
const norm = (v: string | undefined) => v?.trim().toLowerCase() || null;

/** Advanced matching. Raw values — the Pixel hashes them before sending. */
function metaUser(user: User | undefined, externalId: string) {
  const out: Record<string, string> = { external_id: externalId };
  if (user?.email) out.em = user.email.trim().toLowerCase();
  if (user?.phone) out.ph = user.phone.replace(/\D/g, '');
  if (user?.firstName) out.fn = user.firstName.trim().toLowerCase();
  if (user?.lastName) out.ln = user.lastName.trim().toLowerCase();
  if (user?.zip) out.zp = user.zip.trim();
  return out;
}

const meta: Destination = {
  name: 'meta',
  acceptsPii: true,
  firstParty: false,

  init(id) {
    if (!config.metaPixelId) return;

    /*
     * Advanced matching can ONLY be set on the pixel's FIRST init — verified
     * against a live pixel: a later fbq('init', …) or fbq('set','userData',…)
     * is silently ignored and `ud[em]`/`ud[ph]` never leave the browser.
     *
     * So we seed init with anything we already know about this person from a
     * previous visit. For a first-time visitor there is nothing yet, and the
     * browser event carries only external_id/fbp/fbc — their email and phone
     * reach Meta via CAPI, and via Automatic Advanced Matching if it is enabled
     * in Events Manager (Settings → Automatic Advanced Matching). Turn it on.
     */
    let known: User | undefined;
    try {
      known = JSON.parse(localStorage.getItem('__match') ?? 'null') ?? undefined;
    } catch {
      /* ignore */
    }

    const q: Window['fbq'] = Object.assign(
      (...args: unknown[]) => {
        const f = q as unknown as { callMethod?: (...a: unknown[]) => void };
        f.callMethod ? f.callMethod(...args) : q!.queue!.push(args);
      },
      { queue: [] as unknown[] },
    );
    window.fbq = q;

    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://connect.facebook.net/en_US/fbevents.js';
    document.head.appendChild(s);

    window.fbq('init', config.metaPixelId, metaUser(known, id.userId));
  },

  send(event) {
    if (!window.fbq) return;

    // Persist for the NEXT visit. Re-initing now would be silently ignored,
    // but a fresh page load can seed advanced matching from this.
    if (event.user) {
      try {
        localStorage.setItem('__match', JSON.stringify(event.user));
      } catch {
        /* ignore */
      }
    }

    const payload = {
      ...event.params,
      ...(event.value !== undefined && { value: event.value, currency: 'USD' }),
    };

    // eventID is what makes the webhook's CAPI call dedupe against this one.
    const standard = META_EVENTS[event.name];
    window.fbq(standard ? 'track' : 'trackCustom', standard ?? event.name, payload, {
      eventID: event.id,
    });
  },
};

// --- Your webhook: receives EVERYTHING ---------------------------------------

const webhook: Destination = {
  name: 'webhook',
  acceptsPii: true,
  firstParty: true,

  send(event, id) {
    const metaEventName = META_EVENTS[event.name];
    const phone = event.user?.phone?.replace(/\D/g, '');
    const phoneE164 = phone ? (phone.length === 10 ? `1${phone}` : phone) : null;

    const payload = {
      // === THE SWITCH KEY ====================================================
      action: ACTIONS[event.name],

      schema_version: 2,
      sent_at: new Date().toISOString(),

      // === What happened =====================================================
      event: {
        name: event.name,
        // Same id the Pixel just fired with. Reuse VERBATIM on the CAPI call.
        id: event.id,
        time: Math.floor(event.time / 1000),
        time_iso: new Date(event.time).toISOString(),
        value: event.value ?? null,
        currency: event.value !== undefined ? 'USD' : null,
        params: event.params,
      },

      // === Who ===============================================================
      identity: {
        user_id: id.userId,
        session_id: id.sessionId,
        fbp: id.fbp,
        fbc: id.fbc,
        user_agent: id.userAgent,
        // Fill from the request socket. A client-supplied IP is spoofable.
        client_ip: null,
      },

      user: event.user ?? null, // raw PII — the SERVER hashes, see meta.user_data

      // === Where they came from ==============================================
      attribution: {
        // First touch — the original source that acquired this user.
        click_ids: id.clickIds,
        // This visit. `_fbc` is rebuilt from THIS fbclid, so channel attribution
        // must follow it too, or a returning visitor gets credited to the wrong
        // campaign while their conversion reports against the new one.
        click_ids_current: id.clickIdsCurrent,
        page_url: id.pageUrl,
        referrer: id.referrer,
      },

      device: {
        language: id.language,
        timezone: id.timezone,
        screen: id.screen,
        viewport: id.viewport,
      },

      // === Ready-to-forward Meta CAPI payload ================================
      // Hash `hash_these`, merge with `send_plain`, add client_ip, POST to
      // graph.facebook.com/v21.0/<PIXEL_ID>/events
      meta: metaEventName
        ? {
            should_send: ACTIONS[event.name].startsWith('meta_capi'),
            event_name: metaEventName,
            event_id: event.id,
            event_time: Math.floor(event.time / 1000),
            action_source: 'website',
            event_source_url: id.pageUrl,
            // Already trimmed + lowercased to Meta's spec, so the webhook can
            // SHA-256 each value EXACTLY as given. Normalising after hashing is
            // impossible, and hashing un-normalised input silently kills matching.
            user_data: {
              hash_these: {
                em: norm(event.user?.email),
                ph: phoneE164,
                fn: norm(event.user?.firstName),
                ln: norm(event.user?.lastName),
                zp: norm(event.user?.zip),
                /*
                 * TWO external_ids, not one.
                 *
                 * A per-browser id alone tells Meta that the same person on a
                 * phone and a laptop is two people — it actively suppresses
                 * match quality instead of being merely neutral. Sending the
                 * anon id AND the phone lets Meta stitch the anonymous browsing
                 * session to the identified person, and both devices to each
                 * other. Meta accepts external_id as an array; the server
                 * hashes each entry.
                 *
                 * The browser Pixel keeps the anon id only, because advanced
                 * matching can be set just once, on the pixel's first init.
                 */
                external_id: [id.userId, phoneE164].filter(Boolean),
              },
              send_plain: {
                fbp: id.fbp,
                fbc: id.fbc,
                client_user_agent: id.userAgent,
                client_ip_address: null, // fill server-side
              },
            },
            // Non-sensitive only. `private` is deliberately excluded — sending
            // health or disability signals to Meta violates their policy.
            custom_data: {
              ...event.params,
              ...(event.value !== undefined && { value: event.value, currency: 'USD' }),
            },
          }
        : { should_send: false },

      // === First-party only. NEVER forward this to an ad platform. ===========
      private: event.private ?? null,
    };

    if (!config.webhookUrl) {
      if (config.debug) console.info('[webhook] would POST →', payload);
      return;
    }
    // Keyed by event id so a retry of a request that landed is absorbed.
    post(config.webhookUrl, payload, event.id);
  },
};

export const destinations: Destination[] = [webhook, meta];
