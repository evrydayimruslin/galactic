/**
 * Production schedule parsing and occurrence calculation for persistent
 * routines.
 *
 * Cron expressions are five-field, numeric crontab expressions interpreted in
 * an IANA timezone (UTC by default). Local wall times are resolved to UTC with
 * Intl rather than by scanning every UTC minute. This has two useful
 * properties: rare schedules remain cheap to calculate and daylight-saving
 * transitions have explicit behavior:
 *
 * - a nonexistent spring-forward wall minute is skipped;
 * - an ambiguous fall-back wall minute fires at its first instant only.
 */

export const MIN_ROUTINE_SCHEDULE_INTERVAL_SECONDS = 60;
export const DEFAULT_ROUTINE_SCHEDULE_TIMEZONE = "UTC";
export const MAX_ROUTINE_SCHEDULE_PREVIEW_COUNT = 100;

// Numeric five-field cron has a maximum eight-year gap (Feb 29 across a
// non-leap century). Nine years gives that case margin while keeping every
// computation deterministically bounded.
const MAX_CRON_SEARCH_DAYS = (366 * 9) + 2;
const MAX_TIMEZONE_LENGTH = 100;

export type NormalizedProductionRoutineSchedule =
  | {
    type: "interval";
    every_seconds: number;
  }
  | {
    type: "cron";
    cron: string;
    timezone: string;
  };

export type RoutineScheduleValidationCode =
  | "invalid_schedule"
  | "invalid_interval"
  | "interval_too_frequent"
  | "invalid_cron"
  | "impossible_cron"
  | "invalid_timezone"
  | "invalid_date"
  | "invalid_preview_count";

export class RoutineScheduleValidationError extends Error {
  constructor(
    readonly code: RoutineScheduleValidationCode,
    message: string,
    readonly path = "schedule",
  ) {
    super(message);
    this.name = "RoutineScheduleValidationError";
  }
}

export type RoutineScheduleValidationResult =
  | { valid: true; schedule: NormalizedProductionRoutineSchedule }
  | {
    valid: false;
    errors: Array<{
      code: RoutineScheduleValidationCode;
      message: string;
      path: string;
    }>;
  };

interface CronFieldDefinition {
  label: string;
  min: number;
  max: number;
  sundayAlias?: boolean;
}

interface ParsedCronField {
  values: readonly number[];
  valueSet: ReadonlySet<number>;
  unrestricted: boolean;
}

export interface ParsedRoutineCron {
  expression: string;
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
}

interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const CRON_FIELDS: readonly CronFieldDefinition[] = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day of month", min: 1, max: 31 },
  { label: "month", min: 1, max: 12 },
  { label: "day of week", min: 0, max: 7, sundayAlias: true },
];

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validationError(
  code: RoutineScheduleValidationCode,
  message: string,
  path = "schedule",
): never {
  throw new RoutineScheduleValidationError(code, message, path);
}

function canonicalizeTimezone(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_ROUTINE_SCHEDULE_TIMEZONE;
  }
  if (typeof value !== "string" || value.trim() !== value || !value) {
    return validationError(
      "invalid_timezone",
      "schedule.timezone must be a non-empty IANA timezone name",
      "schedule.timezone",
    );
  }
  if (value.length > MAX_TIMEZONE_LENGTH || !/^[A-Za-z0-9._+\-/]+$/.test(value)) {
    return validationError(
      "invalid_timezone",
      "schedule.timezone must be a valid IANA timezone name",
      "schedule.timezone",
    );
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value })
      .resolvedOptions().timeZone;
  } catch {
    return validationError(
      "invalid_timezone",
      `Unknown IANA timezone: ${value}`,
      "schedule.timezone",
    );
  }
}

