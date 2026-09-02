/**
 * Lead intake + Meta Conversions API relay.
 *
 * The browser Pixel loses 15-30% of conversions to ad blockers and ITP. This
 * endpoint already receives everything CAPI needs, so it recovers that with no
 * extra data collection. Access tokens live ONLY here, never in a VITE_ var.
 *
 * Uses Web Fetch types, so it runs on Vercel, Cloudflare, Deno, Bun, or
 * Next.js App Router (`export const POST = handleLead`).
 */

interface LeadBody {
  /** Same id the browser Pixel sent, so Meta merges the pair. */
  event_id: string;
  contact: { firstName: string; lastName: string; email: string; phone: string; zip?: string };
  /** Special-category answers. Stay server-side — never sent to an ad platform. */
  answers: Record<string, string>;
  score: { grade: 'A' | 'B' | 'C' | 'D'; percent: number; qualified: boolean };
  identity: { fbp: string | null; fbc: string | null; userId: string; userAgent: string; pageUrl: string };
}

const VALUE: Record<LeadBody['score']['grade'], number> = { A: 72, B: 52, C: 36, D: 16 };

/** Meta requires trimmed + lowercased input before hashing. */
async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value.trim().toLowerCase());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Trust the proxy header, never a client field — a spoofed IP poisons matching. */
function clientIp(req: Request): string | null {
  const h = req.headers;
  return (
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    h.get('cf-connecting-ip') ??
    h.get('x-real-ip')
  );
}

async function sendToMeta(body: LeadBody, req: Request): Promise<boolean> {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_ACCESS_TOKEN;
  if (!pixelId || !token) return false;

  const { contact, identity, score } = body;
  const phone = contact.phone.replace(/\D/g, '');

  const [em, ph, fn, ln, externalId] = await Promise.all([
    sha256(contact.email),
    sha256(phone.length === 10 ? `1${phone}` : phone), // E.164
    sha256(contact.firstName),
    sha256(contact.lastName),
    sha256(identity.userId),
  ]);

  const payload = {
    data: [
      {
        event_name: 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        event_id: body.event_id,
        event_source_url: identity.pageUrl,
        action_source: 'website',
        user_data: {
          em: [em],
          ph: [ph],
          fn: [fn],
          ln: [ln],
          external_id: [externalId],
          // Unhashed by design — Meta expects these in the clear.
          ...(identity.fbp && { fbp: identity.fbp }),
          ...(identity.fbc && { fbc: identity.fbc }),
          ...(clientIp(req) && { client_ip_address: clientIp(req) }),
          client_user_agent: identity.userAgent,
        },
        custom_data: {
          value: VALUE[score.grade],
          currency: 'USD',
          // Derived tier only. `answers` is deliberately excluded — sending
          // health or disability signals violates Meta policy.
          lead_quality_tier: score.grade,
          lead_score: score.percent,
        },
      },
    ],
    ...(process.env.META_TEST_EVENT_CODE && { test_event_code: process.env.META_TEST_EVENT_CODE }),
  };

  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${token}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** Your CRM. The one destination allowed to receive the raw answers. */
async function forward(body: LeadBody, req: Request): Promise<boolean> {
  const url = process.env.LEAD_WEBHOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, client_ip: clientIp(req), received_at: new Date().toISOString() }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function handleLead(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body: LeadBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  if (!body.event_id || !body.contact?.email || !body.contact?.phone) {
    return Response.json({ ok: false, error: 'missing_fields' }, { status: 400 });
  }

  // Never let a CAPI failure fail the response — a lead that reaches your CRM
  // but not Meta is recoverable; the reverse is not.
  const [capi, forwarded] = await Promise.all([sendToMeta(body, req), forward(body, req)]);

  return Response.json({ ok: true, event_id: body.event_id, capi, forwarded });
}

export default handleLead;
export const config = { runtime: 'edge' };
