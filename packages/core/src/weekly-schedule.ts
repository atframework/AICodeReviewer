/**
 * Weekly execution-window calendar with IANA timezone support.
 *
 * Implements the auto-commit schedule contract from docs/ai/architecture.md §3.1.1 + docs/ai/decisions.md D35 (M15):
 *
 * - Rule groups declare `days` + `windows`; groups and windows form a union.
 * - Windows are half-open `[start, end)` local wall-clock minutes. `end` may be
 *   `24:00` (converted to the next-day boundary only inside the compiler; it is
 *   never passed to date APIs). `end < start` means the window continues past
 *   midnight and is attributed to the start day, so `days: [fri]` with
 *   `23:00–07:00` covers Friday 23:00 through Saturday 07:00 local.
 * - `rules: []` explicitly lifts all weekly restrictions (unrestricted).
 * - All persistence uses UTC epoch milliseconds; local wall-clock checks use
 *   the configured IANA zone via `Intl` (full-ICU Node >= 22, verified on
 *   Node 24.20 / tz 2026c). Host TZ never influences results.
 * - DST: membership is decided by converting the UTC instant to local wall
 *   time, so both occurrences of a repeated hour match when they fall inside a
 *   window, and nonexistent local times simply never match. Window *start*
 *   candidates that fall into a gap are advanced to the gap end only when that
 *   point still lies inside the same window; a window fully inside a gap has no
 *   executable instant that week and the search continues to the next real
 *   window (never shifting e.g. 02:15 to 03:15 outside the window).
 *
 * Week arithmetic is civil-calendar based; no fixed 604800-second periods and
 * no minute-by-minute polling search.
 */

export const SCHEDULE_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export type ScheduleWeekday = (typeof SCHEDULE_WEEKDAYS)[number];

const WEEKDAY_TO_INDEX: Readonly<Record<ScheduleWeekday, number>> = {
  mon: 0,
  tue: 1,
  wed: 2,
  thu: 3,
  fri: 4,
  sat: 5,
  sun: 6,
};

export interface ScheduleWindowInput {
  readonly start: string;
  readonly end: string;
}

export interface ScheduleRuleGroupInput {
  readonly days: readonly ScheduleWeekday[];
  readonly windows: readonly ScheduleWindowInput[];
}

export interface WeeklyScheduleInput {
  readonly timezone: string;
  readonly rules: readonly ScheduleRuleGroupInput[];
}

interface MinuteInterval {
  readonly startMin: number;
  /** Exclusive end; may exceed 1440 for overnight windows (attributed to start day). */
  readonly endMin: number;
}

export interface CompiledWeeklySchedule {
  readonly timezone: string;
  /** True when the explicit rule list is empty: every instant is allowed. */
  readonly unrestricted: boolean;
  /** Sorted, merged intervals per weekday (index 0 = Monday … 6 = Sunday). */
  readonly intervalsByDay: readonly (readonly MinuteInterval[])[];
  /** Canonical encoding used for memoization and policy versioning. */
  readonly canonical: string;
}

const MINUTES_PER_DAY = 1440;
// Bracket IANA offsets, including historical date-line changes. Transitions
// are located by offset probes and binary search, never minute-by-minute.
const OFFSET_BRACKET_MS = 26 * 3_600_000;
const OFFSET_PROBE_MS = 12 * 3_600_000;

const START_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/u;
const END_TIME_PATTERN = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/u;

export function parseWindowMinutes(
  window: ScheduleWindowInput,
): MinuteInterval {
  if (!START_TIME_PATTERN.test(window.start)) {
    throw new RangeError(
      `Invalid schedule window start "${window.start}": expected strict HH:mm in 00:00–23:59`,
    );
  }
  if (!END_TIME_PATTERN.test(window.end)) {
    throw new RangeError(
      `Invalid schedule window end "${window.end}": expected strict HH:mm in 00:00–23:59 or 24:00`,
    );
  }
  if (window.start === window.end) {
    throw new RangeError(
      `Invalid schedule window ${window.start}–${window.end}: start must differ from end; use 00:00–24:00 for a full day`,
    );
  }
  const startMin = hhmmToMinutes(window.start);
  const endRaw = window.end === "24:00" ? MINUTES_PER_DAY : hhmmToMinutes(window.end);
  // Overnight windows are attributed to the start day by extending past 1440.
  const endMin = endRaw <= startMin ? endRaw + MINUTES_PER_DAY : endRaw;
  return { startMin, endMin };
}