function parseIntegerToken(
  token: string,
  definition: CronFieldDefinition,
): number {
  if (!/^\d+$/.test(token)) {
    return validationError(
      "invalid_cron",
      `Cron ${definition.label} contains a non-numeric value: ${token || "(empty)"}`,
      "schedule.cron",
    );
  }
  const value = Number(token);
  if (
    !Number.isSafeInteger(value) || value < definition.min ||
    value > definition.max
  ) {
    return validationError(
      "invalid_cron",
      `Cron ${definition.label} must be between ${definition.min} and ${definition.max}`,
      "schedule.cron",
    );
  }
  return value;
}

function parseCronField(
  source: string,
  definition: CronFieldDefinition,
): ParsedCronField {
  if (!source) {
    return validationError(
      "invalid_cron",
      `Cron ${definition.label} must not be empty`,
      "schedule.cron",
    );
  }

  const values = new Set<number>();
  const segments = source.split(",");
  if (segments.some((segment) => !segment)) {
    return validationError(
      "invalid_cron",
      `Cron ${definition.label} contains an empty list item`,
      "schedule.cron",
    );
  }

  for (const segment of segments) {
    const slashParts = segment.split("/");
    if (slashParts.length > 2) {
      return validationError(
        "invalid_cron",
        `Cron ${definition.label} contains an invalid step: ${segment}`,
        "schedule.cron",
      );
    }
    const base = slashParts[0];
    const step = slashParts.length === 2
      ? parseIntegerToken(slashParts[1], {
        label: `${definition.label} step`,
        min: 1,
        max: definition.max - definition.min + 1,
      })
      : 1;

    let start: number;
    let end: number;
    if (base === "*") {
      start = definition.min;
      end = definition.max;
    } else if (base.includes("-")) {
      const range = base.split("-");
      if (range.length !== 2) {
        return validationError(
          "invalid_cron",
          `Cron ${definition.label} contains an invalid range: ${base}`,
          "schedule.cron",
        );
      }
      start = parseIntegerToken(range[0], definition);
      end = parseIntegerToken(range[1], definition);
      if (start > end) {
        return validationError(
          "invalid_cron",
          `Cron ${definition.label} range must be ascending: ${base}`,
          "schedule.cron",
        );
      }
    } else {
      if (slashParts.length === 2) {
        return validationError(
          "invalid_cron",
          `Cron ${definition.label} steps require * or an explicit range`,
          "schedule.cron",
        );
      }
      start = parseIntegerToken(base, definition);
      end = start;
    }

    for (let value = start; value <= end; value += step) {
      values.add(definition.sundayAlias && value === 7 ? 0 : value);
    }
  }

  const sorted = [...values].sort((a, b) => a - b);
  return {
    values: sorted,
    valueSet: new Set(sorted),
    // Only a literal star is unrestricted for conventional DOM/DOW behavior.
    // */n selects a subset and is therefore restricted.
    unrestricted: source === "*",
  };
}

function cronHasPossibleCalendarDate(cron: ParsedRoutineCron): boolean {
  if (cron.dayOfMonth.unrestricted || !cron.dayOfWeek.unrestricted) {
    return true;
  }
  // Leap year 2000 contains every possible numeric month/day pair.
  for (const month of cron.month.values) {
    const daysInMonth = new Date(Date.UTC(2000, month, 0)).getUTCDate();
    if (cron.dayOfMonth.values.some((day) => day <= daysInMonth)) return true;
  }
  return false;
}

/** Parse and validate a strict numeric five-field cron expression. */
export function parseRoutineCron(expression: string): ParsedRoutineCron {
  if (typeof expression !== "string" || !expression.trim()) {
    return validationError(
      "invalid_cron",
      "schedule.cron must be a non-empty five-field expression",
      "schedule.cron",
    );
  }
  if (expression.trim() !== expression) {
    return validationError(
      "invalid_cron",
      "schedule.cron must not contain leading or trailing whitespace",
      "schedule.cron",
    );
  }
  const rawFields = expression.split(/\s+/);
  if (rawFields.length !== 5) {
    return validationError(
      "invalid_cron",
      "schedule.cron must contain exactly five fields: minute hour day-of-month month day-of-week",
      "schedule.cron",
    );
  }

  const fields = rawFields.map((field, index) =>
    parseCronField(field, CRON_FIELDS[index])
  );
  const parsed: ParsedRoutineCron = {
    expression: rawFields.join(" "),
    minute: fields[0],
    hour: fields[1],
    dayOfMonth: fields[2],
    month: fields[3],
    dayOfWeek: fields[4],
  };
  if (!cronHasPossibleCalendarDate(parsed)) {
    return validationError(
      "impossible_cron",
      "schedule.cron can never occur for the selected month and day-of-month",
      "schedule.cron",
    );
  }
  return parsed;
}

