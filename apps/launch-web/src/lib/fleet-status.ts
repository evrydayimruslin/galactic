import type { LaunchFleetAgentSummary } from "../../../../shared/contracts/launch.ts";

export interface FleetStatusPresentation {
  label: string;
  showLiveSignal: boolean;
  waking: boolean;
}

export function fleetAgentAttentionCount(
  item: LaunchFleetAgentSummary,
): number {
  return item.attentionCount ?? item.unreadAlertCount;
}

export function isFleetAgentWorkingOrReady(
  item: LaunchFleetAgentSummary,
): boolean {
  if (item.workingReadiness) return item.workingReadiness.working;
  return item.state === "active" &&
    (item.health === "healthy" || item.health === "waiting");
}

function formatCountdown(iso: string, now: number): string {
  const seconds = Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 1000));
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h${minutes ? ` ${minutes}m` : ""}`;
  }
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

export function fleetStatusPresentation(
  item: LaunchFleetAgentSummary,
  now: number,
): FleetStatusPresentation {
  const nextWakeTime = item.nextWakeAt ? new Date(item.nextWakeAt).getTime() : Number.NaN;
  const waking = Number.isFinite(nextWakeTime) && nextWakeTime <= now && nextWakeTime > now - 10_000;
  const scheduled = Number.isFinite(nextWakeTime) && nextWakeTime > now;
  const operating = item.operatingSummary;

  if (operating) {
    return {
      label: operating.mode === "scheduled" && item.nextWakeAt
        ? `Next run in ${formatCountdown(item.nextWakeAt, now)}`
        : operating.label,
      showLiveSignal: operating.readiness.working,
      waking: operating.mode === "running" || operating.mode === "queued" ||
        waking,
    };
  }

  if (item.state === "paused" || item.health === "paused") {
    return { label: "Paused", showLiveSignal: false, waking: false };
  }
  if (item.state === "error" || item.health === "error") {
    return { label: "Needs attention", showLiveSignal: false, waking: false };
  }
  if (item.state === "unconfigured") {
    return { label: "Setup required", showLiveSignal: false, waking: false };
  }
  if (item.health === "waiting") {
    const eligibleAt = item.capacity?.nextEligibleAt;
    const label = eligibleAt
      ? `Waiting until ${new Date(eligibleAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
      : "Waiting for capacity";
    return { label, showLiveSignal: false, waking: false };
  }
  if (waking) {
    return { label: "Working now", showLiveSignal: true, waking: true };
  }
  if (scheduled && item.nextWakeAt) {
    return {
      label: `Next run in ${formatCountdown(item.nextWakeAt, now)}`,
      showLiveSignal: true,
      waking: false,
    };
  }
  if (item.activeRoutineCount > 0) {
    return { label: "Waiting for next event", showLiveSignal: true, waking: false };
  }
  return { label: "Standing by", showLiveSignal: true, waking: false };
}
