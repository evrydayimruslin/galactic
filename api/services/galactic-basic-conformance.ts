import {
  GALACTIC_STABLE_EFFECT_IDS,
  type GalacticStableEffectId,
} from "./galactic-agent-document.ts";

const GALACTIC_BASIC_CONFORMANCE_REPORT_VERSION = 1 as const;

export interface GalacticBasicCaseDeclaration {
  id: string;
  function: string;
  required: boolean;
}

export interface GalacticBasicCaseObservation
  extends GalacticBasicCaseDeclaration {
  /**
   * Host-authenticated evidence that dispatch found and entered this exported
   * function. A loader request alone is not function coverage.
   */
  invoked: boolean;
  success: boolean;
  observedEffects: readonly string[];
  /**
   * True when the padded-room runtime rejected an attempted external effect.
   * This remains disqualifying even when the case is optional: qualification
   * must never bless a release whose rehearsal escaped its available fixtures.
   */
  blockedExternalEffect?: boolean;
  /** Stable, bounded platform error code. Never pass raw error text here. */
  errorCode?: string;
}

interface GalacticBasicConformanceReport {
  schema_version: typeof GALACTIC_BASIC_CONFORMANCE_REPORT_VERSION;
  profile: "basic";
  passed: boolean;
  release_digest: string;
  cases: Array<{
    id: string;
    function: string;
    required: boolean;
    status: "passed" | "failed" | "optional_failed";
    observed_effects: GalacticStableEffectId[];
    undeclared_effects: GalacticStableEffectId[];
    blocked_external_effect: boolean;
    error_code?: string;
  }>;
  coverage: {
    cases: {
      declared: number;
      required: number;
      passed: number;
      optional_failed: number;
    };
    functions: {
      declared: number;
      exercised: number;
      names: string[];
    };
    effects: {
      /**
       * Effect coverage is counted as function/effect declaration pairs.
       * Authority is function-scoped, so exercising storage.read in function A
       * does not pretend that the same declaration in function B was tested.
       */
      declared: number;
      exercised: number;
      untested: number;
      exercised_ids: string[];
      untested_ids: string[];
    };
  };
}

export class GalacticBasicConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GalacticBasicConformanceError";
  }
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function safeErrorCode(value: string | undefined): string | undefined {
  if (!value || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) return undefined;
  return value;
}

const STABLE_EFFECT_SET = new Set<string>(GALACTIC_STABLE_EFFECT_IDS);

function isStableEffect(value: unknown): value is GalacticStableEffectId {
  return typeof value === "string" && STABLE_EFFECT_SET.has(value);
}

function normalizedObservedEffects(
  effects: readonly string[],
): GalacticStableEffectId[] {
  const normalized = new Set<GalacticStableEffectId>();
  for (const effect of effects) {
    if (!isStableEffect(effect)) {
      throw new GalacticBasicConformanceError(
        "gx.test returned an unknown observed effect",
      );
    }
    normalized.add(effect);
  }
  return [...normalized].sort();
}

/**
 * Compare padded-room observations with the function-scoped authority promise.
 *
 * The evaluator is deliberately pure. It does not trust Agent-supplied
 * coverage, execute code, sign claims, or persist results; callers provide
 * server-observed executions and server-compiled declarations.
 */
