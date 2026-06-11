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
  // Pub/sub selector (mode='subscribe'): the topic the emitter (callerAppId)
  // publishes that delivers to targetFunction. Null for call grants.
  topic: string | null;
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
  // mode='subscribe' makes this a pub/sub subscription: callerAppId is the
  // EMITTER, targetApp/targetFunction is the SUBSCRIBER + handler, topic is
  // required. Defaults to 'call'.
  mode?: AgentGrantMode;
  topic?: string | null;
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
  topic: string | null;
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
  // Topics this Agent declares it emits (manifest `emits`). When building a
  // subscription, the user picks one of these as the trigger.
  emits: string[];
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
  // Outbound: active raw CALL grants (no slot, mode='call') this Agent holds.
  outboundGrants: AgentGrantSummary[];
  // Inbound: active CALL grants letting OTHER Agents call this one.
  inboundGrants: AgentGrantSummary[];
  // Topics this Agent declares it emits (manifest `emits`).
  emits: string[];
  // Inbound subscribe grants: events from OTHER Agents that trigger a function
  // on this one. The user wired each (caller=emitter, target=this, topic).
  subscriptions: AgentGrantSummary[];
  // Outbound subscribe grants: this Agent's emitted events that trigger a
  // function on another (caller=this, target=subscriber, topic).
  publications: AgentGrantSummary[];
  // Pending requests (default-deny inbox) awaiting the user's approval.
  pendingRequests: AgentGrantSummary[];
  // Egress-trust for each DISTINCT caller Agent appearing in pendingRequests /
  // inboundGrants, keyed by caller app id. The inbox must show the actual
  // caller's trust (it receives the data), not the page Agent's.
  callerTrustByApp: Record<string, AgentCallerTrustSummary>;
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
  // 'subscribe' marks an event-delivery invocation (the chokepoint resolves a
  // subscribe grant for callerApp=emitter + topic instead of a call grant).
  mode?: AgentGrantMode;
  topic?: string;
  issuedAt: number;
  expiresAt: number;
  jti: string;
}

export const AGENT_CALLER_CONTEXT_HEADER = "X-Ultralight-Caller";

// Max events a single emit fans out to (subscriber count) — bounds amplification.
export const MAX_EVENT_FANOUT = 100;
// Max dispatch attempts before an event/delivery is marked failed.
export const MAX_EVENT_DELIVERY_ATTEMPTS = 5;

export type AgentEventStatus = "pending" | "delivering" | "delivered" | "failed";

export interface AgentEvent {
  id: string;
  userId: string;
  emitterAppId: string;
  topic: string;
  payload: Record<string, unknown>;
  status: AgentEventStatus;
  attempts: number;
  emitHop: number;
  createdAt: string;
  dispatchedAt: string | null;
}

export type AgentEventDeliveryStatus = "pending" | "delivered" | "failed" | "denied";

export interface AgentEventDelivery {
  id: string;
  eventId: string;
  grantId: string;
  subscriberAppId: string;
  targetFunction: string;
  status: AgentEventDeliveryStatus;
  attempts: number;
  receiptId: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface AgentEmitRequest {
  topic: string;
  payload?: Record<string, unknown>;
}
