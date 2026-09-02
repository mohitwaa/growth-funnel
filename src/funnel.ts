/**
 * The funnel, as data.
 *
 * Adding / reordering / hiding a step is an edit to `steps` below.
 * No new component, no new route, no new tracking call.
 *
 * `id` and `value` are STABLE KEYS — analytics history depends on them, so
 * never rename one after launch. All other fields are display copy.
 */

export type Answers = Record<string, string>;

export type Step =
  | {
      kind: 'question';
      id: string;
      question: string;
      hint?: string;
      /** Return false to skip this step entirely. */
      when?: (a: Answers) => boolean;
      choices: {
        value: string;
        label: string;
        /** Points toward the lead score. */
        score?: number;
        /** Marks the lead as not qualifying. */
        disqualifies?: boolean;
      }[];
    }
  | { kind: 'form'; id: string; title: string; hint?: string; cta: string; consent: string }
  | { kind: 'result'; id: string };

export const funnel = {
  id: 'benefits_qualification',
  version: 'v1',

  headline: 'See if you qualify for monthly benefits',
  subheadline: 'You may be eligible for up to $4,152 every month.',
  note: 'Takes about 60 seconds. Free, with no obligation.',
  phone: '(866) 000-0000',
  disclaimer:
    'We are a private entity, not affiliated with or endorsed by the U.S. government or the Social Security Administration. This is not legal advice.',

  /** Base value per milestone, in USD. Multiplied by grade in `scoreLead`. */
  values: { start: 0.5, contact: 10, lead: 45 },

  steps: [
    {
      kind: 'question',
      id: 'age_band',
      question: 'What is your age range?',
      hint: 'Eligibility rules differ by age.',
      choices: [
        { value: 'under_18', label: 'Under 18', disqualifies: true },
        { value: '18_49', label: '18 to 49', score: 10 },
        { value: '50_64', label: '50 to 64', score: 25 },
        { value: '65_plus', label: '65 or older', score: 15 },
      ],
    },
    {
      kind: 'question',
      id: 'currently_receiving',
      question: 'Are you currently receiving disability benefits?',
      choices: [
        { value: 'none', label: 'No, I am not receiving any', score: 30 },
        { value: 'ssd', label: 'Yes — SSD', disqualifies: true },
        { value: 'ssi', label: 'Yes — SSI', disqualifies: true },
      ],
    },
    {
      kind: 'question',
      id: 'work_status',
      question: 'Are you currently working?',
      choices: [
        { value: 'not_working', label: 'Not working', score: 30 },
        { value: 'part_time', label: '20 hours or less per week', score: 20 },
        { value: 'full_time', label: 'More than 20 hours per week', score: 5 },
      ],
    },
    {
      kind: 'question',
      id: 'condition_duration',
      question: 'How long has your condition affected your ability to work?',
      hint: 'Most programs require 12 months or longer.',
      choices: [
        { value: 'lt_3m', label: 'Less than 3 months', score: 5 },
        { value: '3_12m', label: '3 to 12 months', score: 15 },
        { value: 'gt_12m', label: 'More than 12 months', score: 30 },
        { value: 'unsure', label: 'I am not sure', score: 10 },
      ],
    },
    {
      kind: 'question',
      id: 'medical_care',
      question: 'Are you currently under the care of a doctor?',
      hint: 'Medical records strengthen a claim considerably.',
      choices: [
        { value: 'yes', label: 'Yes', score: 25 },
        { value: 'no', label: 'No', score: 5 },
      ],
    },
    {
      kind: 'question',
      id: 'has_attorney',
      question: 'Are you already working with an attorney or advocate?',
      choices: [
        { value: 'no', label: 'No', score: 20 },
        { value: 'yes', label: 'Yes', disqualifies: true },
      ],
    },
    {
      kind: 'question',
      id: 'application_status',
      question: 'Where are you in the process?',
      // Conditional step — only shown to people not already represented.
      when: (a) => a.has_attorney === 'no',
      choices: [
        { value: 'not_applied', label: 'I have not applied yet', score: 20 },
        { value: 'waiting', label: 'Waiting on a first decision', score: 15 },
        { value: 'denied', label: 'My application was denied', score: 25 },
        { value: 'appealing', label: 'I have requested an appeal', score: 15 },
      ],
    },
    {
      kind: 'form',
      id: 'contact',
      title: 'Where should we send your results?',
      hint: 'We will confirm your eligibility and next steps.',
      cta: 'See what I qualify for',
      consent:
        'By clicking above, I provide my ESIGN signature and express written consent for a representative to contact me by phone, SMS, and email using automated technology at the number provided, even if it is on a Do Not Call registry. Consent is not a condition of any service.',
    },
    { kind: 'result', id: 'result' },
  ] satisfies Step[],
};

/** Steps whose `when` predicate passes. Derived from answers, never stored. */
export function visibleSteps(answers: Answers): Step[] {
  return funnel.steps.filter((s) => (s.kind === 'question' && s.when ? s.when(answers) : true));
}

export type Grade = 'A' | 'B' | 'C' | 'D';

export interface Score {
  percent: number;
  grade: Grade;
  qualified: boolean;
}

/**
 * Turn answers into a grade.
 *
 * This is the privacy boundary. Raw answers are special-category data (health,
 * disability, finances) which Meta and Google both PROHIBIT receiving. Ad
 * platforms get the output of this function — a grade and a value — and never
 * the answers themselves.
 */
export function scoreLead(answers: Answers): Score {
  let score = 0;
  let max = 0;
  let qualified = true;

  for (const step of visibleSteps(answers)) {
    if (step.kind !== 'question') continue;
    max += Math.max(0, ...step.choices.map((c) => c.score ?? 0));

    const choice = step.choices.find((c) => c.value === answers[step.id]);
    if (!choice) continue;
    if (choice.disqualifies) qualified = false;
    score += choice.score ?? 0;
  }

  const percent = max > 0 ? Math.round((score / max) * 100) : 0;
  const grade: Grade = !qualified ? 'D' : percent >= 80 ? 'A' : percent >= 60 ? 'B' : 'C';

  return { percent, grade, qualified };
}

/** Conversion value by grade. An A lead is worth ~4.5x a D lead. */
export function valueOf(base: number, grade: Grade): number {
  const multiplier: Record<Grade, number> = { A: 1.6, B: 1.15, C: 0.8, D: 0.35 };
  return Math.round(base * multiplier[grade] * 100) / 100;
}

/** The ONLY view of a lead that an ad platform may receive. */
export function adParams(score: Score) {
  return {
    funnel_id: funnel.id,
    lead_quality_tier: score.grade,
    lead_score: score.percent,
    qualified: score.qualified,
  };
}
