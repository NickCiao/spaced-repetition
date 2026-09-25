import { describe, expect, it } from "vitest";
import { applyGrade, newCardFields, retrievability } from "../src/scheduler";

const R = 0.9;
const day = (n: number, from = new Date("2026-01-01T08:00:00Z")) =>
  new Date(from.getTime() + n * 86400_000);

describe("scheduler", () => {
  it("new card is due immediately with zero reps", () => {
    const f = newCardFields(day(0));
    expect(f.reps).toBe(0);
    expect(f.state).toBe(0);
    expect(new Date(f.due).getTime()).toBeLessThanOrEqual(day(0).getTime());
    expect(retrievability(f, day(0))).toBe(0);
  });

  it("intervals grow under consecutive remembered", () => {
    let f = newCardFields(day(0));
    f = applyGrade(f, "remembered", day(0), R);
    const i1 = new Date(f.due).getTime() - day(0).getTime();
    expect(i1).toBeGreaterThan(0);
    const at2 = new Date(f.due);
    f = applyGrade(f, "remembered", at2, R);
    const i2 = new Date(f.due).getTime() - at2.getTime();
    expect(i2).toBeGreaterThan(i1);
    expect(f.reps).toBe(2);
  });

  it("forgot increments lapses and shortens the next interval", () => {
    let f = newCardFields(day(0));
    f = applyGrade(f, "remembered", day(0), R);
    f = applyGrade(f, "remembered", new Date(f.due), R);
    const beforeStability = f.stability;
    const at = new Date(f.due);
    f = applyGrade(f, "forgot", at, R);
    expect(f.lapses).toBe(1);
    expect(f.stability).toBeLessThan(beforeStability);
    const next = new Date(f.due).getTime() - at.getTime();
    expect(next).toBeLessThanOrEqual(2 * 86400_000);
  });

  it("golden sequence: fixed grades + timestamps → exact FSRS state", () => {
    // Restore replays the event log, so these numbers are the contract. They pin
    // enable_fuzz: false and enable_short_term: false (either would move the due
    // dates, and short-term would put a forgotten card in Relearning, state 3),
    // and flag any ts-fsrs upgrade that changes scheduling. Values from ts-fsrs 5.4.1.
    const steps = [
      ["remembered", 0, "2026-01-04T08:00:00.000Z", 2.3065, 2.11810397, 1, 0, 2],
      ["remembered", 3, "2026-01-18T08:00:00.000Z", 13.82690327, 2.11121424, 2, 0, 2],
      ["forgot", 12, "2026-01-15T08:00:00.000Z", 1.6496484, 7.39223814, 3, 1, 2],
      ["remembered", 13, "2026-01-18T08:00:00.000Z", 3.67172981, 7.38007427, 4, 1, 2],
      ["remembered", 20, "2026-02-02T08:00:00.000Z", 12.49730706, 7.36792257, 5, 1, 2]
    ] as const;
    let f = newCardFields(day(0));
    for (const [grade, at, due, stability, difficulty, reps, lapses, state] of steps) {
      f = applyGrade(f, grade, day(at), R);
      expect({ due: f.due, reps: f.reps, lapses: f.lapses, state: f.state }, `${grade} on day ${at}`)
        .toEqual({ due, reps, lapses, state });
      expect(f.stability).toBeCloseTo(stability, 6);
      expect(f.difficulty).toBeCloseTo(difficulty, 6);
    }
  });

  it("retrievability decays over time and stays within [0, 1]", () => {
    let f = newCardFields(day(0));
    f = applyGrade(f, "remembered", day(0), R);
    const early = retrievability(f, day(1));
    const late = retrievability(f, day(30));
    expect(early).toBeGreaterThan(late);
    expect(early).toBeLessThanOrEqual(1);
    expect(late).toBeGreaterThanOrEqual(0);
  });
});
