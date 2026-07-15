export function matchesWorkflowRunName(actualName, workflowName) {
  const actual = String(actualName || "").trim().toLowerCase();
  const expected = String(workflowName || "").trim().toLowerCase();

  if (!actual || !expected) return false;
  return actual === expected || actual.startsWith(`${expected} (`);
}
