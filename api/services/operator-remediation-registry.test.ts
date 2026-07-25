// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { LaunchOperatorRemediation } from "../../shared/contracts/launch.ts";
import {
  assertRegisteredOperatorRemediation,
  OPERATOR_REMEDIATION_REGISTRY,
  OperatorRemediationRegistryError,
} from "./operator-remediation-registry.ts";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

function configureSecret(): LaunchOperatorRemediation {
  return {
    id: `agent:${AGENT_ID}:requirement:secret:remediation:configure_secret`,
    key: "configure_secret",
    label: "Add API key",
    description: "The value is write-only.",
    presentation: "inline",
    requiredAuthority: "account_session",
    sideEffect: "configuration_write",
    target: {
      kind: "agent_setting",
      agentId: AGENT_ID,
      settingKey: "OPENAI_API_KEY",
      settingScope: "agent",
    },
  };
}

Deno.test("operator remediation registry covers the closed remediation vocabulary", () => {
  assertEquals(Object.keys(OPERATOR_REMEDIATION_REGISTRY).sort(), [
    "adjust_capacity",
    "approve_capability",
    "approve_grant",
    "configure_provider",
    "configure_routine",
    "configure_secret",
    "configure_setting",
    "enable_routine",
    "inspect_run",
    "open_logs",
    "open_routine",
    "resume_routine",
    "review_access",
    "review_release",
    "run_once",
    "verify_connection",
  ]);
  assertRegisteredOperatorRemediation(configureSecret());
});

Deno.test("operator remediation registry rejects authority and side-effect widening", () => {
  const authority = configureSecret() as unknown as Record<string, unknown>;
  authority.requiredAuthority = "agent_operate";
  const authorityError = assertThrows(
    () =>
      assertRegisteredOperatorRemediation(
        authority as unknown as LaunchOperatorRemediation,
      ),
    OperatorRemediationRegistryError,
  );
  assertEquals(
    authorityError.message,
    "Remediation configure_secret attempts to widen registry policy.",
  );

  const sideEffect = configureSecret() as unknown as Record<string, unknown>;
  sideEffect.sideEffect = "routine_execution";
  assertThrows(
    () =>
      assertRegisteredOperatorRemediation(
        sideEffect as unknown as LaunchOperatorRemediation,
      ),
    OperatorRemediationRegistryError,
  );
});

Deno.test("operator remediation registry rejects arbitrary routes and target fields", () => {
  const remediation = configureSecret();
  const target = remediation.target as unknown as Record<string, unknown>;
  target.url = "https://attacker.example/approve";
  const error = assertThrows(
    () => assertRegisteredOperatorRemediation(remediation),
    OperatorRemediationRegistryError,
  );
  assertEquals(
    error.message,
    "Agent setting target contains unsupported fields.",
  );
});
