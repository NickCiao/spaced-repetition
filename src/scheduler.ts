import {
  createEmptyCard, fsrs, generatorParameters, Rating, State, type Card
} from "ts-fsrs";

export type Grade = "remembered" | "forgot";

export type SchedFields = {
  due: string; stability: number; difficulty: number; elapsed_days: number;
  scheduled_days: number; reps: number; lapses: number; state: number;
  last_review: string | null;
};

function toCard(f: SchedFields): Card {
  return {
    due: new Date(f.due),
    stability: f.stability,
    difficulty: f.difficulty,
    elapsed_days: f.elapsed_days,
    scheduled_days: f.scheduled_days,
    reps: f.reps,
    lapses: f.lapses,
    state: f.state as State,
    last_review: f.last_review ? new Date(f.last_review) : undefined
  } as Card;
}

function fromCard(c: Card): SchedFields {
  return {
    due: new Date(c.due).toISOString(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state as number,
    last_review: c.last_review ? new Date(c.last_review).toISOString() : null
  };
}

export function newCardFields(now: Date): SchedFields {
  return fromCard(createEmptyCard(now));
}

export function applyGrade(
  fields: SchedFields, grade: Grade, now: Date, desiredRetention: number
): SchedFields {
  // enable_fuzz: false — determinism is required for replay/restore (§8 of the spec).
  // Load-spreading fuzz was a nice-to-have; determinism wins. Note this in the task commit.
  //
  // enable_short_term: false — installed ts-fsrs (5.4.1) defaults to short-term
  // learning steps enabled, which requires a `learning_steps` field on Card and
  // schedules sub-day (minute-scale) intervals while a card cycles through
  // Learning/Relearning. SchedFields has no `learning_steps` column (none exists
  // in the `prompts` table either — see migrations/0001_init.sql), so that state
  // can't round-trip through DB persistence. Disabling short-term learning makes
  // every grade go straight through the day-granularity FSRS review path (New ->
  // Review, with lapses staying in Review rather than dropping to Relearning),
  // which is what the exported SchedFields shape assumes and what the tests
  // (interval growth, forgot <= 2 days) verify against.
  const f = fsrs(generatorParameters({
    request_retention: desiredRetention, enable_fuzz: false, enable_short_term: false
  }));
  const rating = grade === "remembered" ? Rating.Good : Rating.Again;
  const result = f.next(toCard(fields), now, rating);
  return fromCard(result.card);
}

export function retrievability(fields: SchedFields, now: Date): number {
  if (!fields.last_review || fields.reps === 0) return 0;
  const f = fsrs(generatorParameters());
  const r = f.get_retrievability(toCard(fields), now, false);
  return typeof r === "number" ? r : 0;
}
