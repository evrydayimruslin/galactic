# `galactic.compute()` developer guide

`galactic.compute()` gives a hosted Galactic Agent a disposable Linux computer
for one job. It is a latent Agent runtime capability, parallel to
`galactic.ai()`:

- `galactic.ai()` sends a bounded inference request to the configured model
  route;
- `galactic.compute()` admits a bounded job, starts `developer-v1` on demand,
  executes an argv vector, captures declared outputs, settles usage, and
  destroys the body.

It is not a public platform MCP tool, a perpetual VM, or an Agent credential.
The Agent function remains on Galactic's normal runtime; only the requested
computer job runs in the disposable body.

## The three authorization layers

A run starts only when all three layers allow it:

1. The live Agent release declares `compute:exec`, profile `developer-v1`, a
   semantic tool ceiling, and any secret **names** that can be requested.
2. The owner narrows that ceiling in the Agent's Compute panel: enabled state,
   allowed tools, secret destinations, timeout, concurrency, and artifact
   limits.
3. The API control plane checks the authenticated caller, exact Agent and
   function, request, available budget, and current policy on every admission
   and every private `gx` call.

Neither the request nor the body can broaden those layers. A tool name is a
dependency and audit disclosure, not an image name, package-install request, or
binary-level security boundary. The broad `developer-v1` image contains the
whole reviewed catalog; selecting `shell` does not make Chromium or DuckDB
unexecutable. Raw secrets and Galactic platform/Agent calls remain separately
enforced authorities.

The reviewed manifest ceiling has this shape:

```ts
{
  permissions: ["compute:exec"],
  compute: {
    profile: "developer-v1",
    tools: ["shell", "browser"],
    secrets: ["GITHUB_TOKEN"]
  }
}
```

The parser derives `compute:exec` and per-function `uses_compute` when it sees a
callable `galactic.compute(...)` (or compatibility alias
`ultralight.compute(...)`). Release review still owns the final manifest. Tool
IDs must exist in the platform catalog and match the canonical lower-case
semantic ID grammar; examples here do not override that catalog.

The immutable `developer-v1` catalog is: `shell`, `browser`, `office`,
`media`, `pdf`, `ocr`, `data`, `databases`, `transfer`, `git`,
`coding.claude`, `coding.codex`, and `galactic`. Unknown IDs are rejected in
v1. These are review labels over one pinned broad image; selecting `data`, for
example, does not assemble a new image, install DuckDB during the lease, or
remove other preinstalled binaries from the body.

## Callable API

The v1 binding is a callable function object with status and cancellation on
the same namespace:

```ts
interface ComputeBinding {
  (request: ComputeRequest): Promise<ComputeResult>;
  get(runId: string): Promise<ComputeRun>;
  cancel(runId: string): Promise<ComputeRun>;
}
```

Request:

```ts
interface ComputeRequest {
  argv: [string, ...string[]];
  tools: string[];
  profile?: "developer-v1";
  secrets?: string[];
  mode?: "sync" | "async";
  cwd?: string;
  stdin?: string;
  timeout_ms?: number;
  input_artifacts?: Array<{
    artifact_id: string;
    mount_path: string;
  }>;
  capture_paths?: string[];
}
```

Public run result:

```ts
type ComputeRunStatus =
  | "queued"
  | "reserving"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "settlement_pending";

interface ComputeRun {
  run_id: string;
  receipt_id: string;
  status: ComputeRunStatus;
  profile: "developer-v1";
  tools: string[];
  created_at: string;
  started_at?: string;
  finished_at?: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  artifacts?: Array<{
    artifact_id: string;
    path: string;
    size_bytes: number;
    sha256: string;
    expires_at: string;
  }>;
  error?: string;
}
```

Internal lease IDs, tokens, secret metadata, placement data, image selectors,
provider keys, and control-plane errors are intentionally absent.

## First function

Pass an argv array, not one shell command string:

