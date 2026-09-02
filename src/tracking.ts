import { destinations } from './destinations';

export type EventName =
  | 'funnel_start'
  | 'funnel_step'
  | 'funnel_abandoned'
  | 'contact_captured'
  | 'lead_submitted'
  | 'call_clicked';

export interface User {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  zip?: string;
}

export interface Event {
  name: EventName;
  /**
   * Dedupe key. Meta merges a browser event and a server event only when both
   * carry the same event_name AND the same id. Must be unique PER EVENT — a
   * user or session id makes every event dedupe into one, silently.
   *
   * Generated here, sent to the Pixel as `eventID`, and to the webhook as
   * `event_id`. The webhook MUST reuse it verbatim on the CAPI call.
   */
  id: string;
  time: number;
  params: Record<string, unknown>;
  value?: number;
  user?: User;
  /**
   * First-party only. Never reaches an ad platform.
   * Raw qualification answers live here — they are special-category data.
   */
  private?: Record<string, unknown>;
}

export interface Identity {
  userId: string;
  sessionId: string;
  fbp: string | null;
  fbc: string | null;
  userAgent: string;
  pageUrl: string;
  referrer: string;
  /** First touch — the original source, never overwritten. */
  clickIds: Record<string, string>;
  /** This visit's params. Meta's _fbc follows THIS, so channel must too. */
  clickIdsCurrent: Record<string, string>;
  language: string;
  timezone: string;
  screen: string;
  viewport: string;
}

export interface Destination {
  name: string;
  /** May receive event.user (Meta needs it for advanced matching). */
  acceptsPii: boolean;
  /** May receive event.private. Your own endpoints only. */
  firstParty: boolean;
  init?: (id: Identity) => void;
  send: (event: Event, id: Identity) => void;
}

export const config = {
  webhookUrl: (import.meta.env.VITE_WEBHOOK_URL ?? '').trim(),
  metaPixelId: (import.meta.env.VITE_META_PIXEL_ID ?? '').trim(),
  /** Independent failure sink. Must NOT be the same host as webhookUrl. */
  deadLetterUrl: (import.meta.env.VITE_DEAD_LETTER_URL ?? '').trim(),
  debug: new URLSearchParams(location.search).get('debug') === '1',
};

export function uuid(): string {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function cookie(name: string): string | null {
  return document.cookie.match(`(^|;\\s*)${name}=([^;]*)`)?.[2] ?? null;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // private mode
  }
}

/* ---------------------------------------------------------------------------
 * Outbox — durable delivery.
 *
 * An event that fails to send is revenue you cannot attribute, so delivery is
 * not fire-and-forget. Events are persisted BEFORE the request, retried with
 * backoff, replayed on the next page load, and only dropped once the receiver
 * confirms or permanently rejects them.
 *
 * Retrying is SAFE here because every event carries a stable `event_id` and the
 * receiver upserts on it (`idempotency_key`). A retry of a request that
 * actually landed is absorbed, not double-counted — which is what makes this
 * different from the naive retry that previously duplicated every event.
 *
 * Requires the receiver to allow CORS so we can read the status. In n8n set the
 * Webhook node's "Allowed Origins (CORS)". Without it every send looks failed
 * and events pile up in the outbox — which is at least VISIBLE, rather than
 * silently lost.
 * ------------------------------------------------------------------------- */

interface Job {
  key: string;
  url: string;
  body: string;
  tries: number;
  firstAt: number;
  lastError?: string;
}

const OUTBOX = '__outbox';
const MAX_TRIES = 6;
const MAX_JOBS = 100;

let outbox: Job[] = [];
let flushing = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function persist(): void {
  try {
    localStorage.setItem(OUTBOX, JSON.stringify(outbox.slice(-MAX_JOBS)));
  } catch {
    /* private mode */
  }
}

async function attempt(job: Job): Promise<'ok' | 'retry' | 'drop'> {
  try {
    const res = await fetch(job.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: job.body,
      keepalive: true,
    });
    if (res.ok) return 'ok';
    // 4xx other than 429 will never succeed — stop burning retries on it.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      job.lastError = `http ${res.status}`;
      return 'drop';
    }
    job.lastError = `http ${res.status}`;
    return 'retry';
  } catch (err) {
    job.lastError = String(err);
    return 'retry';
  }
}

async function flush(): Promise<void> {
  if (flushing || outbox.length === 0 || !navigator.onLine) return;
  flushing = true;

  for (const job of [...outbox]) {
    const result = await attempt(job);
    job.tries += 1;

    if (result === 'ok') {
      outbox = outbox.filter((j) => j.key !== job.key);
    } else if (result === 'drop' || job.tries >= MAX_TRIES) {
      // Permanently failed. Keep it visible rather than deleting it silently.
      console.error('[outbox] giving up on event', job.key, job.lastError);
      outbox = outbox.filter((j) => j.key !== job.key);
      reportDead(job);
    }
  }

  flushing = false;
  persist();
  if (outbox.length) schedule();
}

