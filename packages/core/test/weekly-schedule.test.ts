import { describe, expect, it, vi } from "vitest";

import {
  compileWeeklySchedule,
  isAllowedInstant,
  nextAllowedInstant,
  type WeeklyScheduleInput,
} from "../src/weekly-schedule.js";

function utc(iso: string): number {
  return Date.parse(iso);
}

function schedule(input: Partial<WeeklyScheduleInput> & Pick<WeeklyScheduleInput, "rules">) {
  return compileWeeklySchedule({ timezone: input.timezone ?? "UTC", rules: input.rules });
}

describe("compileWeeklySchedule validation (C06/C07/C09/C11)", () => {
  it("rejects malformed times, start=end, and start=24:00; accepts end=24:00", () => {
    const base = { days: ["mon"] as const };
    for (const window of [
      { start: "9:00", end: "10:00" },
      { start: "24:00", end: "24:00" },
      { start: "10:00", end: "24:01" },
      { start: "10:60", end: "11:00" },
      { start: "10:00", end: "10:00" },
      { start: "23:59", end: "23:59" },
    ]) {
      expect(() => schedule({ rules: [{ ...base, windows: [window] }] })).toThrow(RangeError);
    }
    expect(() =>
      schedule({ rules: [{ ...base, windows: [{ start: "00:00", end: "24:00" }] }] }),
    ).not.toThrow();
    expect(() =>
      schedule({ rules: [{ ...base, windows: [{ start: "23:00", end: "07:00" }] }] }),
    ).not.toThrow();
  });

  it("rejects invalid timezones", () => {
    expect(() =>
      compileWeeklySchedule({
        timezone: "Mars/Olympus_Mons",
        rules: [{ days: ["mon"], windows: [{ start: "00:00", end: "24:00" }] }],
      }),
    ).toThrow(/IANA timezone/);
  });

  it("normalizes overlapping, adjacent, and duplicate windows into the same union (C07)", () => {
    const a = schedule({
      rules: [
        {
          days: ["mon"],
          windows: [
            { start: "09:00", end: "12:00" },
            { start: "11:00", end: "13:00" },
          ],
        },
        {
          days: ["mon", "mon"],
          windows: [
            { start: "13:00", end: "17:00" },
            { start: "09:30", end: "10:30" },
          ],
        },
      ],
    });
    const b = schedule({
      rules: [
        {
          days: ["mon"],
          windows: [
            { start: "13:00", end: "17:00" },
            { start: "09:30", end: "10:30" },
          ],
        },
        {
          days: ["mon"],
          windows: [
            { start: "11:00", end: "13:00" },
            { start: "09:00", end: "12:00" },
          ],
        },
      ],
    });
    expect(a.canonical).toBe(b.canonical);
    // 09:00–17:00 merged into one interval.
    expect(isAllowedInstant(a, utc("2026-09-07T11:59:59.999Z"))).toBe(true);
    expect(isAllowedInstant(a, utc("2026-09-07T17:00:00.000Z"))).toBe(false);
  });

  it("dedupes repeated weekdays without changing coverage (C09)", () => {
    const deduped = schedule({
      rules: [{ days: ["mon", "fri", "mon"], windows: [{ start: "08:00", end: "09:00" }] }],
    });
    const plain = schedule({
      rules: [{ days: ["fri", "mon"], windows: [{ start: "08:00", end: "09:00" }] }],
    });
    expect(deduped.canonical).toBe(plain.canonical);
  });

  it("applies full-day windows only to selected days; 24:00 maps to local midnight (C11)", () => {
    const s = schedule({
      timezone: "Asia/Shanghai",
      rules: [
        { days: ["sat", "sun"], windows: [{ start: "00:00", end: "24:00" }] },
        { days: ["wed"], windows: [{ start: "10:00", end: "11:00" }] },
      ],
    });
    // Saturday 2026-09-12 all day (local): Fri 16:00Z → Sun 16:00Z.
    expect(isAllowedInstant(s, utc("2026-09-11T15:59:59.999Z"))).toBe(false);
    expect(isAllowedInstant(s, utc("2026-09-11T16:00:00.000Z"))).toBe(true);
    expect(isAllowedInstant(s, utc("2026-09-13T15:59:59.999Z"))).toBe(true);
    expect(isAllowedInstant(s, utc("2026-09-13T16:00:00.000Z"))).toBe(false);
    // Wednesday 2026-09-16 10:00–11:00 local only.
    expect(isAllowedInstant(s, utc("2026-09-16T01:59:59.999Z"))).toBe(false);
    expect(isAllowedInstant(s, utc("2026-09-16T02:00:00.000Z"))).toBe(true);
    expect(isAllowedInstant(s, utc("2026-09-16T02:59:59.999Z"))).toBe(true);
    expect(isAllowedInstant(s, utc("2026-09-16T03:00:00.000Z"))).toBe(false);
  });
});