```ts
export async function auditRepository(args: {
  query?: string;
}): Promise<unknown> {
  const query = args.query?.trim() || "TODO|FIXME";

  return await galactic.compute({
    argv: ["rg", "--line-number", "--hidden", query, "."],
    tools: ["shell"],
    profile: "developer-v1",
    mode: "sync",
    cwd: ".",
    timeout_ms: 30_000,
  });
}
```

Arguments are shell-quoted by the execution plane. Do not collapse user input
into `bash -lc`. If a real shell program is necessary, pass it explicitly and
keep all untrusted values outside the script or validate them against a strict
allowlist first:

```ts
await galactic.compute({
  argv: ["bash", "-lc", "set -euo pipefail; npm ci; npm test"],
  tools: ["shell"],
  mode: "async",
  timeout_ms: 480_000,
});
```

`cwd`, artifact mount paths, and capture paths are relative to `/workspace`.
Absolute paths, `..`, empty segments, backslashes, and path escapes are denied.
`developer-v1` accepts an owner-narrowable artifact budget up to 1 GiB. Before
copying any input from R2, the body measures its live writable filesystem and
requires the declared inputs plus 512 MiB of scratch headroom. A run can
therefore fail with `artifact_error` before execution even when its declared
bytes are under the policy ceiling if the deployed image leaves insufficient
working space. Keep large intermediate data in R2 and capture only the final
bounded outputs.

## Sync versus async

Use sync for short jobs where the Agent function should wait for the terminal
result. Sync is the default, defaults to 30 seconds, and `timeout_ms` may not
exceed `30_000`; choose async explicitly for every longer job. Sync admission
also fails before reserving budget if the host-authenticated parent execution
deadline cannot still contain the complete worst-case lease: 195 seconds of
Container startup, the requested command timeout, 15 seconds of teardown, and
30 seconds reserved for settlement and the parent response. A short command
requested late in an Agent invocation can therefore return
`COMPUTE_SYNC_DEADLINE_REQUIRES_ASYNC` even though its own timeout is valid.

Queue-delivered async work is deliberately capped below total Container
capacity: production admits at most 15 concurrent queue consumers against 20
instances, and staging admits 3 against 5. The remaining five/two slots are
reserved as operational headroom for direct synchronous jobs and recovery
traffic. The margin is not an availability SLA—sync work can still queue or be
denied under broader saturation—and production admission remains canary-only
until mixed direct/queue load testing validates it.

```ts
const result = await galactic.compute({
  argv: ["python", "-c", "print(sum(range(1000)))"],
  tools: ["shell"],
  mode: "sync",
  timeout_ms: 30_000,
});

if (result.status !== "completed") {
  return { ok: false, runId: result.run_id, error: result.error };
}
return { ok: true, output: result.stdout, receiptId: result.receipt_id };
```

Use async when the parent should return quickly or a later invocation will
inspect the job. Run reads and cancellation are scoped to the exact initiating
Agent function, so one function must own all three actions:

```ts
export async function build(args: {
  action: "start" | "status" | "cancel";
  run_id?: string;
}): Promise<unknown> {
  if (args.action === "start") {
    return await galactic.compute({
      argv: ["npm", "run", "build"],
      tools: ["shell"],
      mode: "async",
      timeout_ms: 480_000,
      capture_paths: ["dist"],
    });
  }
  if (!args.run_id) throw new Error("run_id is required");
  return args.action === "cancel"
    ? await galactic.compute.cancel(args.run_id)
    : await galactic.compute.get(args.run_id);
}
```

Status and cancellation are owner/Agent/function scoped. Knowing a run ID does
not grant access. Cancellation is idempotent and can race normal completion;
the control plane returns the one authoritative terminal state.

