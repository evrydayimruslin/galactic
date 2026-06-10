// Cross-Agent function grant contracts (Phase 4a / P5).
//
// A grant authorizes: "for user U, caller Agent A (optionally only while its
// function G runs) may call function F on target Agent B." It is the
// authoritative permission for cross-Agent calls; developer manifest `imports`
// only PREPOPULATE these as hints. See docs/LAUNCH_PIVOT_DECISIONS.md.

export const AGENT_GRANT_MODES = ["call", "subscribe"] as const;
export type AgentGrantMode = typeof AGENT_GRANT_MODES[number];

export const AGENT_GRANT_STATUSES = ["active", "pending", "revoked"] as const;
export type AgentGrantStatus = typeof AGENT_GRANT_STATUSES[number];

export const AGENT_GRANT_ORIGINS = [
  "user",
  "agent",
  "developer_hint",
  "auto_request",
] as const;
export type AgentGrantOrigin = typeof AGENT_GRANT_ORIGINS[number];

// Default monthly cap applied to a freshly approved grant when the creator
// doesn't set one. Raisable in one click; protects blast radius by default.
export const DEFAULT_GRANT_MONTHLY_CAP_CREDITS = 5000;

// Hop ceiling for a cross-Agent call chain (A -> B -> C ...). Each
// server-side mint increments the verified hop count; exceeding this is denied.
export const MAX_AGENT_CALL_HOP_DEPTH = 8;

export interface AgentFunctionGrant {
  id: string;
  userId: string;
  callerAppId: string;
  callerFunction: string | null;
  slot: string | null;
  targetAppId: string;
  targetFunction: string;
  mode: AgentGrantMode;
  status: AgentGrantStatus;
  monthlyCapCredits: number | null;
  spentCreditsPeriod: number;
  periodStart: string;
  constraints: Record<string, unknown>;
  createdBy: AgentGrantOrigin;
  createdAt: string;
  updatedAt: string;
}

// Result of resolving a runtime cross-Agent call against the grant store.
export interface AgentGrantResolution {
  allowed: boolean;
  grant: AgentFunctionGrant | null;
  // Why it was denied (drives the structured error + pending-request inbox).
  reason?:
    | "no_grant"
    | "revoked"
    | "pending"
    | "cap_exceeded"
    | "target_access_lost";
  // A pending request was created/exists for this (caller, target, fn).
  pendingRequestId?: string | null;
}

// Slot binding resolved for the sandbox: logical port -> concrete target.
export interface AgentSlotBinding {
  slot: string;
  targetAppId: string;
  functions: string[];
}

// Input to create a grant (user- or agent-authored). The safety invariant is
// validated server-side: the user must be able to call targetFunction itself.
export interface AgentGrantCreateRequest {
  callerAppId: string;
  targetAppId: string;
  targetFunction: string;
  callerFunction?: string | null;
  slot?: string | null;
  monthlyCapCredits?: number | null;
  constraints?: Record<string, unknown>;
}

export interface AgentGrantSummary {
  id: string;
  callerApp: { id: string; slug: string | null; name: string | null };
  targetApp: { id: string; slug: string | null; name: string | null };
  callerFunction: string | null;
  slot: string | null;
  targetFunction: string;
  mode: AgentGrantMode;
  status: AgentGrantStatus;
  monthlyCapCredits: number | null;
  spentCreditsPeriod: number;
  periodStart: string;
  createdBy: AgentGrantOrigin;
  updatedAt: string;
}

export interface AgentGrantListResponse {
  grants: AgentGrantSummary[];
  generatedAt: string;
}

// Approve a pending request (pending -> active), optionally setting a cap.
export interface AgentGrantApproveRequest {
  monthlyCapCredits?: number | null;
}

export interface AgentGrantUpdateRequest {
  // null = explicitly uncapped.
  monthlyCapCredits?: number | null;
  status?: "active" | "revoked";
}

// A developer-declared slot (manifest `imports`) shown in the wiring UI, with
// its current binding (if the user has wired it) surfaced inline.
export interface AgentImportSlot {
  name: string;
  description: string | null;
  signature: string | null;
  expectedFunctions: string[];
  // The active grant bound to this slot, if any.
  binding: AgentGrantSummary | null;
}

// An Agent the user could bind a slot to (owned, installed, or accessible),
// with the functions eligible to fill it.
export interface AgentWiringTarget {
  app: { id: string; slug: string | null; name: string | null };
  relationship: "owned" | "installed" | "accessible";
  visibility: string;
  functions: { name: string; description: string | null }[];
}

// Egress-trust signal shown at grant time: what the caller Agent can do with
// the data it receives. The operator owns the trust decision (surface + warn,
// not block — locked decision 4).
export interface AgentCallerTrustSummary {
  app: { id: string; slug: string | null; name: string | null };
  visibility: string;
  ownedByUser: boolean;
  // Declared runtime permissions implying outbound data egress.
  hasNetworkEgress: boolean;
  declaredPermissions: string[];
  codeFingerprint: string | null;
}

// The full wiring view for one Agent: its declared slots (+ bindings), the
// raw grants it holds (outbound), and the grants pointing at it (inbound),
// plus pending requests awaiting approval.
export interface AgentWiringView {
  app: { id: string; slug: string | null; name: string | null };
  // Outbound: slots this Agent declares and the user can bind.
  slots: AgentImportSlot[];
  // Outbound: active raw grants (no slot) this Agent holds.
  outboundGrants: AgentGrantSummary[];
  // Inbound: active grants letting OTHER Agents call this one.
  inboundGrants: AgentGrantSummary[];
  // Pending requests (default-deny inbox) awaiting the user's approval.
  pendingRequests: AgentGrantSummary[];
  generatedAt: string;
}

// Signed caller-context claims (HMAC; minted server-side, verified at the
// per-Agent MCP chokepoint). NOT signed with WORKER_SECRET — that secret is
// exposed inside the sandbox and could be read by app code.
export interface AgentCallerContextClaims {
  v: 1;
  // The Agent making the call.
  callerAppId: string;
  // The user the call runs on behalf of.
  userId: string;
  // The caller's executing function at mint time (for caller_function grants).
  callerFunction: string | null;
  // Cross-Agent call depth; incremented per server-side mint, capped.
  hop: number;
  issuedAt: number;
  expiresAt: number;
  jti: string;
}

export const AGENT_CALLER_CONTEXT_HEADER = "X-Ultralight-Caller";
