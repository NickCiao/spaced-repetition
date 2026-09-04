import { describe, expect, it } from "vitest";
import { endOfLocalDay, hourLabel, localDate, localHour, timeZoneOptions, timeZoneRegions } from "../src/clock";

describe("clock", () => {
  it("endOfLocalDay is the next local midnight, as a UTC instant", () => {
    expect(endOfLocalDay(new Date("2026-08-21T09:00:00Z"), "UTC").toISOString()).toBe("2026-08-22T00:00:00.000Z");
    // 07:00 PDT; midnight PDT is 07:00Z
    expect(endOfLocalDay(new Date("2026-08-21T14:00:00Z"), "America/Los_Angeles").toISOString()).toBe("2026-08-22T07:00:00.000Z");
    // 20:00Z is already the next morning in Tokyo
    expect(endOfLocalDay(new Date("2026-08-21T20:00:00Z"), "Asia/Tokyo").toISOString()).toBe("2026-08-22T15:00:00.000Z");
  });

  it("endOfLocalDay handles a DST change between now and midnight", () => {
    // 01:00 PST on 2026-03-08, an hour before clocks spring forward; the next midnight is PDT (UTC−7)
    expect(endOfLocalDay(new Date("2026-03-08T09:00:00Z"), "America/Los_Angeles").toISOString()).toBe("2026-03-09T07:00:00.000Z");
    // 01:00 PDT on 2026-11-01, an hour before clocks fall back; the next midnight is PST (UTC−8)
    expect(endOfLocalDay(new Date("2026-11-01T08:00:00Z"), "America/Los_Angeles").toISOString()).toBe("2026-11-02T08:00:00.000Z");
  });

  it("endOfLocalDay is right in zones whose DST change happens at midnight", () => {
    // Chile springs forward at 00:00 → 01:00 on 2026-09-06: Sep 5 ends at 01:00 CLST (UTC−3)
    expect(endOfLocalDay(new Date("2026-09-05T18:00:00Z"), "America/Santiago").toISOString()).toBe("2026-09-06T04:00:00.000Z");
    // ...and from the last local half-hour of that day the answer must still lie ahead of now
    expect(endOfLocalDay(new Date("2026-09-06T03:30:00Z"), "America/Santiago").toISOString()).toBe("2026-09-06T04:00:00.000Z");
    // Cuba springs forward at 00:00 → 01:00 on 2026-03-08: Mar 7 ends at 01:00 CDT (UTC−4)
    expect(endOfLocalDay(new Date("2026-03-07T18:00:00Z"), "America/Havana").toISOString()).toBe("2026-03-08T05:00:00.000Z");
  });

  it("endOfLocalDay satisfies its contract around every transition it might meet", () => {
    const zones = ["UTC", "America/Los_Angeles", "America/Santiago", "America/Havana", "Atlantic/Azores",
                   "Australia/Lord_Howe", "Pacific/Chatham", "Antarctica/Troll", "Asia/Kolkata"];
    const days = ["2026-03-07", "2026-03-08", "2026-03-28", "2026-03-29", "2026-04-04", "2026-04-05", "2026-09-05",
                  "2026-09-06", "2026-09-26", "2026-09-27", "2026-10-24", "2026-10-25", "2026-10-31", "2026-11-01"];
    for (const tz of zones) for (const day of days) for (const hour of [0, 5, 11, 17, 23]) {
      const now = new Date(`${day}T${String(hour).padStart(2, "0")}:30:00Z`);
      const end = endOfLocalDay(now, tz);
      const today = localDate(now, tz);
      expect(end.getTime(), `${tz} ${now.toISOString()}`).toBeGreaterThan(now.getTime());
      expect(localDate(new Date(end.getTime() - 1), tz), `${tz} ${now.toISOString()}`).toBe(today);
      expect(localDate(end, tz), `${tz} ${now.toISOString()}`).not.toBe(today);
    }
  });

  it("localHour and localDate respect time zones", () => {
    expect(localHour(new Date("2026-08-20T14:00:00Z"), "America/Los_Angeles")).toBe(7);
    expect(localHour(new Date("2026-08-20T14:00:00Z"), "UTC")).toBe(14);
    expect(localDate(new Date("2026-08-21T03:00:00Z"), "America/Los_Angeles")).toBe("2026-08-20");
  });

  it("hourLabel is 12-hour wall time on the hour", () => {
    expect(hourLabel(0)).toBe("12:00 AM");
    expect(hourLabel(6)).toBe("6:00 AM");
    expect(hourLabel(12)).toBe("12:00 PM");
    expect(hourLabel(18)).toBe("6:00 PM");
    expect(hourLabel(23)).toBe("11:00 PM");
  });

  it("timeZoneOptions lists IANA zones and keeps a legacy selected id", () => {
    const now = new Date("2026-09-04T14:00:00Z");
    const opts = timeZoneOptions("US/Eastern", now);
    expect(opts.some(z => z.id === "America/New_York")).toBe(true);
    expect(opts.some(z => z.id === "America/Los_Angeles")).toBe(true);
    const eastern = opts.find(z => z.id === "US/Eastern");
    expect(eastern?.region).toBe("US");
    const nyc = opts.find(z => z.id === "America/New_York");
    expect(nyc?.label).toContain("New York");
    expect(nyc?.region).toBe("America");
    const regions = timeZoneRegions(opts);
    expect(regions[0]).toBe("Africa");
    expect(regions.indexOf("America")).toBeLessThan(regions.indexOf("Europe"));
    expect(regions.indexOf("US")).toBeGreaterThan(regions.indexOf("Pacific"));
  });
});