V1 async execution is deliberately capped at `480_000` ms (eight minutes).
Cloudflare push Queue consumers have a hard 15-minute wall-time limit; the
remaining envelope is reserved for bounded Container startup, private
control-plane calls, artifact finalization, settlement, and body destruction.
The API, owner policy, SQL admission, execution Worker, and Launch UI all
enforce the same ceiling. Longer durable jobs require moving orchestration to
a primitive such as Cloudflare Workflows; silently accepting a longer timeout
on the Queue path would make the contract unreliable.

Do not busy-poll from one Agent invocation. Return the async run ID, use a
later function/routine/notification, or poll at a bounded cadence outside the
body.

## Artifacts

Inputs are existing, owner-authorized Galactic artifact IDs. The request never
contains R2 keys or storage credentials:

```ts
const result = await galactic.compute({
  argv: ["python", "scripts/analyze.py", "input/events.csv", "output/report.json"],
  tools: ["shell", "data"],
  input_artifacts: [
    { artifact_id: args.events_artifact_id, mount_path: "input/events.csv" },
  ],
  capture_paths: ["output/report.json"],
  mode: "async",
  timeout_ms: 120_000,
});
```

The execution plane streams the input through its private R2 binding, verifies
size and SHA-256 before execution, and captures only declared paths. A captured
directory is returned as a `tar.gz`; each output carries an ID, logical path,
size, hash, and exact `expires_at`. Output links are minted by the control plane
for the authorized owner, not exposed as public R2 URLs.

The 1 GiB value is the owner-narrowable aggregate run budget, not a promise
that one output can fill it. V1 automatic capture is capped at 100 MiB per
declared path and 250 MiB across all captured paths; the lower owner policy
still wins. `gx artifacts push` and `gx artifacts pull` each cap one object at
100 MiB. Automatic capture is best-effort: a missing, unsafe, or oversized
declared path is omitted and a bounded warning is appended to `stderr`; it does
not change an otherwise successful command into a failed run. Always verify
the returned artifact IDs before claiming delivery. Keep larger intermediate
data inside the disposable workspace, split intentional outputs, or use an
owner-approved external HTTPS object service.

Ready outputs are retained for 30 days from their ready commit. Admission and
owner downloads fail once `expires_at` is reached; a fresh input admission made
before that instant pins the backing object until the dependent run is
terminal, so an active body never loses a valid input. Downloading does not
renew the published expiry.

V1 also enforces a per-owner physical retention ceiling of 10 GiB and 10,000
output objects across Agents. Input aliases share the original R2 object and do
not double-count. Pending output reservations count immediately. Capacity is
released only after the control plane tombstones the metadata, deletes the
exact R2 object, and records that physical deletion; if the quota is exhausted,
the platform returns `COMPUTE_ARTIFACT_STORAGE_QUOTA_EXCEEDED`. Treat that as a
deterministic capacity error rather than retrying in a tight loop.

Treat stdout/stderr as bounded diagnostics, not an artifact channel. They can
be truncated. Use `capture_paths` or `gx artifacts push` for material output.

## Headless browser use

The standard `developer-v1` image includes pinned Playwright and Chromium. A
Node script is easier to audit than a large inline `-e` program:

```ts
const result = await galactic.compute({
  argv: ["node", "scripts/capture-page.mjs", args.url],
  tools: ["shell", "browser"],
  capture_paths: ["output/page.png", "output/page.json"],
  mode: "async",
  timeout_ms: 120_000,
});
```

Example `scripts/capture-page.mjs` staged as an input artifact or checked into
the repository being analyzed:

```js
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const target = new URL(process.argv[2]);
if (target.protocol !== "https:") throw new Error("HTTPS URL required");

await mkdir("output", { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.screenshot({ path: "output/page.png", fullPage: true });
  await writeFile("output/page.json", JSON.stringify({
    url: page.url(),
    title: await page.title(),
  }));
} finally {
  await browser.close();
}
```

