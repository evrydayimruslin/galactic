// flag capability — surface-neutral proof-of-use outcome report.
//
// Extracted from platform-mcp's executeFlag. recordCallFlag validates the
// receipt server-side (real, recent, made by this user, not on the user's own
// Agent), so this needs only the caller's userId + whether the session is
// provisional (which sets the Sybil-resistant weight).

import { CapabilityError } from "../../../shared/contracts/capabilities.ts";
import { type FlagStatus, recordCallFlag } from "../call-flags.ts";

/** Record a positive/negative outcome for a prior call's receipt. */
export async function recordFlag(
  userId: string,
  provisional: boolean,
  args: Record<string, unknown>,
): Promise<unknown> {
  const receiptId = args.receipt_id as string;
  const status = args.status as string;
  if (!receiptId) {
    throw new CapabilityError("invalid_input", "receipt_id is required");
  }
  if (status !== "positive" && status !== "negative") {
    throw new CapabilityError(
      "invalid_input",
      "status must be 'positive' or 'negative'",
    );
  }
  const note = typeof args.note === "string" ? args.note : undefined;
  // Tier weight: a provisional (anonymous) caller's flag weighs less than a full
  // account's, so distinct-identity Sybil farming costs more.
  const weight = provisional ? 0.25 : 1;

  const flag = await recordCallFlag({
    receiptId,
    userId,
    status: status as FlagStatus,
    note,
    weight,
  });
  // Soft-fail an invalid/stale/self receipt — don't error the agent's flow over a
  // feedback call; just report why it didn't count.
  if (!flag.ok) return { ok: false, reason: flag.reason };
  return {
    ok: true,
    app_id: flag.app_id,
    status: flag.status,
    message: "Outcome recorded — thanks for the feedback.",
  };
}