/**
 * Normalize an external schedule declaration into the canonical stored form.
 * Invalid or ambiguous declarations throw RoutineScheduleValidationError.
 */
export function normalizeRoutineSchedule(
  input: unknown,
): NormalizedProductionRoutineSchedule {
  if (typeof input === "string") {
    const cron = parseRoutineCron(input).expression;
    return {
      type: "cron",
      cron,
      timezone: DEFAULT_ROUTINE_SCHEDULE_TIMEZONE,
    };
  }
  if (!isRecord(input)) {
    return validationError(
      "invalid_schedule",
      "schedule must be an interval object, cron object, or cron string",
    );
  }

  if (
    input.type !== undefined && input.type !== "interval" &&
    input.type !== "cron"
  ) {
    return validationError(
      "invalid_schedule",
      'schedule.type must be either "interval" or "cron"',
      "schedule.type",
    );
  }

  const hasCron = input.cron !== undefined;
  const hasSeconds = input.every_seconds !== undefined;
  const hasMinutes = input.every_minutes !== undefined;
  const wantsCron = input.type === "cron" || hasCron;

  if (wantsCron) {
    if (input.type === "interval" || hasSeconds || hasMinutes) {
      return validationError(
        "invalid_schedule",
        "A cron schedule cannot also define interval fields",
      );
    }
    if (typeof input.cron !== "string") {
      return validationError(
        "invalid_cron",
        "schedule.cron must be a string",
        "schedule.cron",
      );
    }
    const cron = parseRoutineCron(input.cron).expression;
    return {
      type: "cron",
      cron,
      timezone: canonicalizeTimezone(input.timezone),
    };
  }

  if (input.type === "cron") {
    return validationError(
      "invalid_cron",
      "A cron schedule must define schedule.cron",
      "schedule.cron",
    );
  }
  if (hasSeconds === hasMinutes) {
    return validationError(
      "invalid_interval",
      "An interval schedule must define exactly one of every_seconds or every_minutes",
    );
  }
  const value = hasSeconds ? input.every_seconds : input.every_minutes;
  const path = hasSeconds
    ? "schedule.every_seconds"
    : "schedule.every_minutes";
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return validationError(
      "invalid_interval",
      `${path} must be a positive integer`,
      path,
    );
  }
  const seconds = hasSeconds ? value : value * 60;
  if (!Number.isSafeInteger(seconds)) {
    return validationError(
      "invalid_interval",
      "The interval is too large",
      path,
    );
  }
  if (seconds < MIN_ROUTINE_SCHEDULE_INTERVAL_SECONDS) {
    return validationError(
      "interval_too_frequent",
      `Routine intervals must be at least ${MIN_ROUTINE_SCHEDULE_INTERVAL_SECONDS} seconds`,
      path,
    );
  }
  // An interval is elapsed time rather than wall-clock time. Validate a supplied
  // timezone to catch typos, but do not retain an operationally irrelevant field.
  if (input.timezone !== undefined) canonicalizeTimezone(input.timezone);
  return { type: "interval", every_seconds: seconds };
}