The body has public **HTTP(S)-only** egress in v1. Direct Container internet is
disabled. The pinned Cloudflare runtime permits Cloudflare DNS and sends every
HTTP(S) request through a Worker handler; literal private/metadata addresses
and every hostname in Galactic's public zones are denied before that handler.
The Compute Worker opts into `global_fetch_strictly_public`, so its forwarding
`fetch()` returns through Cloudflare's public front door instead of reaching a
same-zone origin behind Worker/WAF policy.
The handler follows no redirect itself, so every client-followed hop re-enters
the hostname gate. `CONNECT`, arbitrary DNS servers, and raw TCP transports are
denied. Git/package/API traffic over HTTPS works; Git-over-SSH and native
PostgreSQL, MySQL, Redis, and other database sockets do not. Use an HTTPS API or
a separately reviewed proxy for remote services that expose only native ports.

The staging gate includes public HTTPS, redirect-to-private, DNS rebinding,
raw-port, and browser WebSocket/Upgrade probes. WebSocket egress is not a v1
guarantee until the pinned Cloudflare runtime passes that deployed probe.
Browser content remains untrusted, and any explicitly supplied secret can be
sent to an arbitrary public HTTPS origin by the job. Prefer low-privilege,
short-lived credentials and host-scoped provider policy where available.

## Agent-configured secrets

Some computer tasks genuinely need credentials: a repository token, package
registry token, database credential, or inference provider key for a coding
CLI. Those are explicit Agent-configured secrets, not ambient authority.

Flow:

1. The release declares an eligible secret **name**, never its value.
2. The owner writes the value through the existing per-Agent Variables secret
   flow. List/read responses report only configured presence.
3. In the Compute panel, the owner maps the name to either a dedicated
   environment variable or a protected file under `/run/galactic/secrets`.
4. The function explicitly includes that name in `request.secrets`.
5. The control plane resolves the exact current version only after admission;
   the execution plane delivers it for that lease and destroys it with the
   body.

```ts
const result = await galactic.compute({
  argv: ["gh", "repo", "view", "galactic/example", "--json", "name,defaultBranchRef"],
  tools: ["git"],
  secrets: ["GITHUB_TOKEN"],
  timeout_ms: 30_000,
});
```

Never pass a secret value in `argv`, `stdin`, source, artifacts, or the Compute
request. Never echo it to output. Prefer low-privilege, short-lived,
environment-specific credentials with rotation and provider-side restrictions.

The platform reserves names such as human/Agent bearers, Galactic platform/API
keys, Supabase keys, and Cloudflare tokens. An owner mapping cannot override
those names.

### Coding-agent CLIs

The image includes pinned coding-agent CLIs as ordinary programs. They have no
special recursive authority. If an owner deliberately grants a provider secret
and the required tool label, a function can invoke one just as it invokes
`pandoc` or `duckdb`:

```ts
await galactic.compute({
  argv: ["claude", "-p", "Review this repository and write findings.md"],
  tools: ["coding.claude"],
  secrets: ["ANTHROPIC_API_KEY"],
  capture_paths: ["findings.md"],
  mode: "async",
  timeout_ms: 480_000,
});
```

or:

```ts
await galactic.compute({
  argv: ["codex", "exec", "Run the test suite and write a concise report"],
  tools: ["coding.codex"],
  secrets: ["OPENAI_API_KEY"],
  capture_paths: ["report.md"],
  mode: "async",
  timeout_ms: 480_000,
});
```

Exact CLI flags and semantic catalog IDs are versioned dependencies; verify
them against the deployed `developer-v1` catalog before shipping an Agent.
Longer term, a private inference proxy can replace raw BYOK delivery without
changing the `galactic.compute()` primitive.

## Combining `galactic.ai()` and `galactic.compute()`

The useful composition is inference for judgment and a disposable computer for
deterministic work.

### Compute, then explain across invocations

Reliable composition uses an async Compute run and a later invocation for
inference. The same Agent function must own both actions so the run lookup
retains its exact Agent/function scope:

