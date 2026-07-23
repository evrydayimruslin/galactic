export function moveFleetAgentBefore(
  agentIds: readonly string[],
  sourceAgentId: string,
  targetAgentId: string,
): string[] | null {
  if (sourceAgentId === targetAgentId) return null;
  const sourceIndex = agentIds.indexOf(sourceAgentId);
  const targetIndex = agentIds.indexOf(targetAgentId);
  if (sourceIndex < 0 || targetIndex < 0) return null;

  const next = [...agentIds];
  next.splice(sourceIndex, 1);
  const adjustedTargetIndex = next.indexOf(targetAgentId);
  if (adjustedTargetIndex < 0) return null;
  next.splice(adjustedTargetIndex, 0, sourceAgentId);
  return next.every((agentId, index) => agentId === agentIds[index])
    ? null
    : next;
}

export function moveFleetAgentByOffset(
  agentIds: readonly string[],
  agentId: string,
  offset: -1 | 1,
): string[] | null {
  const sourceIndex = agentIds.indexOf(agentId);
  const targetIndex = sourceIndex + offset;
  if (
    sourceIndex < 0 ||
    targetIndex < 0 ||
    targetIndex >= agentIds.length
  ) {
    return null;
  }
  const next = [...agentIds];
  [next[sourceIndex], next[targetIndex]] = [
    next[targetIndex],
    next[sourceIndex],
  ];
  return next;
}