function schedule(): void {
  if (timer) return;
  const tries = Math.min(...outbox.map((j) => j.tries));
  timer = setTimeout(
    () => {
      timer = null;
      void flush();
    },
    Math.min(1000 * 2 ** tries, 60_000),
  );
}

/**
 * Report a permanently-lost event.
 *
 * This MUST NOT go to the webhook that just failed six times - that was the
 * original bug: the failure report died for the same reason the event did, so
 * permanent losses were invisible. It goes to an independent sink instead.
 * If none is configured we at least leave a durable local record, so the loss
 * is recoverable from the browser rather than silent.
 */
function reportDead(job: Job): void {
  if (config.deadLetterUrl) {
    try {
      navigator.sendBeacon(
        config.deadLetterUrl,
        new Blob([job.body], { type: 'application/json' }),
      );
      return;
    } catch {
      /* fall through to the local record */
    }
  }
  try {
    const log = JSON.parse(localStorage.getItem('__lost') ?? '[]');
    log.push({ at: Date.now(), error: job.lastError, body: job.body });
    localStorage.setItem('__lost', JSON.stringify(log.slice(-20)));
  } catch {
    /* nothing further is possible from the browser */
  }
}

export function post(url: string, body: unknown, key: string): void {
  if (!url) return;
  outbox.push({ key, url, body: JSON.stringify(body), tries: 0, firstAt: Date.now() });
  if (outbox.length > MAX_JOBS) outbox = outbox.slice(-MAX_JOBS);
  persist();
  void flush();
}

function startOutbox(): void {
  try {
    outbox = JSON.parse(localStorage.getItem(OUTBOX) ?? '[]');
  } catch {
    outbox = [];
  }
  if (outbox.length) {
    console.warn(`[outbox] replaying ${outbox.length} event(s) from a previous session`);
    void flush();
  }
  addEventListener('online', () => void flush());
  addEventListener('pagehide', () => {
    // Best effort on unload — retried next load if it does not land.
    for (const job of outbox) {
      try {
        navigator.sendBeacon(job.url, new Blob([job.body], { type: 'application/json' }));
      } catch {
        /* ignore */
      }
    }
  });
}

let identity: Identity;
let started = false;

export function initTracking(): void {
  if (started) return; // StrictMode mounts twice
  started = true;

  let userId = read('__uid');
  if (!userId) {
    userId = uuid();
    try {
      localStorage.setItem('__uid', userId);
    } catch {
      /* ignore */
    }
  }

  startOutbox();

  identity = {
    userId,
    sessionId: uuid(),
    fbp: cookie('_fbp'),
    fbc: cookie('_fbc'),
    userAgent: navigator.userAgent,
    pageUrl: location.href,
    referrer: document.referrer,
    // Captured in index.html before this bundle parses, so they survive a JS
    // failure. Losing gclid/fbclid is unrecoverable.
    clickIds: JSON.parse(read('__clickids') ?? '{}'),
    clickIdsCurrent: Object.fromEntries(
      [...new URLSearchParams(location.search)].map(([k, v]) => [k.toLowerCase(), v]),
    ),
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
    screen: `${screen.width}x${screen.height}`,
    viewport: `${innerWidth}x${innerHeight}`,
  };

  for (const d of destinations) {
    try {
      d.init?.(identity);
    } catch (err) {
      console.warn(`[tracking] ${d.name} init failed`, err);
    }
  }
}

/** Returns the dedupe key so the caller can send the same id to the server. */
export function track(
  name: EventName,
  params: Record<string, unknown> = {},
  extra: {
    value?: number;
    user?: User;
    private?: Record<string, unknown>;
    /**
     * Reuse a previous id instead of generating one. Pass this when retrying a
     * conversion: a retry with a fresh id is a SECOND conversion to Meta, so a
     * request that silently succeeded would be counted twice.
     */
    eventId?: string;
  } = {},
): string {
  const id = extra.eventId ?? uuid();

  // The Pixel writes _fbp asynchronously, so re-read it — a boot-time snapshot
  // misses it on the first event.
  identity = { ...identity, fbp: cookie('_fbp') ?? identity.fbp, fbc: cookie('_fbc') ?? identity.fbc };

  const event: Event = {
    name,
    id,
    time: Date.now(),
    params: { ...params, session_id: identity.sessionId },
    ...(extra.value !== undefined && { value: extra.value }),
    ...(extra.user && { user: extra.user }),
    ...(extra.private && { private: extra.private }),
  };

  if (config.debug) console.info(`[track] ${name}`, { dedupeKey: id, ...event.params });

  for (const d of destinations) {
    try {
      d.send(
        {
          ...event,
          ...(d.acceptsPii ? {} : { user: undefined }),
          ...(d.firstParty ? {} : { private: undefined }),
        },
        identity,
      );
    } catch (err) {
      // A broken tag must never break the funnel.
      console.warn(`[tracking] ${d.name} failed`, err);
    }
  }

  return id;
}
