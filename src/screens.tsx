import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { funnel, type Score, type Step } from './funnel';

// --- shared bits -------------------------------------------------------------

export function Button({
  children,
  ghost,
  loading,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { ghost?: boolean; loading?: boolean }) {
  return (
    <button type="button" className={ghost ? 'btn btn--ghost' : 'btn'} aria-busy={loading} {...rest}>
      {loading && (
        <svg className="spinner" viewBox="0 0 24 24" role="status" aria-label="Loading">
          <circle cx="12" cy="12" r="9" fill="none" strokeWidth="3" opacity=".25" />
          <path d="M21 12a9 9 0 0 0-9-9" fill="none" strokeWidth="3" strokeLinecap="round" />
        </svg>
      )}
      {children}
    </button>
  );
}

export function Progress({ percent, label }: { percent: number; label: string }) {
  return (
    <div className="progress">
      <div
        className="progress__track"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className="progress__fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="progress__label">{label}</span>
    </div>
  );
}

/** Without this a render throw unmounts the whole tree and shows a white page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="crash">
        <h1>Something went wrong</h1>
        <p>Please refresh to start again.</p>
        <Button onClick={() => location.reload()}>Refresh</Button>
      </div>
    );
  }
}

/** Focus the new heading so a screen change is not silent to screen readers. */
function useFocusOnChange(key: string) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), [key]);
  return ref;
}

// --- Question ----------------------------------------------------------------

