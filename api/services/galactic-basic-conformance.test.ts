import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  evaluateGalacticBasicConformance,
  GalacticBasicConformanceError,
} from "./galactic-basic-conformance.ts";

const RELEASE_DIGEST = "a".repeat(64);

Deno.test("basic conformance passes required cases and reports honest pair coverage", () => {
  const report = evaluateGalacticBasicConformance({
    releaseDigest: RELEASE_DIGEST,
    functions: ["readInbox", "archive"],
    effectsByFunction: {
      readInbox: ["email.imap.read", "inference.generate"],
      archive: ["storage.write"],
    },
    cases: [
      { id: "reads-message", function: "readInbox", required: true },
      { id: "archive-optional", function: "archive", required: false },
    ],
    observations: [
      {
        id: "reads-message",
        function: "readInbox",
        required: true,
        invoked: true,
        success: true,
        observedEffects: ["inference.generate"],
      },
      {
        id: "archive-optional",
        function: "archive",
        required: false,
        invoked: true,
        success: false,
        observedEffects: [],
        errorCode: "OPTIONAL_FIXTURE_MISSING",
      },
    ],
  });

  assertEquals(report.passed, true);
  assertEquals(report.coverage.cases, {
    declared: 2,
    required: 1,
    passed: 1,
    optional_failed: 1,
  });
  assertEquals(report.coverage.functions, {
    declared: 2,
    exercised: 2,
    names: ["archive", "readInbox"],
  });
  assertEquals(report.coverage.effects, {
    declared: 3,
    exercised: 1,
    untested: 2,
    exercised_ids: ["readInbox:inference.generate"],
    untested_ids: [
      "archive:storage.write",
      "readInbox:email.imap.read",
    ],
  });
  assertEquals(report.cases[1].status, "optional_failed");
});

Deno.test("basic conformance fails on undeclared authority even when runtime succeeds", () => {
  const report = evaluateGalacticBasicConformance({
    releaseDigest: RELEASE_DIGEST,
    functions: ["triage"],
    effectsByFunction: { triage: ["email.imap.read"] },
    cases: [{ id: "triage", function: "triage", required: true }],
    observations: [{
      id: "triage",
      function: "triage",
      required: true,
      invoked: true,
      success: true,
      observedEffects: ["email.smtp.send"],
    }],
  });

  assertEquals(report.passed, false);
  assertEquals(report.cases[0].undeclared_effects, ["email.smtp.send"]);
});

Deno.test("basic conformance treats a contained external attempt as disqualifying", () => {
  const report = evaluateGalacticBasicConformance({
    releaseDigest: RELEASE_DIGEST,
    functions: ["inspect", "triage"],
    effectsByFunction: {
      inspect: [],
      triage: ["email.imap.read"],
    },
    cases: [
      { id: "inspect", function: "inspect", required: true },
      { id: "triage", function: "triage", required: false },
    ],
    observations: [
      {
        id: "inspect",
        function: "inspect",
        required: true,
        invoked: true,
        success: true,
        observedEffects: [],
      },
      {
        id: "triage",
        function: "triage",
        required: false,
        invoked: true,
        success: false,
        observedEffects: ["email.imap.read"],
        blockedExternalEffect: true,
        errorCode: "GX_TEST_EFFECT_BLOCKED",
      },
    ],
  });

  assertEquals(report.passed, false);
  assertEquals(report.cases[1].blocked_external_effect, true);
});

Deno.test("basic conformance does not count a sandbox dispatch as function coverage", () => {
  const report = evaluateGalacticBasicConformance({
    releaseDigest: RELEASE_DIGEST,
    functions: ["run"],
    effectsByFunction: { run: [] },
    cases: [{ id: "run", function: "run", required: true }],
    observations: [{
      id: "run",
      function: "run",
      required: true,
      invoked: false,
      success: true,
      observedEffects: [],
    }],
  });

  assertEquals(report.passed, false);
  assertEquals(report.coverage.functions, {
    declared: 1,
    exercised: 0,
    names: [],
  });
  assertEquals(report.cases[0].status, "failed");
});

Deno.test("basic conformance fails closed on unknown runtime effects or missing cases", () => {
  assertThrows(
    () =>
      evaluateGalacticBasicConformance({
        releaseDigest: RELEASE_DIGEST,
        functions: ["run"],
        effectsByFunction: { run: [] },
        cases: [{ id: "run", function: "run", required: true }],
        observations: [{
          id: "run",
          function: "run",
          required: true,
          invoked: true,
          success: true,
          observedEffects: ["tenant.secret.effect"],
        }],
      }),
    GalacticBasicConformanceError,
    "unknown observed effect",
  );

  assertThrows(
    () =>
      evaluateGalacticBasicConformance({
        releaseDigest: RELEASE_DIGEST,
        functions: ["run"],
        effectsByFunction: { run: [] },
        cases: [{ id: "run", function: "run", required: true }],
        observations: [],
      }),
    GalacticBasicConformanceError,
    "observe every declared case",
  );
});
