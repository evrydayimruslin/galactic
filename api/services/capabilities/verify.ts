// verify capability — surface-neutral implementation.
//
// Extracted from platform-mcp's executeVerify so the MCP dispatch, the CLI, and
// the website REST route all resolve to ONE implementation (the whole point of
// the capability registry). Throws CapabilityError, which each surface maps to
// its own error shape.

import { CapabilityError } from "../../../shared/contracts/capabilities.ts";
import type { App } from "../../../shared/types/index.ts";
import { createAppsService } from "../apps.ts";
import {
  buildVerificationVerdict,
  recordVerification,
} from "../code-verification.ts";

/**
 * Platform-signed integrity verdict for an Agent, from the caller's vantage:
 * does the executing bundle match its signed attestation, is the published
 * signature valid, and (for open code) does every source file match the signed
 * hashes. Always reflects the LIVE deployed version.
 *
 * A private Agent is reported as not-found to any non-owner (never leak its
 * existence). Verification is a read; the only side effect is best-effort
 * ranking telemetry, skipped for suspended Agents.
 */
export async function verifyAppIntegrity(
  userId: string,
  appIdOrSlug: string,
): Promise<unknown> {
  if (!appIdOrSlug) {
    throw new CapabilityError("invalid_input", "app_id is required");
  }

  const appsService = createAppsService();
  let app: App | null = await appsService.findById(appIdOrSlug);
  if (!app) app = await appsService.findBySlug(userId, appIdOrSlug);
  if (!app || (app.owner_id !== userId && app.visibility === "private")) {
    throw new CapabilityError("not_found", `App not found: ${appIdOrSlug}`);
  }

  const verdict = await buildVerificationVerdict(app);
  if (!app.hosting_suspended) {
    await recordVerification({
      appId: app.id,
      userId,
      version: verdict.version,
      verdict,
    });
  }
  return verdict;
}
