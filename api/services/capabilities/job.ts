// job capability — surface-neutral async-job polling.
//
// Extracted from the inline `case "ul.job"` block in platform-mcp so the MCP
// dispatch, the CLI, and the website all resolve to ONE implementation. getJob
// scopes by user_id internally, so ownership is enforced there — this needs only
// the caller's userId.

import { CapabilityError } from "../../../shared/contracts/capabilities.ts";
import { getJob } from "../async-jobs.ts";

/** Poll a durable async job and shape the status/result envelope. */
export async function pollJob(userId: string, jobId: string): Promise<unknown> {
  if (!jobId) throw new CapabilityError("invalid_input", "job_id is required");

  const job = await getJob(jobId, userId);
  if (!job) throw new CapabilityError("not_found", `Job ${jobId} not found`);

  if (job.status === "queued") {
    return {
      job_id: jobId,
      status: "queued",
      message: "Waiting to be picked up. Poll again in a few seconds.",
    };
  }
  if (job.status === "running") {
    const elapsed = Date.now() - new Date(job.created_at).getTime();
    return {
      job_id: jobId,
      status: "running",
      elapsed_seconds: Math.round(elapsed / 1000),
      message: "Still running. Poll again in a few seconds.",
    };
  }
  if (job.status === "completed") {
    return {
      job_id: jobId,
      status: "completed",
      duration_ms: job.duration_ms,
      result: job.result,
      logs: job.logs,
      ai_cost_light: job.ai_cost_light,
      // Links this job to its execution receipt and AI-spend ledger.
      execution_id: job.execution_id,
    };
  }
  return {
    job_id: jobId,
    status: "failed",
    duration_ms: job.duration_ms,
    error: job.error,
    // AI calls that completed before the failure were still billed.
    ai_cost_light: job.ai_cost_light,
    logs: job.logs,
    execution_id: job.execution_id,
  };
}
