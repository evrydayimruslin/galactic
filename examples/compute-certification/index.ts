/**
 * Release-only, least-authority probes for certifying Galactic Compute.
 *
 * This fixture is uploaded as a self-contained Agent. The structural types
 * below intentionally mirror the public Compute wire contract without a
 * runtime import outside this directory. Every executable, URL, script,
 * timeout, tool, mount, and capture path is fixed here; callers can select a
 * reviewed scenario but can never supply a command or network destination.
 */

type ComputeProfile = "developer-v1";
type ComputeTool = "browser" | "shell";
type ComputeExecutionMode = "async" | "sync";

interface ComputeInputArtifact {
  artifact_id: string;
  mount_path: string;
}

interface ComputeArtifact {
  artifact_id: string;
  path: string;
  size_bytes: number;
  sha256: string;
  expires_at: string;
}

interface ComputeRequest {
  argv: [string, ...string[]];
  tools: ComputeTool[];
  profile?: ComputeProfile;
  secrets?: string[];
  mode?: ComputeExecutionMode;
  cwd?: string;
  stdin?: string;
  timeout_ms?: number;
  input_artifacts?: ComputeInputArtifact[];
  capture_paths?: string[];
}

type ComputeRunStatus =
  | "cancelled"
  | "completed"
  | "failed"
  | "queued"
  | "reserving"
  | "running"
  | "settlement_pending"
  | "starting";

interface ComputeRun {
  run_id: string;
  receipt_id: string;
  status: ComputeRunStatus;
  profile: ComputeProfile;
  tools: ComputeTool[];
  created_at: string;
  started_at?: string;
  finished_at?: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  artifacts?: ComputeArtifact[];
  error?: string;
}

interface ComputeSyncResult extends ComputeRun {
  async: false;
  status: "cancelled" | "completed" | "failed" | "settlement_pending";
}

interface ComputeAcceptedResult extends ComputeRun {
  async: true;
  status: "queued" | "reserving" | "running" | "starting";
}

type ComputeResult = ComputeAcceptedResult | ComputeSyncResult;

interface GalacticCompute {
  (request: ComputeRequest): Promise<ComputeResult>;
  get(runId: string): Promise<ComputeRun>;
  cancel(runId: string): Promise<ComputeRun>;
}

declare const galactic: { compute: GalacticCompute };

const SCENARIOS = [
  "sync_toolchain",
  "async_echo",
  "browser_https",
  "artifact_producer",
  "artifact_consumer",
  "exit_23",
  "timeout",
  "cancellable",
  "https_egress_boundaries",
  "raw_tcp_denied",
] as const;

type CertificationScenario = typeof SCENARIOS[number];
type CertificationAction = "cancel" | "start" | "status";

interface CertificationArgs {
  action: CertificationAction;
  scenario?: CertificationScenario;
  marker?: string;
  artifact_id?: string;
  expected_sha256?: string;
  run_id?: string;
}