describe("isAllowedInstant / nextAllowedInstant boundaries (T05/T06)", () => {
  const daily = schedule({
    rules: [
      {
        days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        windows: [
          { start: "02:00", end: "04:00" },
          { start: "13:00", end: "17:00" },
        ],
      },
    ],
  });

  it("treats windows as [start, end) to the millisecond (T05)", () => {
    const narrow = schedule({
      rules: [{ days: ["mon"], windows: [{ start: "02:00", end: "04:00" }] }],
    });
    // Monday 2026-09-07.
    expect(isAllowedInstant(narrow, utc("2026-09-07T02:00:00.000Z"))).toBe(true);
    expect(isAllowedInstant(narrow, utc("2026-09-07T03:59:59.999Z"))).toBe(true);
    expect(isAllowedInstant(narrow, utc("2026-09-07T04:00:00.000Z"))).toBe(false);
    expect(nextAllowedInstant(narrow, utc("2026-09-07T04:00:00.000Z"))).toBe(
      utc("2026-09-14T02:00:00.000Z"),
    );
  });

  it("finds the next window across an intra-day gap (T06)", () => {
    expect(nextAllowedInstant(daily, utc("2026-09-07T12:00:00.000Z"))).toBe(
      utc("2026-09-07T13:00:00.000Z"),
    );
    expect(nextAllowedInstant(daily, utc("2026-09-07T04:00:00.000Z"))).toBe(
      utc("2026-09-07T13:00:00.000Z"),
    );
  });

  it("handles overnight 23:00–07:00 windows as one continuous interval (T06)", () => {
    const overnight = schedule({
      rules: [{ days: ["fri"], windows: [{ start: "23:00", end: "07:00" }] }],
    });
    // Friday 2026-09-11 23:00Z → Saturday 2026-09-12 07:00Z continuous.
    expect(isAllowedInstant(overnight, utc("2026-09-11T22:59:59.999Z"))).toBe(false);
    expect(isAllowedInstant(overnight, utc("2026-09-11T23:00:00.000Z"))).toBe(true);
    expect(isAllowedInstant(overnight, utc("2026-09-12T06:59:59.999Z"))).toBe(true);
    expect(isAllowedInstant(overnight, utc("2026-09-12T07:00:00.000Z"))).toBe(false);
    expect(nextAllowedInstant(overnight, utc("2026-09-12T07:00:00.000Z"))).toBe(
      utc("2026-09-18T23:00:00.000Z"),
    );
  });

  it("extends an overnight window into a day not present in days (T19)", () => {
    const sunday = schedule({
      rules: [{ days: ["sun"], windows: [{ start: "23:00", end: "07:00" }] }],
    });
    // Sunday 2026-09-13 23:00Z → Monday 2026-09-14 07:00Z; Monday is not in days.
    expect(isAllowedInstant(sunday, utc("2026-09-14T06:59:59.999Z"))).toBe(true);
    expect(isAllowedInstant(sunday, utc("2026-09-14T07:00:00.000Z"))).toBe(false);
    expect(nextAllowedInstant(sunday, utc("2026-09-14T07:00:00.000Z"))).toBe(
      utc("2026-09-20T23:00:00.000Z"),
    );
  });

  it("unrestricted schedules allow and return every instant", () => {
    const open = schedule({ rules: [] });
    expect(open.unrestricted).toBe(true);
    expect(isAllowedInstant(open, utc("2026-09-07T04:00:00.000Z"))).toBe(true);
    expect(nextAllowedInstant(open, utc("2026-09-07T04:00:00.000Z"))).toBe(
      utc("2026-09-07T04:00:00.000Z"),
    );
  });
});