export function Question({
  step,
  selected,
  onAnswer,
}: {
  step: Extract<Step, { kind: 'question' }>;
  selected: string | undefined;
  onAnswer: (value: string) => void;
}) {
  const heading = useFocusOnChange(step.id);

  return (
    <div className="stack">
      <h2 className="title" tabIndex={-1} ref={heading}>
        {step.question}
      </h2>
      {step.hint && <p className="hint">{step.hint}</p>}

      <div className="options">
        {step.choices.map((c) => (
          <button
            key={c.value}
            type="button"
            className={`option${selected === c.value ? ' is-selected' : ''}`}
            aria-pressed={selected === c.value}
            onClick={() => onAnswer(c.value)}
          >
            <span>{c.label}</span>
            <span className="option__tick" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="13" height="13">
                <path
                  d="M4 10.5l4 4 8-9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// --- Lead form ---------------------------------------------------------------

export interface Contact {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  zip: string;
}

const FIELDS = [
  { name: 'firstName', label: 'First name', type: 'text', mode: 'text', auto: 'given-name' },
  { name: 'lastName', label: 'Last name', type: 'text', mode: 'text', auto: 'family-name' },
  { name: 'email', label: 'Email address', type: 'email', mode: 'email', auto: 'email' },
  { name: 'phone', label: 'Phone number', type: 'tel', mode: 'tel', auto: 'tel-national' },
  { name: 'zip', label: 'ZIP code', type: 'text', mode: 'numeric', auto: 'postal-code' },
] as const;

type FieldName = (typeof FIELDS)[number]['name'];

const digits = (s: string) => s.replace(/\D/g, '');

function formatPhone(raw: string): string {
  const d = digits(raw).replace(/^1/, '').slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** Messages say what to DO, never "invalid input". */
function validate(field: FieldName, value: string): string {
  const v = value.trim();
  switch (field) {
    case 'firstName':
      return v ? '' : 'Enter your first name';
    case 'lastName':
      return v ? '' : 'Enter your last name';
    case 'email':
      if (!v) return 'Enter your email address';
      return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v) ? '' : 'Enter a valid email, like name@example.com';
    case 'phone':
      if (!v) return 'Enter your phone number';
      if (digits(v).length !== 10) return 'Enter a 10-digit phone number';
      return /^[01]/.test(digits(v)) ? 'Area code cannot start with 0 or 1' : '';
    case 'zip':
      return !v || /^\d{5}$/.test(v) ? '' : 'Enter a 5-digit ZIP code';
  }
}

export function LeadForm({
  step,
  submitting,
  onSubmit,
}: {
  step: Extract<Step, { kind: 'form' }>;
  submitting: boolean;
  onSubmit: (contact: Contact) => void;
}) {
  const [values, setValues] = useState<Record<FieldName, string>>({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    zip: '',
  });
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const firstBad = useRef<HTMLInputElement>(null);

  function change(field: FieldName, raw: string) {
    const value = field === 'phone' ? formatPhone(raw) : raw;
    setValues((v) => ({ ...v, [field]: value }));
    // Re-validate live only once this field has already errored, so the user
    // watches it clear — and is never told they are wrong mid-typing.
    setErrors((e) => (e[field] ? { ...e, [field]: validate(field, value) } : e));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    const found: Partial<Record<FieldName, string>> = {};
    for (const f of FIELDS) {
      const msg = validate(f.name, values[f.name]);
      if (msg) found[f.name] = msg;
    }
    setErrors(found);
    if (Object.keys(found).length) return firstBad.current?.focus();

    onSubmit({
      firstName: values.firstName.trim(),
      lastName: values.lastName.trim(),
      email: values.email.trim().toLowerCase(),
      phone: `1${digits(values.phone)}`, // E.164 — Meta needs a country code
      zip: values.zip.trim(),
    });
  }

  let refTaken = false;

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <h2 className="title">{step.title}</h2>
      {step.hint && <p className="hint">{step.hint}</p>}

      <div className="fields">
        {FIELDS.map((f) => {
          const error = errors[f.name];
          const takeRef = Boolean(error) && !refTaken;
          if (takeRef) refTaken = true;

          return (
            <div key={f.name} className={`field${error ? ' is-invalid' : ''}`}>
              {/* Label above the input. A placeholder is not a label. */}
              <label htmlFor={f.name}>
                {f.label}
                {f.name === 'zip' && <span className="optional"> (optional)</span>}
              </label>
              <input
                id={f.name}
                ref={takeRef ? firstBad : undefined}
                type={f.type}
                inputMode={f.mode}
                autoComplete={f.auto}
                value={values[f.name]}
                disabled={submitting}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? `${f.name}-err` : undefined}
                onChange={(e) => change(f.name, e.target.value)}
                onBlur={() => setErrors((e) => ({ ...e, [f.name]: validate(f.name, values[f.name]) }))}
              />
              {error && (
                <p className="error" id={`${f.name}-err`}>
                  {error}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* Disabled only while in flight — a disabled submit hides the reason. */}
      <Button type="submit" loading={submitting} disabled={submitting}>
        {submitting ? 'Checking your eligibility…' : step.cta}
      </Button>

      <p className="consent">{step.consent}</p>
    </form>
  );
}

// --- Result ------------------------------------------------------------------

export function Result({ score, onCall }: { score: Score; onCall: () => void }) {
  const heading = useFocusOnChange('result');

  return (
    <div className="stack stack--center">
      <div className={`badge badge--${score.qualified ? 'ok' : 'info'}`}>
        {score.qualified ? '✓' : 'i'}
      </div>

      <h2 className="title" tabIndex={-1} ref={heading}>
        {score.qualified
          ? "You're pre-qualified — let's confirm the details"
          : 'Thanks — here is where you stand'}
      </h2>

      <p className="hint">
        {score.qualified
          ? 'Based on your answers you may be eligible for monthly benefits. A specialist will review your case and call you shortly.'
          : 'Based on your answers you may not meet the criteria for this program right now. A specialist can still review your situation and point you to other options.'}
      </p>

      <a className="call" href={`tel:${digits(funnel.phone)}`} onClick={onCall}>
        <Button>Call {funnel.phone}</Button>
      </a>

      <p className="meta">
        Reference tier <strong>{score.grade}</strong> · No obligation · Free review
      </p>
    </div>
  );
}