```ts
export async function inspectData(args: {
  action: "start" | "explain";
  artifact_id: string;
  question: string;
  run_id?: string;
}): Promise<unknown> {
  if (args.action === "start") {
    return await galactic.compute({
      argv: ["duckdb", "-json", ":memory:", "select * from read_csv_auto('input/data.csv') limit 50"],
      tools: ["data"],
      input_artifacts: [
        { artifact_id: args.artifact_id, mount_path: "input/data.csv" },
      ],
      mode: "async",
      timeout_ms: 120_000,
    });
  }

  if (!args.run_id) throw new Error("run_id is required");
  const run = await galactic.compute.get(args.run_id);
  if (run.status !== "completed") return run;

  const explanation = await galactic.ai({
    messages: [
      {
        role: "system",
        content: "Explain the supplied structured sample. Do not invent rows or totals.",
      },
      {
        role: "user",
        content: `Question: ${args.question}\n\nSample:\n${run.stdout ?? ""}`,
      },
    ],
    max_tokens: 800,
  });

  return {
    run_id: run.run_id,
    receipt_id: run.receipt_id,
    answer: explanation.content,
    inference_usage: explanation.usage,
  };
}
```

### Plan, then execute safely

An AI response must not become an unrestricted shell string. Ask for a small
structured plan, parse it, and map only recognized operation names to fixed
argv templates:

```ts
const decision = await galactic.ai({
  messages: [
    { role: "system", content: "Choose exactly one operation: pdf_text, ocr, or metadata. Return only that word." },
    { role: "user", content: args.task },
  ],
  max_tokens: 10,
});

const commands: Record<string, [string, ...string[]]> = {
  pdf_text: ["pdftotext", "input/document.pdf", "output/document.txt"],
  ocr: ["tesseract", "input/page.png", "output/page"],
  metadata: ["pdfinfo", "input/document.pdf"],
};
const operation = decision.content.trim();
const argv = commands[operation];
if (!argv) throw new Error("AI selected an unsupported operation");

return await galactic.compute({
  argv,
  tools: ["pdf", "ocr"],
  input_artifacts: [{
    artifact_id: args.artifact_id,
    mount_path: operation === "ocr" ? "input/page.png" : "input/document.pdf",
  }],
  capture_paths: operation === "metadata" ? [] : ["output"],
  mode: "async",
  timeout_ms: 120_000,
});
```

The calls have separate receipts and usage. AI-then-Compute should normally
start Compute asynchronously as above: an inference call may leave too little
of the parent deadline for sync admission. Compute-then-AI should use the
two-invocation pattern. A parent Agent capacity ceiling still applies to both;
Compute reserve/true-up cannot mint additional budget.

## Billing and capacity conservation

Every leased Compute run has exactly one economic backing. When Compute is
invoked from a subscription-backed parent Agent execution, Galactic acquires a
separate positive-Light reservation from that execution's authoritative
account/root-Agent capacity pool. The Compute lease intentionally consumes an
independent account/root-Agent concurrency slot as well as the separate
Compute-policy body slot. When the parent execution is not subscription-backed,
Compute uses a wallet hold instead. A run never has both forms of backing.

The default 30-second synchronous command reserves `0.49344` Light using the
complete bounded lease envelope:

```text
(30,000 ms command + 195,000 ms startup + 15,000 ms teardown)
  * 0.000002056 Light/ms
```

This reserve is conservation, not a new grant. Subscription capacity is trued
up to the full measured actual Compute amount at terminalization, including an
overrun above the initial reserve; wallet usage remains bounded by its funded
hold. Each path writes one durable receipt. If the immediate subscription
true-up cannot finish, the terminal result remains `settlement_pending` while
the capacity Queue and minute database reconciler retry the same immutable,
idempotent settlement. Do not retry the computer job to repair that state.

## `gx` inside the body

Every body contains a small `gx` CLI. It reads the opaque lease token from
`/run/galactic/job-token` and talks only to the private gateway:

