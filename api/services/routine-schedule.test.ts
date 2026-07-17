import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  computeNextRoutineRunAt,
  normalizeRoutineSchedule,
  parseRoutineCron,
  previewRoutineRunTimes,
  RoutineScheduleValidationError,
  validateRoutineSchedule,
} from "./routine-schedule.ts";

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof RoutineScheduleValidationError
      ? error.code
      : undefined;
  }
}

Deno.test("routine schedule: normalizes intervals to elapsed seconds", () => {
  assertEquals(
    normalizeRoutineSchedule({ every_minutes: 5 }),
    { type: "interval", every_seconds: 300 },
  );
  assertEquals(
    normalizeRoutineSchedule({ type: "interval", every_seconds: 60 }),
    { type: "interval", every_seconds: 60 },
  );
  assertEquals(
    iso(computeNextRoutineRunAt(
      { every_minutes: 5 },
      new Date("2026-07-17T12:00:00.123Z"),
    )),
    "2026-07-17T12:05:00.123Z",
  );
});
Deno.test("routine schedule: rejects unsafe or ambiguous intervals", () => {
  assertEquals(
    errorCode(() => normalizeRoutineSchedule({ every_seconds: 59 })),
    "interval_too_frequent",
  );
  assertEquals(
    errorCode(() => normalizeRoutineSchedule({ every_seconds: 60.5 })),
    "invalid_interval",
  );
  assertEquals(
    errorCode(() =>
      normalizeRoutineSchedule({ every_seconds: 60, every_minutes: 1 })
    ),
    "invalid_interval",
  );
  assertEquals(
    errorCode(() => normalizeRoutineSchedule({ type: "interval" })),
    "invalid_interval",
  );
  assertEquals(
    errorCode(() =>
      normalizeRoutineSchedule({
        type: "cron",
        cron: "* * * * *",
        every_minutes: 5,
      })
    ),
    "invalid_schedule",
  );
});

Deno.test("routine schedule: parses lists, ranges, steps, and Sunday alias", () => {
  const parsed = parseRoutineCron("0,15-45/15 8-18/2 * 1,6,12 0,7");
  assertEquals(parsed.minute.values, [0, 15, 30, 45]);
  assertEquals(parsed.hour.values, [8, 10, 12, 14, 16, 18]);
  assertEquals(parsed.month.values, [1, 6, 12]);
  assertEquals(parsed.dayOfWeek.values, [0]);
});

Deno.test("routine schedule: rejects malformed and impossible cron", () => {
  const invalid: Array<[string, string]> = [
    ["* * * *", "invalid_cron"],
    ["* * * * * *", "invalid_cron"],
    ["60 * * * *", "invalid_cron"],
    ["*/0 * * * *", "invalid_cron"],
    ["5-1 * * * *", "invalid_cron"],
    ["5/2 * * * *", "invalid_cron"],
    ["0 0 31 2 *", "impossible_cron"],
    [" 0 0 * * *", "invalid_cron"],
  ];
  for (const [expression, code] of invalid) {
    assertEquals(
      errorCode(() => normalizeRoutineSchedule(expression)),
      code,
      expression,
    );
  }
});

Deno.test("routine schedule: validation returns stable API errors", () => {
  assertEquals(validateRoutineSchedule({ every_seconds: 30 }), {
    valid: false,
    errors: [{
      code: "interval_too_frequent",
      message: "Routine intervals must be at least 60 seconds",
      path: "schedule.every_seconds",
    }],
  });
  assertEquals(validateRoutineSchedule("*/15 * * * *"), {
    valid: true,
    schedule: {
      type: "cron",
      cron: "*/15 * * * *",
      timezone: "UTC",
    },
  });
});

Deno.test("routine schedule: requires a recognized IANA timezone", () => {
  assertEquals(
    normalizeRoutineSchedule({
      type: "cron",
      cron: "0 9 * * *",
      timezone: "America/New_York",
    }),
    {
      type: "cron",
      cron: "0 9 * * *",
      timezone: "America/New_York",
    },
  );
  assertEquals(
    errorCode(() =>
      normalizeRoutineSchedule({
        cron: "0 9 * * *",
        timezone: "Mars/Olympus_Mons",
      })
    ),
    "invalid_timezone",
  );
  assertEquals(
    errorCode(() =>
      normalizeRoutineSchedule({
        cron: "0 9 * * *",
        timezone: " America/New_York",
      })
    ),
    "invalid_timezone",
  );
});