interface RoutineWake {
  routine_id: string;
  routine_run_id: string;
  trace_id: string | null;
  trigger: "manual" | "scheduled";
  attempt: number;
  scheduled_at: string;
  intent: string | null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMPUTE_SMOKE_MARKER_PATTERN =
  /^galactic-compute-certification-v1:[0-9a-f]{40}:[1-9][0-9]{0,19}\n$/u;
const SCENARIO_SET = new Set<string>(SCENARIOS);

const DETERMINISTIC_ARTIFACT_CONTENT =
  '{"fixture":"galactic-compute-certification","schema_version":1}\n';
const DETERMINISTIC_ARTIFACT_SHA256 =
  "6ad9b8ea5280658dc4b229a2b6180d530c4d3824b541d218266ea6049e8b763b";
const ARTIFACT_INPUT_MOUNT = "input/certification-artifact.bin";
const ARTIFACT_ROUND_TRIP_PATH = "output/certification-artifact.bin";
const ARTIFACT_CONSUMER_REPORT_PATH = "output/artifact-consumer.json";

const TOOLCHAIN_SCRIPT = [
  "const load = require;",
  'const { execFileSync } = load("node:child_process");',
  'const playwrightPath = "/opt/galactic/toolchain/node_modules/" + "playwright";',
  "const { chromium } = load(playwrightPath);",
  'const playwrightVersion = load(playwrightPath + "/package.json").version;',
  'const run = (command, args = []) => execFileSync(command, args, { encoding: "utf8" }).trim();',
  "const observed = {",
  '  python: run("python3", ["--version"]).replace(/^Python /, ""),',
  '  npm: run("npm", ["--version"]),',
  '  deno: run("deno", ["--version"]).split("\\n", 1)[0].replace(/^deno /, "").split(" ", 1)[0],',
  '  galactic_cli: run("galactic", ["--version"]),',
  "  playwright: playwrightVersion,",
  '  chromium: run(chromium.executablePath(), ["--version"]).split(" ").at(-1),',
  "};",
  'const expected = { python: "3.13.14", npm: "12.0.1", deno: "2.9.3", galactic_cli: "2.4.0", playwright: "1.62.0-alpha-2026-07-20", chromium: "152.0.7977.8" };',
  "for (const [name, version] of Object.entries(expected)) {",
  "  if (observed[name] !== version) throw new Error(`Unexpected ${name} ${observed[name]}`);",
  "}",
  'process.stdout.write(JSON.stringify({ schema_version: 1, scenario: "sync_toolchain", verified: true, ...observed }) + "\\n");',
].join("\n");

const ASYNC_ECHO_SCRIPT = [
  "const load = require;",
  'const { createHash } = load("node:crypto");',
  'const { readFileSync } = load("node:fs");',
  'const marker = readFileSync(0, "utf8");',
  'if (!/^galactic-compute-certification-v1:[0-9a-f]{40}:[1-9][0-9]{0,19}\\n$/.test(marker)) throw new Error("Invalid certification marker");',
  'const marker_sha256 = createHash("sha256").update(marker).digest("hex");',
  'process.stdout.write(JSON.stringify({ schema_version: 1, scenario: "async_echo", verified: true, marker_sha256, marker_length: Buffer.byteLength(marker) }) + "\\n");',
].join("\n");

const BROWSER_HTTPS_SCRIPT = [
  "const load = (specifier) => import(specifier);",
  'const { mkdir, writeFile } = await load("node:fs/promises");',
  'const { chromium } = await load("play" + "wright");',
  'const target = "https://example.com/";',
  'await mkdir("output", { recursive: true });',
  "const browser = await chromium.launch({ headless: true });",
  "try {",
  "  const context = await browser.newContext();",
  "  const page = await context.newPage();",
  '  const response = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });',
  '  if (!response || !response.ok()) throw new Error(`HTTPS navigation failed (${response?.status() ?? "no response"})`);',
  "  const final_url = page.url();",
  "  const title = await page.title();",
  '  if (new URL(final_url).protocol !== "https:") throw new Error("Browser left HTTPS");',
  '  if (title !== "Example Domain") throw new Error(`Unexpected page title ${title}`);',
  '  const result = { schema_version: 1, scenario: "browser_https", verified: true, final_url, title, browser_version: browser.version(), tls_verified: true };',
  '  await page.screenshot({ path: "output/browser-https.png", fullPage: true });',
  '  await writeFile("output/browser-https.json", JSON.stringify(result) + "\\n");',
  '  process.stdout.write(JSON.stringify(result) + "\\n");',
  "} finally {",
  "  await browser.close();",
  "}",
].join("\n");

const ARTIFACT_PRODUCER_SCRIPT = [
  "const load = require;",
  'const { createHash } = load("node:crypto");',
  'const { mkdirSync, writeFileSync } = load("node:fs");',
  `const content = ${JSON.stringify(DETERMINISTIC_ARTIFACT_CONTENT)};`,
  `const expected = ${JSON.stringify(DETERMINISTIC_ARTIFACT_SHA256)};`,
  'const artifact_sha256 = createHash("sha256").update(content).digest("hex");',
  'if (artifact_sha256 !== expected) throw new Error("Deterministic artifact digest drifted");',
  'mkdirSync("output", { recursive: true });',
  'writeFileSync("output/certification-artifact.bin", content);',
  'process.stdout.write(JSON.stringify({ schema_version: 1, scenario: "artifact_producer", verified: true, artifact_sha256, artifact_size_bytes: Buffer.byteLength(content) }) + "\\n");',
].join("\n");

const ARTIFACT_CONSUMER_SCRIPT = [
  "const load = require;",
  'const { createHash } = load("node:crypto");',
  'const { copyFileSync, mkdirSync, readFileSync, writeFileSync } = load("node:fs");',
  'const inputPath = "input/certification-artifact.bin";',
  "const expected = process.argv[1];",
  'if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error("Invalid expected digest");',
  "const input = readFileSync(inputPath);",
  'const input_sha256 = createHash("sha256").update(input).digest("hex");',
  'if (input_sha256 !== expected) throw new Error("Input artifact digest mismatch");',
  'mkdirSync("output", { recursive: true });',
  'copyFileSync(inputPath, "output/certification-artifact.bin");',
  'const result = { schema_version: 1, scenario: "artifact_consumer", verified: true, input_sha256, input_size_bytes: input.byteLength };',
  'writeFileSync("output/artifact-consumer.json", JSON.stringify(result) + "\\n");',
  'process.stdout.write(JSON.stringify(result) + "\\n");',
].join("\n");

const EXIT_23_SCRIPT = [
  "set -eu",
  'printf \'%s\\n\' \'{"schema_version":1,"scenario":"exit_23","verified":true,"expected_exit_code":23}\'',
  "exit 23",
].join("\n");

const HTTPS_EGRESS_SCRIPT = [
  "set -eu",
  "public_code=\"$(curl --fail --silent --location --output /dev/null --write-out '%{http_code}' --connect-timeout 10 --max-time 20 https://example.com/)\"",
  'test "$public_code" = "200"',
  "expect_denied() {",
  "  # The pinned Containers deniedHosts contract is HTTP 520.",
  '  denied_code="$(curl --silent --location --output /dev/null --write-out \'%{http_code}\' --connect-timeout 3 --max-time 5 "$1")" || exit 92',
  '  test "$denied_code" = "520" || exit 90',
  "}",
  "expect_denied http://127.0.0.1/",
  "expect_denied http://169.254.169.254/latest/meta-data/",
  "expect_denied https://api.connectgalactic.com/health",
  'printf \'%s\\n\' \'{"schema_version":1,"scenario":"https_egress_boundaries","verified":true,"public_https_ok":true,"private_denied":true,"metadata_denied":true,"control_plane_denied":true}\'',
].join("\n");

const RAW_TCP_SCRIPT = [
  "set -eu",
  "if nc -z -w 5 example.com 443 >/dev/null 2>&1; then",
  "  exit 91",
  "fi",
  'printf \'%s\\n\' \'{"schema_version":1,"scenario":"raw_tcp_denied","verified":true,"raw_tcp_denied":true}\'',
].join("\n");

const POLICY_PROBE_SCRIPT =
  'process.stdout.write(JSON.stringify({ schema_version: 1, scenario: "policy_probe", verified: true, fixed: true }) + "\\n");';

type CertificationPlan =
  | { action: "cancel"; runId: string }
  | { action: "status"; runId: string }
  | {
    action: "start";
    request: ComputeRequest;
    scenario: CertificationScenario;
  };

function inputRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Unsupported argument: ${unexpected.sort()[0]}`);
  }
}

function requiredString(
  value: unknown,
  label: string,
  pattern?: RegExp,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  if (pattern && !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function baseRequest(
  argv: [string, ...string[]],
  mode: ComputeExecutionMode,
  timeoutMs: number,
  tools: ComputeTool[] = ["shell"],
): ComputeRequest {
  return {
    argv,
    tools,
    profile: "developer-v1",
    mode,
    timeout_ms: timeoutMs,
  };
}

function buildScenarioRequest(
  scenario: CertificationScenario,
  input: Record<string, unknown>,
): ComputeRequest {
  switch (scenario) {
    case "sync_toolchain":
      return baseRequest(
        ["node", "-e", TOOLCHAIN_SCRIPT],
        "sync",
        30_000,
        ["browser", "shell"],
      );
    case "async_echo": {
      const marker = requiredString(
        input.marker,
        "marker",
        COMPUTE_SMOKE_MARKER_PATTERN,
      );
      return {
        ...baseRequest(["node", "-e", ASYNC_ECHO_SCRIPT], "async", 30_000),
        stdin: marker,
      };
    }
    case "browser_https":
      return {
        ...baseRequest(
          ["node", "--input-type=module", "-e", BROWSER_HTTPS_SCRIPT],
          "async",
          120_000,
          ["browser", "shell"],
        ),
        capture_paths: [
          "output/browser-https.png",
          "output/browser-https.json",
        ],
      };
    case "artifact_producer":
      return {
        ...baseRequest(
          ["node", "-e", ARTIFACT_PRODUCER_SCRIPT],
          "async",
          30_000,
        ),
        capture_paths: [ARTIFACT_ROUND_TRIP_PATH],
      };
    case "artifact_consumer": {
      const artifactId = requiredString(
        input.artifact_id,
        "artifact_id",
        UUID_PATTERN,
      ).toLowerCase();
      const expectedSha256 = requiredString(
        input.expected_sha256,
        "expected_sha256",
        SHA256_PATTERN,
      );
      return {
        ...baseRequest(
          ["node", "-e", ARTIFACT_CONSUMER_SCRIPT, expectedSha256],
          "async",
          60_000,
        ),
        input_artifacts: [{
          artifact_id: artifactId,
          mount_path: ARTIFACT_INPUT_MOUNT,
        }],
        capture_paths: [
          ARTIFACT_ROUND_TRIP_PATH,
          ARTIFACT_CONSUMER_REPORT_PATH,
        ],
      };
    }
    case "exit_23":
      return baseRequest(["bash", "-lc", EXIT_23_SCRIPT], "sync", 10_000);
    case "timeout":
      return baseRequest(
        ["node", "-e", "setTimeout(() => {}, 30_000);"],
        "async",
        1_000,
      );
    case "cancellable":
      return baseRequest(
        ["node", "-e", "setInterval(() => {}, 1_000);"],
        "async",
        120_000,
      );
    case "https_egress_boundaries":
      return baseRequest(
        ["bash", "-lc", HTTPS_EGRESS_SCRIPT],
        "async",
        60_000,
      );
    case "raw_tcp_denied":
      return baseRequest(["bash", "-lc", RAW_TCP_SCRIPT], "sync", 15_000);
  }
}

function certificationPlan(value: unknown): CertificationPlan {
  const input = inputRecord(value, "Certification arguments");
  const action = requiredString(input.action, "action") as CertificationAction;
  if (action !== "start" && action !== "status" && action !== "cancel") {
    throw new Error("action must be start, status, or cancel");
  }

  if (action === "status" || action === "cancel") {
    assertOnlyKeys(input, ["action", "run_id"]);
    return {
      action,
      runId: requiredString(input.run_id, "run_id", UUID_PATTERN).toLowerCase(),
    };
  }

  assertOnlyKeys(input, [
    "action",
    "scenario",
    "marker",
    "artifact_id",
    "expected_sha256",
  ]);
  const scenario = requiredString(input.scenario, "scenario");
  if (!SCENARIO_SET.has(scenario)) {
    throw new Error("scenario is not a reviewed certification probe");
  }

  if (scenario === "async_echo") {
    assertOnlyKeys(input, ["action", "scenario", "marker"]);
  } else if (scenario === "artifact_consumer") {
    assertOnlyKeys(input, [
      "action",
      "scenario",
      "artifact_id",
      "expected_sha256",
    ]);
  } else {
    assertOnlyKeys(input, ["action", "scenario"]);
  }

  const reviewedScenario = scenario as CertificationScenario;
  return {
    action: "start",
    scenario: reviewedScenario,
    request: buildScenarioRequest(reviewedScenario, input),
  };
}

function noArguments(value: unknown, label: string): void {
  const input = inputRecord(value, label);
  assertOnlyKeys(input, []);
}

function policyProbeArguments(value: unknown): void {
  const input = inputRecord(value, "Policy probe arguments");
  assertOnlyKeys(input, ["_routine"]);
  if (!Object.prototype.hasOwnProperty.call(input, "_routine")) return;

  const wake = inputRecord(input._routine, "Policy probe routine context");
  assertOnlyKeys(wake, [
    "routine_id",
    "routine_run_id",
    "trace_id",
    "trigger",
    "attempt",
    "scheduled_at",
    "intent",
  ]);
  requiredString(wake.routine_id, "_routine.routine_id", UUID_PATTERN);
  requiredString(wake.routine_run_id, "_routine.routine_run_id", UUID_PATTERN);
  if (
    wake.trace_id !== null &&
    (typeof wake.trace_id !== "string" || !UUID_PATTERN.test(wake.trace_id))
  ) {
    throw new Error("_routine.trace_id is invalid");
  }
  if (wake.trigger !== "manual" && wake.trigger !== "scheduled") {
    throw new Error("_routine.trigger is invalid");
  }
  if (
    !Number.isSafeInteger(wake.attempt) ||
    (wake.attempt as number) < 1 ||
    (wake.attempt as number) > 100
  ) {
    throw new Error("_routine.attempt is invalid");
  }
  if (
    typeof wake.scheduled_at !== "string" ||
    !Number.isFinite(Date.parse(wake.scheduled_at))
  ) {
    throw new Error("_routine.scheduled_at is invalid");
  }
  if (
    wake.intent !== null &&
    (typeof wake.intent !== "string" || wake.intent.length > 1_000)
  ) {
    throw new Error("_routine.intent is invalid");
  }
}

/** Return deterministic fixture metadata without opening Compute admission. */
export function fixture_identity(args?: Record<string, never>) {
  noArguments(args, "Fixture identity arguments");
  return {
    fixture: "galactic-compute-certification",
    schema_version: 1,
    scenarios: [...SCENARIOS],
    deterministic_artifact_sha256: DETERMINISTIC_ARTIFACT_SHA256,
  };
}

/** Start, inspect, or cancel one reviewed certification scenario. */
export async function run_compute_certification(
  args: CertificationArgs,
): Promise<ComputeResult | ComputeRun> {
  const plan = certificationPlan(args);
  if (plan.action === "status") {
    return await galactic.compute.get(plan.runId);
  }
  if (plan.action === "cancel") {
    return await galactic.compute.cancel(plan.runId);
  }
  return await galactic.compute(plan.request);
}

/**
 * Fixed, zero-caller-input Compute call used as a managed-routine policy
 * target. Only the platform-reserved routine wake envelope is accepted. The
 * routine ships paused; a policy test must fail before this body starts.
 */
export async function run_compute_policy_probe(
  args?: { _routine?: RoutineWake },
): Promise<ComputeResult> {
  policyProbeArguments(args);
  return await galactic.compute({
    ...baseRequest(["node", "-e", POLICY_PROBE_SCRIPT], "async", 10_000),
  });
}