/** Validate without throwing, suitable for API error responses. */
export function validateRoutineSchedule(
  input: unknown,
): RoutineScheduleValidationResult {
  try {
    return { valid: true, schedule: normalizeRoutineSchedule(input) };
  } catch (error) {
    if (error instanceof RoutineScheduleValidationError) {
      return {
        valid: false,
        errors: [{
          code: error.code,
          message: error.message,
          path: error.path,
        }],
      };
    }
    throw error;
  }
}

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    // This cache is process-local and receives canonical IANA identifiers only.
    // Bound it defensively for environments that expose many tenant inputs.
    if (formatterCache.size >= 128) {
      const oldest = formatterCache.keys().next().value;
      if (typeof oldest === "string") formatterCache.delete(oldest);
    }
    formatterCache.set(timezone, formatter);
  }
  return formatter;
}

function zonedParts(
  instantMs: number,
  formatter: Intl.DateTimeFormat,
): LocalDateTimeParts & { second: number } {
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(instantMs))) {
    if (
      part.type === "year" || part.type === "month" || part.type === "day" ||
      part.type === "hour" || part.type === "minute" || part.type === "second"
    ) {
      values[part.type] = Number(part.value);
    }
  }
  if (
    !Number.isInteger(values.year) || !Number.isInteger(values.month) ||
    !Number.isInteger(values.day) || !Number.isInteger(values.hour) ||
    !Number.isInteger(values.minute) || !Number.isInteger(values.second)
  ) {
    throw new Error("Intl failed to resolve timezone date parts");
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function utcMillis(parts: LocalDateTimeParts, second = 0): number {
  // Date.UTC treats years 0..99 as 1900..1999. setUTCFullYear avoids that
  // historical JavaScript behavior and keeps this helper total.
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, second, 0);
  return date.getTime();
}

function equalLocalMinute(
  actual: LocalDateTimeParts,
  expected: LocalDateTimeParts,
): boolean {
  return actual.year === expected.year && actual.month === expected.month &&
    actual.day === expected.day && actual.hour === expected.hour &&
    actual.minute === expected.minute;
}

function timezoneOffsetAt(
  instantMs: number,
  formatter: Intl.DateTimeFormat,
): number {
  const minuteInstant = Math.floor(instantMs / 60_000) * 60_000;
  const local = zonedParts(minuteInstant, formatter);
  return utcMillis(local, local.second) - minuteInstant;
}

function possibleInstantsForLocalMinute(
  local: LocalDateTimeParts,
  formatter: Intl.DateTimeFormat,
  offsetCache: Map<string, readonly number[]>,
): readonly number[] {
  const localAsUtc = utcMillis(local);
  const cacheKey = `${local.year}-${local.month}-${local.day}`;
  let offsets = offsetCache.get(cacheKey);
  if (!offsets) {
    const sampled = new Set<number>();
    // Sample both sides of any transition near this local date. Six-hour
    // spacing over four days captures every offset that can map this date in
    // the modern IANA database, including half-hour DST changes.
    for (let deltaHours = -48; deltaHours <= 48; deltaHours += 6) {
      sampled.add(
        timezoneOffsetAt(localAsUtc + (deltaHours * 3_600_000), formatter),
      );
    }
    offsets = [...sampled];
    offsetCache.set(cacheKey, offsets);
  }

  const matches = new Set<number>();
  for (const offset of offsets) {
    const candidate = localAsUtc - offset;
    if (equalLocalMinute(zonedParts(candidate, formatter), local)) {
      matches.add(candidate);
    }
  }
  return [...matches].sort((a, b) => a - b);
}

function dayMatchesCron(
  cron: ParsedRoutineCron,
  year: number,
  month: number,
  day: number,
): boolean {
  if (!cron.month.valueSet.has(month)) return false;
  const dayOfMonthMatches = cron.dayOfMonth.valueSet.has(day);
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const dayOfWeekMatches = cron.dayOfWeek.valueSet.has(dayOfWeek);

  if (cron.dayOfMonth.unrestricted && cron.dayOfWeek.unrestricted) return true;
  if (cron.dayOfMonth.unrestricted) return dayOfWeekMatches;
  if (cron.dayOfWeek.unrestricted) return dayOfMonthMatches;
  // Conventional crontab semantics: when both fields are restricted, either
  // matching field makes the date eligible.
  return dayOfMonthMatches || dayOfWeekMatches;
}

