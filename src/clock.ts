// Local-time helpers. Every "day" in this system is a local calendar day in the
// configured time zone (spec §6): reminders fire at a local hour, captures are grouped
// by local date, and a prompt is due on the local day its due timestamp falls in.

export function localHour(now: Date, timeZone: string): number {
  return parseInt(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone }).format(now), 10) % 24;
}

export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now); // YYYY-MM-DD
}

// The instant local midnight next arrives in `timeZone`: the exclusive end of "today".
// Found by search rather than offset arithmetic, because in the few zones whose DST change
// happens at midnight (Santiago, Havana, the Azores) the wall-clock midnight may not exist
// or may occur twice. No local day is longer than 26 hours, so 36 hours ahead is always
// tomorrow or later.
export function endOfLocalDay(now: Date, timeZone: string): Date {
  const today = localDate(now, timeZone);
  let lo = now.getTime();
  let hi = lo + 36 * 3600_000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDate(new Date(mid), timeZone) === today) lo = mid; else hi = mid;
  }
  return new Date(hi);
}
