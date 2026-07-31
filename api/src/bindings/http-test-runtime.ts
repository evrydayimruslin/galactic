// Host-side exact HTTP fixture execution for gx.test.
//
// This module is intentionally pure Fetch API code: it owns no outbound
// primitive and can only return a canned Response from a normalized fixture.

import {
  findHttpTestFixtureMatch,
  type HttpTestFixtureConfig,
  httpTestFixtureResponseSizeBytes,
  materializeHttpTestFixtureResponse,
} from "../../services/http-test-fixtures.ts";
import {
  blockUlTestEffect,
  UL_TEST_BLOCKED_EFFECTS,
  UL_TEST_OBSERVED_EFFECTS,
  type UlTestEffectRecorder,
  type UlTestObservedEffectRecorder,
} from "../../services/ul-test-runtime.ts";
import { evaluateOutbound, hostInAllowlist } from "./outbound-policy.ts";

interface HttpTestRuntimeRecorder
  extends UlTestEffectRecorder, UlTestObservedEffectRecorder {
  beginHttpFixtureAttempt(): void | Promise<void>;
  reserveHttpFixtureExchangeBytes(
    requestBytes: number,
    responseBytes: number,
  ): void | Promise<void>;
}

interface ResolveHttpTestRuntimeResponseInput {
  kind: "raw" | "credential";
  request: Request;
  fixtures: HttpTestFixtureConfig;
  allowedDestinations: string[];
  recorder: HttpTestRuntimeRecorder;
  credentialKey?: string;
  credentialDestinations?: Record<string, string>;
}

/**
 * Resolve one intercepted call entirely inside the padded room.
 *
 * A policy failure, malformed request, missing fixture, body mismatch, or
 * materialization error all take the same fail-closed path. That path latches
 * the fixed effect class before throwing and never includes URL, query,
 * headers, bodies, or credential names in its error.
 */
export async function resolveHttpTestRuntimeResponse(
  input: ResolveHttpTestRuntimeResponseInput,
): Promise<Response> {
  const observedEffect = input.kind === "credential"
    ? UL_TEST_OBSERVED_EFFECTS.credentialHttp
    : UL_TEST_OBSERVED_EFFECTS.networkHttp;
  const blockedEffect = input.kind === "credential"
    ? UL_TEST_BLOCKED_EFFECTS.credentialedHttp
    : UL_TEST_BLOCKED_EFFECTS.outboundHttp;

  await input.recorder.recordObservedEffect(observedEffect);
  try {
    // Admit every intercepted attempt before URL policy or body inspection.
    // This keeps caught misses and concurrent matching bodies inside the same
    // invocation-owned limit rather than the generic sandbox subrequest cap.
    await input.recorder.beginHttpFixtureAttempt();
  } catch {
    return await blockUlTestEffect(input.recorder, blockedEffect);
  }

  let match = null;
  try {
    const target = new URL(input.request.url);
    const outbound = evaluateOutbound(
      target.toString(),
      input.allowedDestinations,
    );
    let credentialAllowed = true;
    if (input.kind === "credential") {
      const destination = input.credentialKey
        ? input.credentialDestinations?.[input.credentialKey]
        : undefined;
      credentialAllowed = target.protocol === "https:" &&
        typeof destination === "string" &&
        hostInAllowlist(
          target.hostname,
          target.port,
          [destination],
          target.protocol,
        );
    }
    if (outbound.allowed && credentialAllowed) {
      match = await findHttpTestFixtureMatch(input.fixtures, {
        kind: input.kind,
        request: input.request,
        ...(input.credentialKey ? { credentialKey: input.credentialKey } : {}),
      });
    }
  } catch {
    match = null;
  }

  // Exchange bytes describe a fixture-backed response and are committed only
  // after the request has completely matched. Misses are still bounded by the
  // pre-inspection attempt cap and the per-request body cap above.
  if (match?.fixture) {
    try {
      await input.recorder.reserveHttpFixtureExchangeBytes(
        match.requestBodyBytes,
        httpTestFixtureResponseSizeBytes(match.fixture),
      );
    } catch {
      return await blockUlTestEffect(input.recorder, blockedEffect);
    }
  }

  if (!match?.fixture) {
    return await blockUlTestEffect(input.recorder, blockedEffect);
  }
  try {
    return materializeHttpTestFixtureResponse(match.fixture);
  } catch {
    return await blockUlTestEffect(input.recorder, blockedEffect);
  }
}