function hhmmToMinutes(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

export function isValidTimeZone(timezone: string): boolean {
  try {
    // Throws RangeError for unknown/invalid IANA identifiers.
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function compileWeeklySchedule(input: WeeklyScheduleInput): CompiledWeeklySchedule {
  if (!isValidTimeZone(input.timezone)) {
    throw new RangeError(`Invalid IANA timezone "${input.timezone}"`);
  }

  const perDay: MinuteInterval[][] = [[], [], [], [], [], [], []];
  for (const group of input.rules) {
    if (group.days.length === 0) {
      throw new RangeError("schedule rule group must declare a non-empty days array");
    }
    if (group.windows.length === 0) {
      throw new RangeError("schedule rule group must declare a non-empty windows array");
    }
    const dayIndexes = new Set<number>();
    for (const day of group.days) {
      const index = WEEKDAY_TO_INDEX[day];
      if (index === undefined) {
        throw new RangeError(`Unknown schedule weekday "${day}"`);
      }
      dayIndexes.add(index);
    }
    const windows = group.windows.map(parseWindowMinutes);
    for (const dayIndex of dayIndexes) {
      const list = perDay[dayIndex];
      if (!list) continue;
      list.push(...windows);
    }
  }

  const intervalsByDay = perDay.map((intervals) => mergeIntervals(intervals));
  const canonical = JSON.stringify({
    timezone: input.timezone,
    days: intervalsByDay.map((intervals) =>
      intervals.map((iv) => [iv.startMin, iv.endMin]),
    ),
  });

  return {
    timezone: input.timezone,
    unrestricted: input.rules.length === 0,
    intervalsByDay,
    canonical,
  };
}

function mergeIntervals(intervals: readonly MinuteInterval[]): MinuteInterval[] {
  const sorted = [...intervals].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const merged: MinuteInterval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.startMin <= last.endMin) {
      if (iv.endMin > last.endMin) {
        merged[merged.length - 1] = { startMin: last.startMin, endMin: iv.endMin };
      }
    } else {
      merged.push({ startMin: iv.startMin, endMin: iv.endMin });
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Civil-date math (Howard Hinnant's algorithms; proleptic Gregorian).
// ---------------------------------------------------------------------------

interface CivilDate {
  readonly year: number;
  readonly month: number; // 1–12
  readonly day: number; // 1–31
}

function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = month > 2 ? month - 3 : month + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(epochDays: number): CivilDate {
  const z = epochDays + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const year = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: month <= 2 ? year + 1 : year, month, day };
}

/** Monday = 0 … Sunday = 6. */
function weekdayIndex(date: CivilDate): number {
  const days = daysFromCivil(date.year, date.month, date.day);
  return (((days + 3) % 7) + 7) % 7;
}

// ---------------------------------------------------------------------------
// Timezone conversion via Intl.
// ---------------------------------------------------------------------------

interface LocalParts extends CivilDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timezone, formatter);
  }
  return formatter;
}

export function getLocalParts(timezone: string, utcMs: number): LocalParts {
  const parts = getFormatter(timezone).formatToParts(new Date(utcMs));
  const values: Partial<Record<string, number>> = {};
  for (const part of parts) {
    if (part.type === "literal") continue;
    values[part.type] = Number(part.value);
  }
  const hour = values.hour === 24 ? 0 : values.hour;
  return {
    year: values.year ?? 0,
    month: values.month ?? 0,
    day: values.day ?? 0,
    hour: hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

/** Milliseconds to add to UTC to obtain local wall time at `utcMs`. */
function getOffsetMs(timezone: string, utcMs: number): number {
  const parts = getLocalParts(timezone, utcMs);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return localAsUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Convert a local wall-clock minute to every UTC instant that maps to it.
 * Returns an empty array when the local time is nonexistent (DST gap or a
 * skipped date), one entry normally, and two entries (ascending) for a
 * repeated local time during a fall-back transition.
 */
export function localMinuteToUtcCandidates(timezone: string, target: LocalParts): number[] {
  const localAsUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
  );
  // Candidate UTC instants differ from localAsUtc by the zone offset (≤ 14 h);
  // sampling offsets ±26 h around the target brackets every transition that can
  // affect the conversion.
  const offsets = new Set<number>([
    getOffsetMs(timezone, localAsUtc - 26 * 3_600_000),
    getOffsetMs(timezone, localAsUtc),
    getOffsetMs(timezone, localAsUtc + 26 * 3_600_000),
  ]);
  const candidates = new Set<number>();
  for (const offset of offsets) {
    const utc = localAsUtc - offset;
    const parts = getLocalParts(timezone, utc);
    if (
      parts.year === target.year &&
      parts.month === target.month &&
      parts.day === target.day &&
      parts.hour === target.hour &&
      parts.minute === target.minute
    ) {
      candidates.add(utc);
    }
  }
  return [...candidates].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Membership and next-boundary search.
// ---------------------------------------------------------------------------

interface LocalPosition {
  readonly date: CivilDate;
  readonly weekday: number;
  readonly minuteOfDay: number;
}

function localPosition(timezone: string, utcMs: number): LocalPosition {
  const parts = getLocalParts(timezone, utcMs);
  const date = { year: parts.year, month: parts.month, day: parts.day };
  return {
    date,
    weekday: weekdayIndex(date),
    minuteOfDay: parts.hour * 60 + parts.minute,
  };
}

function intervalsCovering(
  intervals: readonly MinuteInterval[],
  minute: number,
): MinuteInterval | undefined {
  return intervals.find((iv) => iv.startMin <= minute && minute < iv.endMin);
}

export function isAllowedInstant(schedule: CompiledWeeklySchedule, utcMs: number): boolean {
  if (schedule.unrestricted) return true;
  const position = localPosition(schedule.timezone, utcMs);
  const own = schedule.intervalsByDay[position.weekday] ?? [];
  if (intervalsCovering(own, position.minuteOfDay)) {
    return true;
  }
  // Overnight spill from windows attributed to the previous calendar day.
  const previous = schedule.intervalsByDay[(position.weekday + 6) % 7] ?? [];
  return intervalsCovering(previous, position.minuteOfDay + MINUTES_PER_DAY) !== undefined;
}

/**
 * Return the earliest instant ≥ `utcMs` at which starting new work is allowed.
 * Weekly schedules always repeat, so the search is bounded; a `RangeError`
 * indicates a schedule that can never produce a real instant (defensive only).
 */
export function nextAllowedInstant(schedule: CompiledWeeklySchedule, utcMs: number): number {
  if (schedule.unrestricted) return utcMs;
  if (isAllowedInstant(schedule, utcMs)) return utcMs;

  const origin = localPosition(schedule.timezone, utcMs);
  const originEpochDay = daysFromCivil(origin.date.year, origin.date.month, origin.date.day);

  // A weekly cycle guarantees a candidate within 8 days (7 for the next week's
  // occurrence + 1 for overnight spill). 14 gives slack for one-off date skips.
  let earliest = Number.POSITIVE_INFINITY;
  // Yesterday's overnight window can reopen when the clock falls back into
  // its spill, even though its original local start is already in the past.
  for (let dayOffset = -1; dayOffset <= 14; dayOffset++) {
    if ((originEpochDay + dayOffset) * 86_400_000 - OFFSET_BRACKET_MS >= earliest) break;
    const date = civilFromDays(originEpochDay + dayOffset);
    const weekday = (origin.weekday + dayOffset + 7) % 7;
    const intervals = schedule.intervalsByDay[weekday] ?? [];
    for (const iv of intervals) {
      // Do not skip "already started" intervals by local minute: on fall-back
      // days the same local start has a second UTC occurrence still ahead.
      // Candidates are filtered by UTC below.
      const resolved = resolveWindowStart(schedule.timezone, date, iv, utcMs);
      for (const utc of resolved) {
        earliest = Math.min(earliest, utc);
      }
    }
  }

  if (Number.isFinite(earliest)) return earliest;

  throw new RangeError(
    `Weekly schedule in ${schedule.timezone} produced no executable instant within 14 days`,
  );
}

/**
 * Intersect the local window with each UTC segment having a constant offset.
 * Gaps produce no overlap; repeated hours produce both overlaps. A transition
 * can itself reopen a window even when its original start is not repeated.
 */
function resolveWindowStart(
  timezone: string,
  date: CivilDate,
  interval: MinuteInterval,
  notBefore: number,
): number[] {
  const midnight = daysFromCivil(date.year, date.month, date.day) * 86_400_000;
  const localStart = midnight + interval.startMin * 60_000;
  const localEnd = midnight + interval.endMin * 60_000;
  const searchEnd = localEnd + OFFSET_BRACKET_MS;
  let segmentStart = Math.max(localStart - OFFSET_BRACKET_MS, Math.floor(notBefore / 1000) * 1000);
  if (segmentStart >= searchEnd) return [];
  let offset = getOffsetMs(timezone, segmentStart);
  let probeStart = segmentStart;
  const candidates: number[] = [];
  const appendSegment = (end: number): void => {
    const candidate = Math.max(notBefore, segmentStart, localStart - offset);
    if (candidate < Math.min(end, localEnd - offset)) candidates.push(candidate);
  };
  while (probeStart < searchEnd) {
    const probeEnd = Math.min(probeStart + OFFSET_PROBE_MS, searchEnd);
    const nextOffset = getOffsetMs(timezone, probeEnd);
    if (nextOffset !== offset) {
      // tzdb transition instants have whole-second resolution. Locate the
      // first second carrying the new offset within this bounded probe span.
      let low = probeStart / 1000;
      let high = probeEnd / 1000;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (getOffsetMs(timezone, middle * 1000) === offset) low = middle;
        else high = middle;
      }
      const transition = high * 1000;
      appendSegment(transition);
      segmentStart = transition;
      offset = getOffsetMs(timezone, transition);
      probeStart = transition;
    } else {
      probeStart = probeEnd;
    }
  }
  appendSegment(searchEnd);
  return candidates;
}
