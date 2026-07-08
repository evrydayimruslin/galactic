// RPC Runs Binding for Dynamic Workers — the flight-recorder read-back.
//
// Lets an agent that opted in (manifest flight_recorder: true) review its OWN
// recent routine runs — status, cost, summary, and the recorded steps
// (cross-agent call contributions + captured galactic.ai() exchanges) — for
// the CURRENT user. The (appId, userId) scope is frozen into the binding
// props host-side; sandbox code cannot name another app or user. This is what
// lets a scheduled agent assess "what did I do on recent wakes, did it work"
// from platform-recorded truth instead of only its own self-authored journal.

import { WorkerEntrypoint } from "cloudflare:workers";
import { assertExecutionContext } from "../../services/execution-context-registry.ts";
import {
  fetchRecentRunsForApp,
  type RecentRun,
} from "../../services/routine-recent-runs.ts";

interface RunsBindingProps {
  appId: string;
  userId: string;
  // Set for bindings loaded into a REUSABLE isolate (loader.get): every public
  // method then refuses to run without a resolvable per-call context handle.
  requireExecCtx?: boolean;
}

export class RunsBinding
  extends WorkerEntrypoint<unknown, RunsBindingProps> {
  async recent(
    limit?: number,
    execCtxHandle?: string,
  ): Promise<{ runs: RecentRun[] }> {
    assertExecutionContext(execCtxHandle, this.ctx.props.requireExecCtx);
    return await fetchRecentRunsForApp(
      this.ctx.props.appId,
      this.ctx.props.userId,
      limit,
    );
  }
}