```text
gx budget
gx receipt
gx artifacts pull <artifact-id> [destination]
gx artifacts push <path> [logical-name]
gx platform tools
gx platform call <tool-name> [json-arguments]
gx mcp
```

`gx platform tools` lists only the platform functions authorized for this run.
`gx platform call` does not inherit a human or Agent bearer; the control plane
introspects the job token and checks exact run authority for every call. An
owner may, for example, grant the ordinary `gx.test` and `gx.upload` platform
functions to a particular caller function. That can let a coding CLI test and
stage a private Agent version, but it is not a separate recursive-Agents mode
and it does not bypass upload, promotion, visibility, or owner-approval gates.

The job token expires and is revoked with the lease. Copying it out of the body
does not extend its authority or lifetime.

## What is in `developer-v1`

The pinned broad image is intended to avoid spending short leases on package
installation. It currently includes:

- Node.js, patched Python 3.13 with NumPy, Pandas, Matplotlib, IPython and
  psutil, compilers/build tools, Git/Git LFS, `gh`, SSH and `rsync`;
- `curl`, `wget`, DNS/netcat, `jq`, `ripgrep`, SQLite, DuckDB, PostgreSQL,
  MySQL and Redis clients;
- `ffmpeg`, ImageMagick, Pandoc, headless LibreOffice, Poppler and Tesseract;
- `rclone`, archive/file utilities, fonts and Xvfb;
- Playwright with Chromium;
- pinned Galactic, Claude Code, and Codex CLIs;
- `gx` and the private gateway environment.

Installed network clients do not expand the egress boundary. HTTPS modes work;
SSH and native remote database protocols are present for local files/services,
diagnostics, and a future scoped network capability, but cannot reach remote
ports in v1. The Cloudflare quick-tunnel helper is intentionally absent, so a
job cannot create an inbound preview URL or public Sandbox tunnel.

This is one immutable versioned profile, not a user-supplied Docker build. Tool
selection is currently dependency/audit metadata rather than command
enforcement. It can later drive cached layers/toolpacks, but it must not turn an
admission request into arbitrary image assembly. An Agent can still use normal
package managers during a run if egress and time permit; installed state dies
with the body unless captured as an artifact.

## Failure handling

- A nonzero process exit is a normal execution result with `exit_code`, stdout,
  and stderr. Make it actionable to the Agent instead of blindly retrying.
- Provisioning, image, artifact, secret, deadline, and internal failures are
  classified separately and appear in the owner run ledger/Alerts.
- `settlement_pending` means execution reached a terminal point but the usage
  ledger has not completed. Do not report it as successful or launch a
  replacement run; reconciliation owns it.
- Sync and async admissions are idempotent within their parent execution call
  index. Retrying the same parent execution must not create a second body or
  reserve twice.
- Timeouts and cancellation destroy the whole sandbox. An SDK command timeout
  alone is not treated as process termination.

## Release checklist for a Compute-using Agent

- [ ] Only functions that need a body call `galactic.compute()`.
- [ ] Release review shows `compute:exec` and exact `uses_compute` functions.
- [ ] Profile is exactly `developer-v1`.
- [ ] Tool list is the smallest useful subset of the current catalog.
- [ ] Secret names are declared; no value appears in code, manifest, or request.
- [ ] Owner policy narrows tools, secrets, timeout, concurrency, and artifacts.
- [ ] Every path is workspace-relative and every external URL is validated.
- [ ] User/model data never becomes an unchecked shell script.
- [ ] stdout/stderr are bounded; material output uses artifacts.
- [ ] Sync success, nonzero exit, async completion, timeout, and cancel are tested.
- [ ] Browser test launches the real pinned Chromium image.
- [ ] Secret test uses a staging-only low-privilege credential and verifies logs.
- [ ] Function returns `run_id` and `receipt_id` where operators will need them.
- [ ] Agent remains useful or gives a clear error while Compute is unavailable.