export function evaluateGalacticBasicConformance(input: {
  releaseDigest: string;
  functions: readonly string[];
  effectsByFunction: Readonly<Record<string, readonly string[]>>;
  cases: readonly GalacticBasicCaseDeclaration[];
  observations: readonly GalacticBasicCaseObservation[];
}): GalacticBasicConformanceReport {
  if (!/^[a-f0-9]{64}$/.test(input.releaseDigest)) {
    throw new GalacticBasicConformanceError(
      "Basic conformance requires a valid release digest",
    );
  }

  const functions = [...new Set(input.functions)].sort();
  if (
    functions.length === 0 ||
    functions.some((functionName) => !isSafeIdentifier(functionName))
  ) {
    throw new GalacticBasicConformanceError(
      "Basic conformance requires valid declared functions",
    );
  }
  const functionSet = new Set(functions);

  const declaredCaseIds = new Set<string>();
  for (const testCase of input.cases) {
    if (
      !isSafeIdentifier(testCase.id) ||
      declaredCaseIds.has(testCase.id) ||
      !functionSet.has(testCase.function)
    ) {
      throw new GalacticBasicConformanceError(
        "Basic conformance contains an invalid case declaration",
      );
    }
    declaredCaseIds.add(testCase.id);
  }
  if (
    input.cases.length === 0 ||
    !input.cases.some((testCase) => testCase.required)
  ) {
    throw new GalacticBasicConformanceError(
      "Basic conformance requires at least one required case",
    );
  }

  const observationByCase = new Map<string, GalacticBasicCaseObservation>();
  for (const observation of input.observations) {
    const declaration = input.cases.find((entry) =>
      entry.id === observation.id
    );
    if (
      !declaration ||
      observationByCase.has(observation.id) ||
      observation.function !== declaration.function ||
      observation.required !== declaration.required ||
      typeof observation.invoked !== "boolean"
    ) {
      throw new GalacticBasicConformanceError(
        "Basic conformance observations do not match the declared cases",
      );
    }
    observationByCase.set(observation.id, observation);
  }
  if (observationByCase.size !== input.cases.length) {
    throw new GalacticBasicConformanceError(
      "Basic conformance must observe every declared case",
    );
  }

  const declaredPairs = new Set<string>();
  for (const functionName of functions) {
    const declaredEffects = input.effectsByFunction[functionName] ?? [];
    for (const effect of new Set(declaredEffects)) {
      if (
        !isStableEffect(effect) &&
        !/^x-[a-z0-9][a-z0-9._-]{0,126}$/.test(effect)
      ) {
        throw new GalacticBasicConformanceError(
          "Basic conformance contains an invalid declared effect",
        );
      }
      declaredPairs.add(`${functionName}\u0000${effect}`);
    }
  }

  const exercisedFunctions = new Set<string>();
  const exercisedPairs = new Set<string>();
  let authorityViolation = false;
  let blockedExternalEffect = false;
  let requiredPassed = 0;
  let passed = 0;
  let optionalFailed = 0;

  const cases = input.cases.map((declaration) => {
    const observation = observationByCase.get(declaration.id)!;
    const observedEffects = normalizedObservedEffects(
      observation.observedEffects,
    );
    if (!observation.invoked && observedEffects.length > 0) {
      throw new GalacticBasicConformanceError(
        "Basic conformance cannot observe effects before function entry",
      );
    }
    if (observation.invoked) {
      exercisedFunctions.add(declaration.function);
    }
    const declaredForFunction = new Set(
      input.effectsByFunction[declaration.function] ?? [],
    );
    const undeclaredEffects = observedEffects.filter(
      (effect) => !declaredForFunction.has(effect),
    );
    for (const effect of observedEffects) {
      if (observation.invoked && declaredForFunction.has(effect)) {
        exercisedPairs.add(`${declaration.function}\u0000${effect}`);
      }
    }

    const caseBlocked = observation.blockedExternalEffect === true;
    const casePassed = observation.invoked &&
      observation.success &&
      undeclaredEffects.length === 0 &&
      !caseBlocked;
    if (declaration.required && casePassed) requiredPassed++;
    if (casePassed) passed++;
    if (!declaration.required && !casePassed) optionalFailed++;
    if (undeclaredEffects.length > 0) authorityViolation = true;
    if (caseBlocked) blockedExternalEffect = true;

    return {
      id: declaration.id,
      function: declaration.function,
      required: declaration.required,
      status: casePassed
        ? "passed" as const
        : declaration.required
        ? "failed" as const
        : "optional_failed" as const,
      observed_effects: observedEffects,
      undeclared_effects: undeclaredEffects,
      blocked_external_effect: caseBlocked,
      ...(safeErrorCode(observation.errorCode)
        ? { error_code: safeErrorCode(observation.errorCode) }
        : {}),
    };
  });

  const requiredCount = input.cases.filter((entry) => entry.required).length;
  const exercisedIds = [...exercisedPairs].sort();
  const untestedIds = [...declaredPairs].filter((pair) =>
    !exercisedPairs.has(pair)
  ).sort();

  return {
    schema_version: GALACTIC_BASIC_CONFORMANCE_REPORT_VERSION,
    profile: "basic",
    passed: requiredPassed === requiredCount &&
      !authorityViolation &&
      !blockedExternalEffect,
    release_digest: input.releaseDigest,
    cases,
    coverage: {
      cases: {
        declared: input.cases.length,
        required: requiredCount,
        passed,
        optional_failed: optionalFailed,
      },
      functions: {
        declared: functions.length,
        exercised: exercisedFunctions.size,
        names: [...exercisedFunctions].sort(),
      },
      effects: {
        declared: declaredPairs.size,
        exercised: exercisedPairs.size,
        untested: untestedIds.length,
        exercised_ids: exercisedIds.map((pair) => pair.replace("\u0000", ":")),
        untested_ids: untestedIds.map((pair) => pair.replace("\u0000", ":")),
      },
    },
  };
}
