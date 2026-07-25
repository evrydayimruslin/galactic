// Interface Demo — reference Agent for the Interfaces convention
// (ultralight-spec/conventions/interfaces.md). Functions are deliberately
// dependency-free (no storage/net permissions) so the demo works on any
// account out of the box.

interface GalacticCompute {
  (request: {
    argv: string[];
    tools: string[];
    profile: "developer-v1";
    mode: "async";
    stdin: string;
    timeout_ms: number;
  }): Promise<unknown>;
  get(runId: string): Promise<unknown>;
}

declare const galactic: { compute: GalacticCompute };

export function get_greeting(args: { name?: string }) {
  const name = (args?.name || "world").toString().slice(0, 64);
  return {
    greeting: `Hello, ${name}!`,
    served_at: new Date().toISOString(),
  };
}

export function roll_dice(args: { count?: number; sides?: number }) {
  const count = Math.min(10, Math.max(1, Math.floor(args?.count ?? 2)));
  const sides = Math.min(100, Math.max(2, Math.floor(args?.sides ?? 6)));
  const rolls = Array.from(
    { length: count },
    () => 1 + Math.floor(Math.random() * sides),
  );
  return {
    rolls,
    total: rolls.reduce((sum, roll) => sum + roll, 0),
    spec: `${count}d${sides}`,
  };
}

const COMPUTE_SMOKE_MARKER_PATTERN =
  /^galactic-compute-release-smoke-v1:[0-9a-f]{40}:[1-9][0-9]{0,19}\n$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Release-only probe for the real Compute admission path. The marker is
 * public release metadata, never a secret, and reaches the body only on stdin.
 */
export async function run_compute_smoke(args: {
  action?: "start" | "status";
  marker?: string;
  run_id?: string;
}) {
  if (args?.action === "status") {
    const runId = String(args.run_id || "").trim();
    if (!UUID_PATTERN.test(runId)) {
      throw new Error("run_id must be a UUID");
    }
    return await galactic.compute.get(runId);
  }
  if (args?.action !== undefined && args.action !== "start") {
    throw new Error("action must be start or status");
  }
  const marker = String(args?.marker || "");
  if (!COMPUTE_SMOKE_MARKER_PATTERN.test(marker)) {
    throw new Error("marker is not canonical release-smoke metadata");
  }
  return await galactic.compute({
    argv: ["cat"],
    tools: ["shell"],
    profile: "developer-v1",
    mode: "async",
    stdin: marker,
    timeout_ms: 30_000,
  });
}