Deno.test("routine schedule: computes timezone-aware winter and summer occurrences", () => {
  const schedule = {
    type: "cron",
    cron: "0 9 * * *",
    timezone: "America/New_York",
  };
  assertEquals(
    iso(computeNextRoutineRunAt(
      schedule,
      new Date("2026-01-15T13:59:00.000Z"),
    )),
    "2026-01-15T14:00:00.000Z",
  );
  assertEquals(
    iso(computeNextRoutineRunAt(
      schedule,
      new Date("2026-07-15T12:59:00.000Z"),
    )),
    "2026-07-15T13:00:00.000Z",
  );
});

Deno.test("routine schedule: applies conventional day-of-month/day-of-week OR behavior", () => {
  const from = new Date("2026-06-02T10:00:00.000Z"); // Tuesday
  assertEquals(
    iso(computeNextRoutineRunAt("0 9 15 * 1", from)),
    "2026-06-08T09:00:00.000Z", // Monday wins before the 15th.
  );
  assertEquals(
    iso(computeNextRoutineRunAt("0 9 15 * *", from)),
    "2026-06-15T09:00:00.000Z",
  );
  assertEquals(
    iso(computeNextRoutineRunAt("0 9 * * 1", from)),
    "2026-06-08T09:00:00.000Z",
  );
});

Deno.test("routine schedule: skips nonexistent spring-forward wall minutes", () => {
  assertEquals(
    iso(computeNextRoutineRunAt(
      {
        type: "cron",
        cron: "30 2 * * *",
        timezone: "America/New_York",
      },
      new Date("2026-03-07T08:00:00.000Z"),
    )),
    // March 8 has no 02:30 in New York.
    "2026-03-09T06:30:00.000Z",
  );
});

Deno.test("routine schedule: a repeated fall-back wall minute fires once", () => {
  const schedule = {
    type: "cron",
    cron: "30 1 * * *",
    timezone: "America/New_York",
  };
  assertEquals(
    iso(computeNextRoutineRunAt(
      schedule,
      new Date("2026-11-01T04:00:00.000Z"),
    )),
    "2026-11-01T05:30:00.000Z",
  );
  assertEquals(
    iso(computeNextRoutineRunAt(
      schedule,
      new Date("2026-11-01T05:30:00.000Z"),
    )),
    // 06:30Z is the repeated 01:30 and is deliberately skipped.
    "2026-11-02T06:30:00.000Z",
  );
});

Deno.test("routine schedule: preview is deterministic across fall-back", () => {
  assertEquals(
    previewRoutineRunTimes(
      {
        cron: "30 1 * * *",
        timezone: "America/New_York",
      },
      new Date("2026-10-31T06:00:00.000Z"),
      3,
    ).map((date) => date.toISOString()),
    [
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
      "2026-11-03T06:30:00.000Z",
    ],
  );
  assertThrows(
    () => previewRoutineRunTimes("* * * * *", new Date(), 101),
    RoutineScheduleValidationError,
  );
});

Deno.test("routine schedule: bounded search reaches Feb 29 across a non-leap century", () => {
  assertEquals(
    iso(computeNextRoutineRunAt(
      "0 0 29 2 *",
      new Date("2096-02-29T00:00:00.000Z"),
    )),
    "2104-02-29T00:00:00.000Z",
  );
});

Deno.test("routine schedule: cron occurrences are strictly after the cursor", () => {
  assertEquals(
    iso(computeNextRoutineRunAt(
      "0 * * * *",
      new Date("2026-07-17T12:00:00.000Z"),
    )),
    "2026-07-17T13:00:00.000Z",
  );
  assertEquals(
    iso(computeNextRoutineRunAt(
      "0 * * * *",
      new Date("2026-07-17T11:59:59.999Z"),
    )),
    "2026-07-17T12:00:00.000Z",
  );
});
