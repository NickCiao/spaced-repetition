// Local-time helpers. Every "day" in this system is a local calendar day in the
// configured time zone (spec §6): reminders fire at a local hour, captures are grouped
// by local date, and a prompt is due on the local day its due timestamp falls in.

export function localHour(now: Date, timeZone: string): number {
  return parseInt(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone }).format(now), 10) % 24;
}

/** 0 → "12:00 AM", 6 → "6:00 AM", 18 → "6:00 PM". */
export function hourLabel(hour: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:00 ${suffix}`;
}

export type TimeZoneOption = { id: string; label: string; region: string };

const REGION_HEAD = [
  "Africa", "America", "Antarctica", "Arctic", "Asia", "Atlantic",
  "Australia", "Europe", "Indian", "Pacific"
];

function zoneRegion(id: string): string {
  const slash = id.indexOf("/");
  return slash === -1 ? "Other" : id.slice(0, slash);
}

function zoneCity(id: string): string {
  const slash = id.indexOf("/");
  const rest = slash === -1 ? id : id.slice(slash + 1);
  return rest.replace(/_/g, " ").replace(/\//g, " / ");
}

function zoneAbbrev(id: string, now: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: id, timeZoneName: "short" }).formatToParts(now);
    return parts.find(p => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/** IANA zones for a <select>, with `selected` included even if it is a legacy alias. */
export function timeZoneOptions(selected: string, now = new Date()): TimeZoneOption[] {
  const ids = new Set(Intl.supportedValuesOf("timeZone"));
  if (selected) ids.add(selected);
  return [...ids].sort().map(id => {
    const city = zoneCity(id);
    const abbrev = zoneAbbrev(id, now);
    const label = abbrev && abbrev !== city ? `${city} (${abbrev})` : city;
    return { id, label, region: zoneRegion(id) };
  });
}

/** Continent groups first, then Etc / Other, with leftover legacy prefixes last. */
export function timeZoneRegions(options: TimeZoneOption[]): string[] {
  const seen = new Set(options.map(o => o.region));
  const rest = [...seen].filter(r => !REGION_HEAD.includes(r) && r !== "Etc" && r !== "Other").sort();
  return [
    ...REGION_HEAD.filter(r => seen.has(r)),
    ...(["Etc", "Other"] as const).filter(r => seen.has(r)),
    ...rest
  ];
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