describe("weekly boundary search (T20/T21)", () => {
  it("jumps directly to next week's only window without daily wakeups (T20)", () => {
    const mondayOnly = schedule({
      rules: [{ days: ["mon"], windows: [{ start: "02:00", end: "03:00" }] }],
    });
    // Monday 2026-09-07 03:00Z (just closed) → next Monday.
    expect(nextAllowedInstant(mondayOnly, utc("2026-09-07T03:00:00.000Z"))).toBe(
      utc("2026-09-14T02:00:00.000Z"),
    );
    // Tuesday → next Monday, not a same-week rescan.
    expect(nextAllowedInstant(mondayOnly, utc("2026-09-08T10:00:00.000Z"))).toBe(
      utc("2026-09-14T02:00:00.000Z"),
    );
  });

  it("matches weekdays in the configured zone, not UTC (T21)", () => {
    const mondayShanghai = schedule({
      timezone: "Asia/Shanghai",
      rules: [{ days: ["mon"], windows: [{ start: "00:00", end: "24:00" }] }],
    });
    // Monday in Shanghai starts Sunday 16:00Z.
    expect(isAllowedInstant(mondayShanghai, utc("2026-09-06T15:59:59.999Z"))).toBe(false);
    expect(isAllowedInstant(mondayShanghai, utc("2026-09-06T16:00:00.000Z"))).toBe(true);
    // Monday 24:00 local = Tuesday 00:00 local = Monday 16:00Z.
    expect(isAllowedInstant(mondayShanghai, utc("2026-09-07T16:00:00.000Z"))).toBe(false);
    expect(nextAllowedInstant(mondayShanghai, utc("2026-09-07T16:00:00.000Z"))).toBe(
      utc("2026-09-13T16:00:00.000Z"),
    );
  });
});

describe("user example calendar (T17/T18)", () => {
  const user = schedule({
    timezone: "Asia/Shanghai",
    rules: [
      {
        days: ["mon", "tue", "wed", "thu", "fri"],
        windows: [
          { start: "18:00", end: "24:00" },
          { start: "00:00", end: "13:00" },
        ],
      },
      { days: ["sat", "sun"], windows: [{ start: "00:00", end: "24:00" }] },
    ],
  });

  it("opens and closes at workday boundaries to the millisecond (T17)", () => {
    // Wednesday 2026-09-09 local boundaries (UTC+8).
    expect(isAllowedInstant(user, utc("2026-09-09T04:59:59.999Z"))).toBe(true); // 12:59:59.999 local
    expect(isAllowedInstant(user, utc("2026-09-09T05:00:00.000Z"))).toBe(false); // 13:00 local
    expect(isAllowedInstant(user, utc("2026-09-09T09:59:59.999Z"))).toBe(false); // 17:59:59.999 local
    expect(isAllowedInstant(user, utc("2026-09-09T10:00:00.000Z"))).toBe(true); // 18:00 local
    expect(nextAllowedInstant(user, utc("2026-09-09T05:00:00.000Z"))).toBe(
      utc("2026-09-09T10:00:00.000Z"),
    );
  });

  it("keeps Friday 18:00 → Monday 13:00 continuous with no duplicate wakeups (T18)", () => {
    const probes: Array<[string, boolean]> = [
      ["2026-09-11T10:00:00.000Z", true], // Fri 18:00 local
      ["2026-09-11T15:30:00.000Z", true], // Fri 23:30 local
      ["2026-09-11T16:00:00.000Z", true], // Sat 00:00 local
      ["2026-09-12T08:00:00.000Z", true], // Sat 16:00 local
      ["2026-09-13T12:00:00.000Z", true], // Sun 20:00 local
      ["2026-09-13T16:00:00.000Z", true], // Mon 00:00 local (weekend end = Mon 00:00, weekday rule covers)
      ["2026-09-14T04:59:59.999Z", true], // Mon 12:59:59.999 local
      ["2026-09-14T05:00:00.000Z", false], // Mon 13:00 local
    ];
    for (const [iso, expected] of probes) {
      expect(isAllowedInstant(user, utc(iso)), iso).toBe(expected);
    }
    // Every instant inside the long interval is its own next boundary.
    for (const [iso, expected] of probes) {
      if (expected) {
        expect(nextAllowedInstant(user, utc(iso)), iso).toBe(utc(iso));
      }
    }
    // Monday 13:00 local → Monday 18:00 local.
    expect(nextAllowedInstant(user, utc("2026-09-14T05:00:00.000Z"))).toBe(
      utc("2026-09-14T10:00:00.000Z"),
    );
  });
});

