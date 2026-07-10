// RPC Notify Binding for Dynamic Workers — agent-writable owner notifications.
//
// Lets an agent that declared the `notify:owner` manifest permission write one
// notification to the CURRENT user's in-product inbox (the launch-web bell).
// Self-notification only: the (appId, userId) identity is frozen into the
// binding props host-side — sandbox code cannot name another app or user. The
// kind is fixed to 'agent_report', dedupe keys are namespaced per app, and
// writes are rate-capped per (user, app, UTC day). See agent-notify.ts for the
// containment rationale.

import { WorkerEntrypoint } from "cloudflare:workers";
import { assertExecutionContext } from "../../services/execution-context-registry.ts";
import {
  type AgentNotifyInput,
  type AgentNotifyResult,
  notifyOwnerFromAgent,
} from "../../services/agent-notify.ts";

interface NotifyBindingProps {
  appId: string;
  userId: string;
  // Set for bindings loaded into a REUSABLE isolate (loader.get): every public
  // method then refuses to run without a resolvable per-call context handle.
  requireExecCtx?: boolean;
}

export class NotifyBinding
  extends WorkerEntrypoint<unknown, NotifyBindingProps> {
  async notifyOwner(
    input: AgentNotifyInput,
    execCtxHandle?: string,
  ): Promise<AgentNotifyResult> {
    assertExecutionContext(execCtxHandle, this.ctx.props.requireExecCtx);
    return await notifyOwnerFromAgent(
      this.ctx.props.appId,
      this.ctx.props.userId,
      input ?? {},
    );
  }
}
