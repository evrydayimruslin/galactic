import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  type ComputePrivilegedCredential,
  computePrivilegedCredentialsReady,
  isComputeCredentialIsolated,
  isComputeOperatorTokenUsable,
} from "./compute-credential-isolation.ts";

const NAMES: ComputePrivilegedCredential[] = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "COMPUTE_EMERGENCY_STOP_TOKEN",
  "COMPUTE_CERTIFICATION_TOKEN",
  "COMPUTE_JOB_TOKEN_PEPPER",
];

Deno.test("Compute privileged credentials are isolated pairwise", () => {
  const isolated = Object.fromEntries(
    NAMES.map((name, index) => [name, `${name}-${index}-0123456789abcdef`]),
  );
  for (const name of NAMES) {
    assertEquals(isComputeCredentialIsolated(isolated, name), true);
  }
  assertEquals(computePrivilegedCredentialsReady(isolated), {
    configured: true,
    isolated: true,
  });

  for (let left = 0; left < NAMES.length; left += 1) {
    for (let right = left + 1; right < NAMES.length; right += 1) {
      const collision = {
        ...isolated,
        [NAMES[right]]: isolated[NAMES[left]],
      };
      assertEquals(isComputeCredentialIsolated(collision, NAMES[left]), false);
      assertEquals(isComputeCredentialIsolated(collision, NAMES[right]), false);
      assertEquals(
        computePrivilegedCredentialsReady(collision).isolated,
        false,
      );
    }
  }
});

Deno.test("unset credentials do not collide", () => {
  for (const name of NAMES) {
    assertEquals(isComputeCredentialIsolated({}, name), true);
  }
  assertEquals(computePrivilegedCredentialsReady({}), {
    configured: false,
    isolated: true,
  });
});

Deno.test("operator token usability matches the authenticated bearer lanes", () => {
  assertEquals(isComputeOperatorTokenUsable("a".repeat(32)), true);
  assertEquals(isComputeOperatorTokenUsable("a".repeat(512)), true);
  for (
    const value of [
      undefined,
      "a".repeat(31),
      "a".repeat(513),
      " ".repeat(32),
      `a${"!".repeat(31)}`,
    ]
  ) {
    assertEquals(isComputeOperatorTokenUsable(value), false);
  }
});
