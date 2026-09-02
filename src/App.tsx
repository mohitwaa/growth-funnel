import { useEffect, useRef, useState } from 'react';
import {
  adParams, alreadyConverted, conversionPolicy, funnel, markConverted,
  scoreLead, valueOf, visibleSteps, type Answers,
} from './funnel';
import { Button, LeadForm, Progress, Question, Result, type Contact } from './screens';
import { conversionId, track } from './tracking';

/** All funnel state and every tracking call live here. Screens are pure. */
export default function App() {
  const [answers, setAnswers] = useState<Answers>({});
  const [index, setIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [startedAt] = useState(Date.now);
  /** Live step info for the unload handler — refs, so the listener never goes stale. */
  const live = useRef({ stepIndex: 1, stepId: '', total: 0, enteredAt: Date.now(), done: false });

  // Derived, never stored — stored copies go stale.
  const steps = visibleSteps(answers);
  const step = steps[Math.min(index, steps.length - 1)]!;
  const score = scoreLead(answers);

  live.current.stepIndex = index + 1;
  live.current.stepId = step.id;
  live.current.total = steps.length;

  /*
   * Drop-off. Without this a user who left is indistinguishable from one still
   * mid-funnel, and step-1 bounces — usually the largest cohort — never appear
   * at all. Fires once, on the way out, only if they did not convert.
   */
  useEffect(() => {
    const bail = (reason: string) => {
      if (live.current.done) return;
      live.current.done = true;
      track('funnel_abandoned', {
        funnel_id: funnel.id,
        step_id: live.current.stepId,
        step_index: live.current.stepIndex,
        step_total: live.current.total,
        time_on_step_ms: Date.now() - live.current.enteredAt,
        seconds_in_funnel: Math.round((Date.now() - startedAt) / 1000),
        reason,
      });
    };
    const onHide = () => bail('pagehide');
    const onVis = () => document.visibilityState === 'hidden' && bail('hidden');
    addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [startedAt]);

  function answer(value: string) {
    setAnswers((prev) => ({ ...prev, [step.id]: value }));

    // One event name for every step, with the step as a parameter. Keeps
    // cardinality bounded and makes a drop-off curve a single query.
    track('funnel_step', {
      funnel_id: funnel.id,
      step_id: step.id,
      step_index: index + 1,
      step_total: steps.length,
      answer: value,
    });

    live.current.enteredAt = Date.now();
    setIndex((i) => i + 1);
  }

  function submit(contact: Contact) {
    setSubmitting(true);

    // The exact consent wording the user saw, captured from the step they
    // submitted — not a constant, so it stays accurate if the copy changes.
    const consentText = step.kind === 'form' ? step.consent : '';

    const user = { ...contact };

    /*
     * The lead IS the phone number, so the conversion ids derive from it.
     *
     * That makes them stable two ways at once: a retry reuses the same id (a
     * fresh one would be a second conversion to Meta), and so does the SAME
     * PERSON on a second device — where localStorage is empty and the guard
     * below cannot see them. Meta then merges the two on event_id, which is
     * the only thing that can: by the time the server knows it is a duplicate,
     * that device's Pixel has already reported the conversion.
     */
    const leadKey = contact.phone;
    const ids = {
      contact: conversionId(leadKey, 'contact_captured'),
      lead: conversionId(leadKey, 'lead_submitted'),
    };

    // Fired before the request so the signal survives a failed submission.
    track('contact_captured', adParams(score), {
      value: valueOf(funnel.values.contact, score.grade),
      user,
      eventId: ids.contact,
    });

    /*
     * Fire-once guard, keyed on the LEAD (the phone number), not the session.
     * A person who resubmits - refresh, back button, second device - must not
     * produce a second conversion. n8n's phone lookup is the backstop for the
     * cross-device case this cannot see.
     */
    if (alreadyConverted(leadKey)) {
      live.current.done = true;
      setIndex((i) => i + 1);
      setSubmitting(false);
      return;
    }
    markConverted(leadKey);

    // Below the grade bar we still send the conversion, at a low value. Meta
    // needs to see weak leads to learn what a strong one looks like.
    const fullValue = conversionPolicy.fullValueGrades.includes(score.grade);
    const leadValue = fullValue
      ? valueOf(funnel.values.lead, score.grade)
      : conversionPolicy.lowValue;

    // This id is the dedupe key: the Pixel just fired with it, and the webhook
    // receives the same value to reuse on its CAPI call. Meta merges the two.
    track(
      'lead_submitted',
      {
        ...adParams(score),
        seconds_to_convert: Math.round((Date.now() - startedAt) / 1000),
        full_value: fullValue,
      },
      {
        value: leadValue,
        user,
        eventId: ids.lead,
        // First-party only. Raw answers are special-category data and are
        // stripped before any ad-platform destination sees them.
        private: {
          answers,
          score,
          funnel_version: funnel.version,
          // TCPA evidence — the exact wording shown, at the moment of consent.
          consent: {
            text: consentText,
            timestamp: new Date().toISOString(),
          },
        },
      },
    );

    /*
     * No blocking network call here on purpose.
     *
     * `track('lead_submitted')` has already handed the event to the outbox,
     * which persists it, retries with backoff and replays on the next page
     * load. Delivery is guaranteed independently of this render.
     *
     * Blocking the user on a synchronous request would add a failure mode
     * without adding a guarantee: a request that succeeded but lost its
     * response would show an error to someone whose lead we already have,
     * and they would resubmit.
     *
     * Failures surface where an operator can act on them - the outbox
     * dead-letters after 6 attempts, and n8n writes CAPI/Airtable failures
     * to the Dead Letter table.
     */
    live.current.done = true; // converted - never report as abandoned
    setIndex((i) => i + 1);
    setSubmitting(false);
  }

  return (
    <div className="app">
      <header className="header">
        <span className="logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 3l7 3v6c0 4.2-2.8 7.6-7 9-4.2-1.4-7-4.8-7-9V6l7-3z" strokeLinejoin="round" />
            <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <strong>Benefit Path</strong>
        <span className="trust">Secure · No obligation</span>
      </header>

      {index === 0 && (
        <div className="hero">
          <h1>{funnel.headline}</h1>
          <p className="hero__sub">{funnel.subheadline}</p>
          <p className="hero__note">{funnel.note}</p>
        </div>
      )}

      <main className="main">
        {step.kind !== 'result' && (
          <Progress
            percent={Math.round(((index + 1) / steps.length) * 100)}
            label={`Step ${index + 1} of ${steps.length}`}
          />
        )}

        <section className="card">
          {step.kind === 'question' && (
            <Question step={step} selected={answers[step.id]} onAnswer={answer} />
          )}
          {step.kind === 'form' && (
            <LeadForm step={step} submitting={submitting} onSubmit={submit} />
          )}
          {step.kind === 'result' && (
            <Result score={score} onCall={() => track('call_clicked', adParams(score))} />
          )}
        </section>

        {index > 0 && step.kind !== 'result' && (
          <Button ghost onClick={() => setIndex((i) => i - 1)}>
            ← Back
          </Button>
        )}
      </main>

      <footer className="footer">
        <p>{funnel.disclaimer}</p>
        <p>
          <a href="/privacy">Privacy policy</a> · <a href="/terms">Terms</a>
        </p>
      </footer>
    </div>
  );
}