describe("DST behavior (T09/T10/T22/T23)", () => {
  it("chooses the earliest UTC opening across disjoint repeated-hour windows", () => {
    const ny = schedule({
      timezone: "America/New_York",
      rules: [{ days: ["sun"], windows: [
        { start: "01:10", end: "01:20" },
        { start: "01:40", end: "01:50" },
      ] }],
    });
    expect(nextAllowedInstant(ny, utc("2026-11-01T05:25:00Z"))).toBe(utc("2026-11-01T05:40:00Z"));
  });

  it("reopens an overnight spill at the fallback transition itself", () => {
    const ny = schedule({
      timezone: "America/New_York",
      rules: [{ days: ["sat"], windows: [{ start: "23:00", end: "01:30" }] }],
    });
    expect(isAllowedInstant(ny, utc("2026-11-01T05:45:00Z"))).toBe(false);
    expect(nextAllowedInstant(ny, utc("2026-11-01T05:45:00Z"))).toBe(utc("2026-11-01T06:00:00Z"));
  });

  it("reopens a window whose start precedes the repeated hour", () => {
    const ny = schedule({
      timezone: "America/New_York",
      rules: [{ days: ["sun"], windows: [{ start: "00:30", end: "01:30" }] }],
    });
    expect(nextAllowedInstant(ny, utc("2026-11-01T05:45:00Z"))).toBe(utc("2026-11-01T06:00:00Z"));
    expect(nextAllowedInstant(ny, utc("2026-11-01T06:00:00.001Z"))).toBe(utc("2026-11-01T06:00:00.001Z"));
  });

  it("keeps an overnight spill across the spring jump inside its own end", () => {
    const ny = schedule({
      timezone: "America/New_York",
      rules: [{ days: ["sat"], windows: [{ start: "23:00", end: "03:30" }] }],
    });
    expect(nextAllowedInstant(ny, utc("2026-03-08T06:59:59.999Z"))).toBe(utc("2026-03-08T06:59:59.999Z"));
    expect(nextAllowedInstant(ny, utc("2026-03-08T07:00:00Z"))).toBe(utc("2026-03-08T07:00:00Z"));
    expect(nextAllowedInstant(ny, utc("2026-03-08T07:30:00Z"))).toBe(utc("2026-03-15T03:00:00Z"));
  });

  it("skips a deleted civil date without imposing a two-hour DST gap limit", () => {
    const apia = schedule({
      timezone: "Pacific/Apia",
      rules: [{ days: ["fri"], windows: [{ start: "00:00", end: "24:00" }] }],
    });
    // Apia skipped Friday 2011-12-30 when switching from UTC-10 to UTC+14.
    expect(nextAllowedInstant(apia, utc("2011-12-29T22:00:00Z"))).toBe(utc("2012-01-05T10:00:00Z"));
  });

  it("finds a spring gap end with a bounded number of timezone conversions", () => {
    const ny = schedule({
      timezone: "America/New_York",
      rules: [{ days: ["sun"], windows: [{ start: "02:00", end: "03:30" }] }],
    });
    const conversions = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    try {
      expect(nextAllowedInstant(ny, utc("2026-03-08T06:00:00Z"))).toBe(utc("2026-03-08T07:00:00Z"));
      expect(conversions.mock.calls.length).toBeLessThan(100);
    } finally {
      conversions.mockRestore();
    }
  });

  it("allows both occurrences of a repeated fall-back hour (T09)", () => {
    const ny = schedule({
      timezone: "America/New_York",
      rules: [{ days: ["sun"], windows: [{ start: "01:15", end: "01:45" }] }],
    });
    // 2026-11-01 fall-back: 01:15 local occurs at 05:15Z (EDT) and 06:15Z (EST).
    expect(isAllowedInstant(ny, utc("2026-11-01T04:59:59.999Z"))).toBe(false);
    expect(isAllowedInstant(ny, utc("2026-11-01T05:15:00.000Z"))).toBe(true);
    expect(isAllowedInstant(ny, utc("2026-11-01T05:44:59.999Z"))).toBe(true);
    expect(isAllowedInstant(ny, utc("2026-11-01T05:45:00.000Z"))).toBe(false);
    expect(isAllowedInstant(ny, utc("2026-11-01T06:15:00.000Z"))).toBe(true);
    expect(isAllowedInstant(ny, utc("2026-11-01T06:44:59.999Z"))).toBe(true);
    expect(isAllowedInstant(ny, utc("2026-11-01T06:45:00.000Z"))).toBe(false);
    // Next opening before the first occurrence is the first occurrence.
    expect(nextAllowedInstant(ny, utc("2026-11-01T05:00:00.000Z"))).toBe(
      utc("2026-11-01T05:15:00.000Z"),
    );
    // Between the two occurrences the search finds the second occurrence.
    expect(nextAllowedInstant(ny, utc("2026-11-01T05:45:00.000Z"))).toBe(
      utc("2026-11-01T06:15:00.000Z"),
    );
  });

  it("gives a spring-forward window inside the gap no instant that week (T10/T23)", () => {
    const ny = schedule({
      timezone: "America/New_York",
      rules: [{ days: ["sun"], windows: [{ start: "02:15", end: "02:45" }] }],
    });
    // 2026-03-08 spring-forward removes 02:00–03:00 local entirely.
    expect(nextAllowedInstant(ny, utc("2026-03-08T00:00:00.000Z"))).toBe(
      utc("2026-03-15T06:15:00.000Z"),
    );
    // The following week's window exists (02:15 EDT = 06:15Z).
    expect(isAllowedInstant(ny, utc("2026-03-15T06:15:00.000Z"))).toBe(true);
    expect(isAllowedInstant(ny, utc("2026-03-15T06:44:59.999Z"))).toBe(true);
    expect(isAllowedInstant(ny, utc("2026-03-15T06:45:00.000Z"))).toBe(false);
  });

  it("never shifts a gap-bound start to a moment outside the window (T10)", () => {
    const ny = schedule({
      timezone: "America/New_York",
      rules: [{ days: ["sun"], windows: [{ start: "01:30", end: "03:30" }] }],
    });
    // Start 01:30 EST = 06:30Z exists → window opens normally.
    expect(nextAllowedInstant(ny, utc("2026-03-08T00:00:00.000Z"))).toBe(
      utc("2026-03-08T06:30:00.000Z"),
    );
    // Instants after the gap (03:00–03:30 EDT) remain inside the window.
    expect(isAllowedInstant(ny, utc("2026-03-08T07:00:00.000Z"))).toBe(true); // 03:00 EDT
    expect(isAllowedInstant(ny, utc("2026-03-08T07:29:59.999Z"))).toBe(true); // 03:29:59.999 EDT
    expect(isAllowedInstant(ny, utc("2026-03-08T07:30:00.000Z"))).toBe(false); // 03:30 EDT
  });

  it("advances a window start to the gap end when the gap end is inside the window", () => {
    const berlin = schedule({
      timezone: "Europe/Berlin",
      rules: [{ days: ["sun"], windows: [{ start: "02:30", end: "03:30" }] }],
    });
    // 2026-03-29: CET→CEST removes 02:00–03:00; the window opens at 03:00 CEST = 01:00Z.
    expect(nextAllowedInstant(berlin, utc("2026-03-28T00:00:00.000Z"))).toBe(
      utc("2026-03-29T01:00:00.000Z"),
    );
    expect(isAllowedInstant(berlin, utc("2026-03-29T01:00:00.000Z"))).toBe(true);
    expect(isAllowedInstant(berlin, utc("2026-03-29T01:29:59.999Z"))).toBe(true);
    expect(isAllowedInstant(berlin, utc("2026-03-29T01:30:00.000Z"))).toBe(false);
  });

  it("advances weekly boundaries by calendar, not fixed 604800s periods (T22)", () => {
    const berlin = schedule({
      timezone: "Europe/Berlin",
      rules: [{ days: ["sun"], windows: [{ start: "02:30", end: "03:30" }] }],
    });
    // 2026-03-22 (CET, UTC+1): 02:30 local = 01:30Z.
    expect(nextAllowedInstant(berlin, utc("2026-03-21T00:00:00.000Z"))).toBe(
      utc("2026-03-22T01:30:00.000Z"),
    );
    // One week later (CEST, UTC+2): 02:30 local = 00:30Z — 23 hours less than +7d.
    expect(nextAllowedInstant(berlin, utc("2026-03-29T01:30:00.000Z"))).toBe(
      utc("2026-04-05T00:30:00.000Z"),
    );
  });

  it("handles non-integer offsets and 30-minute DST transitions (T11)", () => {
    const kathmandu = schedule({
      timezone: "Asia/Kathmandu", // UTC+5:45
      rules: [{ days: ["mon"], windows: [{ start: "06:00", end: "07:00" }] }],
    });
    expect(nextAllowedInstant(kathmandu, utc("2026-09-07T00:00:00.000Z"))).toBe(
      utc("2026-09-07T00:15:00.000Z"),
    );
    expect(isAllowedInstant(kathmandu, utc("2026-09-07T01:14:59.999Z"))).toBe(true);
    expect(isAllowedInstant(kathmandu, utc("2026-09-07T01:15:00.000Z"))).toBe(false);

    const lordHowe = schedule({
      timezone: "Australia/Lord_Howe",
      rules: [{ days: ["sun"], windows: [{ start: "01:35", end: "01:55" }] }],
    });
    // 2026-04-05: DST ends, 02:00→01:30 (30-minute step), repeating 01:30–02:00.
    // First pass 01:35 +11:00 = 2026-04-04T14:35Z; second pass 01:35 +10:30 = 15:05Z.
    expect(isAllowedInstant(lordHowe, utc("2026-04-04T14:35:00.000Z"))).toBe(true);
    expect(isAllowedInstant(lordHowe, utc("2026-04-04T14:55:00.000Z"))).toBe(false);
    expect(isAllowedInstant(lordHowe, utc("2026-04-04T15:05:00.000Z"))).toBe(true);
    expect(isAllowedInstant(lordHowe, utc("2026-04-04T15:24:59.999Z"))).toBe(true);
    expect(isAllowedInstant(lordHowe, utc("2026-04-04T15:25:00.000Z"))).toBe(false);
    expect(nextAllowedInstant(lordHowe, utc("2026-04-04T15:00:00.000Z"))).toBe(
      utc("2026-04-04T15:05:00.000Z"),
    );
  });

  it("does not fire inside the closed afternoon gap on the host-TZ-independent path (T08)", () => {
    const shanghai = schedule({
      timezone: "Asia/Shanghai",
      rules: [
        {
          days: ["mon"],
          windows: [
            { start: "00:00", end: "13:00" },
            { start: "18:00", end: "24:00" },
          ],
        },
      ],
    });
    const utcEquivalent = schedule({
      timezone: "UTC",
      rules: [{ days: ["mon"], windows: [{ start: "00:00", end: "24:00" }] }],
    });
    // Monday 14:00 Shanghai = 06:00Z: closed in Shanghai, open in UTC.
    expect(isAllowedInstant(shanghai, utc("2026-09-07T06:00:00.000Z"))).toBe(false);
    expect(isAllowedInstant(utcEquivalent, utc("2026-09-07T06:00:00.000Z"))).toBe(true);
  });
});

describe("search bounds", () => {
  it("stays within a bounded day search even for rare windows", () => {
    const yearlyish = schedule({
      rules: [{ days: ["sun"], windows: [{ start: "00:00", end: "00:01" }] }],
    });
    const start = Date.now();
    const next = nextAllowedInstant(yearlyish, utc("2026-09-09T05:00:00.000Z"));
    expect(next).toBe(utc("2026-09-13T00:00:00.000Z"));
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