function validDate(value: Date, path: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return validationError(
      "invalid_date",
      `${path} must be a valid Date`,
      path,
    );
  }
  return value;
}

function nextCronOccurrence(
  schedule: Extract<NormalizedProductionRoutineSchedule, { type: "cron" }>,
  from: Date,
): Date | null {
  const cron = parseRoutineCron(schedule.cron);
  const timezone = canonicalizeTimezone(schedule.timezone);
  const formatter = formatterFor(timezone);
  const fromMs = from.getTime();
  const startLocal = zonedParts(fromMs, formatter);
  const localCursor = new Date(0);
  localCursor.setUTCFullYear(
    startLocal.year,
    startLocal.month - 1,
    startLocal.day,
  );
  localCursor.setUTCHours(0, 0, 0, 0);
  const offsetCache = new Map<string, readonly number[]>();

  for (let dayIndex = 0; dayIndex < MAX_CRON_SEARCH_DAYS; dayIndex++) {
    const year = localCursor.getUTCFullYear();
    const month = localCursor.getUTCMonth() + 1;
    const day = localCursor.getUTCDate();
    if (dayMatchesCron(cron, year, month, day)) {
      for (const hour of cron.hour.values) {
        for (const minute of cron.minute.values) {
          if (
            dayIndex === 0 &&
            (hour < startLocal.hour ||
              (hour === startLocal.hour && minute <= startLocal.minute))
          ) {
            // An earlier wall minute cannot be a future instant except for the
            // second copy of a fall-back overlap, which our once-per-wall-minute
            // policy deliberately suppresses.
            continue;
          }
          const instants = possibleInstantsForLocalMinute(
            { year, month, day, hour, minute },
            formatter,
            offsetCache,
          );
          // No instant means a spring-forward gap. More than one means a
          // fall-back overlap; choosing the first makes that wall minute fire
          // exactly once.
          const firstInstant = instants[0];
          if (firstInstant !== undefined && firstInstant > fromMs) {
            return new Date(firstInstant);
          }
        }
      }
    }
    localCursor.setUTCDate(localCursor.getUTCDate() + 1);
  }
  return null;
}

/** Return the first scheduled instant strictly after `from`. */
export function computeNextRoutineRunAt(
  input: unknown,
  from: Date,
): Date | null {
  const validFrom = validDate(from, "from");
  const schedule = normalizeRoutineSchedule(input);
  if (schedule.type === "interval") {
    const nextMs = validFrom.getTime() + (schedule.every_seconds * 1000);
    if (!Number.isFinite(nextMs)) return null;
    return new Date(nextMs);
  }
  return nextCronOccurrence(schedule, validFrom);
}

/** Return the next N scheduled instants, each strictly after the prior one. */
export function previewRoutineRunTimes(
  input: unknown,
  from: Date,
  count = 5,
): Date[] {
  validDate(from, "from");
  if (
    !Number.isSafeInteger(count) || count < 1 ||
    count > MAX_ROUTINE_SCHEDULE_PREVIEW_COUNT
  ) {
    return validationError(
      "invalid_preview_count",
      `count must be an integer between 1 and ${MAX_ROUTINE_SCHEDULE_PREVIEW_COUNT}`,
      "count",
    );
  }
  const schedule = normalizeRoutineSchedule(input);
  const occurrences: Date[] = [];
  let cursor = new Date(from.getTime());
  for (let index = 0; index < count; index++) {
    const next = schedule.type === "interval"
      ? new Date(cursor.getTime() + (schedule.every_seconds * 1000))
      : nextCronOccurrence(schedule, cursor);
    if (!next || !Number.isFinite(next.getTime())) break;
    occurrences.push(next);
    cursor = next;
  }
  return occurrences;
}
