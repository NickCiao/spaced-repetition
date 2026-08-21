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

  it("replay determinism: same grades + timestamps → identical state", () => {
    const run = () => {
      let f = newCardFields(day(0));
      f = applyGrade(f, "remembered", day(0), R);
      f = applyGrade(f, "forgot", day(3), R);
      f = applyGrade(f, "remembered", day(4), R);
      return f;
    };
    expect(run()).toEqual(run());
  });

  it("retrievability decays over time and orders weakest-first", () => {
    let f = newCardFields(day(0));
    f = applyGrade(f, "remembered", day(0), R);
    const early = retrievability(f, day(1));
    const late = retrievability(f, day(30));
    expect(early).toBeGreaterThan(late);
    expect(early).toBeLessThanOrEqual(1);
    expect(late).toBeGreaterThanOrEqual(0);
  });
});
