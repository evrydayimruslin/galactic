import { matchesWorkflowRunName } from "./workflow-run-name.mjs";

export function pickLatestWorkflowRun({ runs, spec, releaseTag }) {
  return runs
    .filter((run) => matchesWorkflowRunName(run.name, spec.name))
    .filter((run) => spec.allowedEvents.includes(run.event))
    // Production evidence must be the tag-push run. A successful manual
    // staging deploy on the same commit must never satisfy this gate.
    .filter((run) =>
      spec.category !== "production" || run.head_branch === releaseTag
    )
    .sort((left, right) => {
      const leftAttempt = Number(left.run_attempt || 0);
      const rightAttempt = Number(right.run_attempt || 0);
      if (rightAttempt !== leftAttempt) {
        return rightAttempt - leftAttempt;
      }
      return Number(right.id || 0) - Number(left.id || 0);
    })[0] || null;
}
