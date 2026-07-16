#!/usr/bin/env node
// Durable-execution smoke: dispatch an async run, then poll the job to a
// terminal state. One green pass proves the whole PR3 spine on a REAL
// deployment: the queue producer binding, the queue() consumer (including
// ctx.exports/LOADER availability inside it — undocumented platform
// behavior), the queued→running claim, the loaded-isolate resource limits,
// and settlement writing the job row that the launch facade serves.
//
// The smoke uses the canonical connected-Agent surfaces: gx.call dispatches
// through /mcp/platform and gx.job polls the owner-scoped result. The launch
// website function route intentionally requires an account session and must
// not be weakened to accommodate CI builder/operator keys.
//
// Usage:
//   node scripts/smoke/durable-exec-smoke.mjs \
//     --url https://ultralight-api-staging.rgn4jz429m.workers.dev \
//     --token <launch session or api token> \
//     --app <agent id or slug> --function <functionName> \
//     [--args '{"prompt":"hi"}'] [--timeout-seconds 360]
//
// The target function does NOT need execution.class async — the smoke passes
// _async: true to opt in at dispatch time.

import { parseArgs } from '../analysis/_shared.mjs';

const args = parseArgs(process.argv.slice(2));

function required(flag) {
  const value = String(args.get(flag) || '').trim();
  if (!value) {
    console.error(`durable-exec-smoke requires ${flag}`);
    process.exit(1);
  }
  return value;
}

const baseUrl = required('--url').replace(/\/$/, '');
const token = required('--token');
const appId = required('--app');
const functionName = required('--function');
const fnArgs = args.has('--args') ? JSON.parse(String(args.get('--args'))) : {};
const timeoutSeconds = Number(args.get('--timeout-seconds') || 360);

const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};

async function callPlatformTool(name, toolArgs) {
  const res = await fetch(`${baseUrl}/mcp/platform`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: { name, arguments: toolArgs },
    }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status} non-JSON: ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  const result = body.result;
  if (!result) throw new Error(`no MCP result: ${text.slice(0, 300)}`);
  if (result.isError) {
    throw new Error(result.content?.[0]?.text || 'MCP tool error');
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const contentText = result.content?.[0]?.text;
  try {
    return contentText ? JSON.parse(contentText) : result;
  } catch {
    return { text: contentText };
  }
}

function fail(step, detail) {
  console.error(`FAIL [${step}] ${detail}`);
  process.exit(1);
}

console.log(`[1/3] Dispatching async run: ${appId}.${functionName}`);
let envelope;
try {
  envelope = await callPlatformTool('gx.call', {
    app_id: appId,
    function_name: functionName,
    args: { ...fnArgs, _async: true },
    // Running this operator-invoked smoke is explicit one-shot approval for
    // the fixed certification function. It does not persist or widen policy.
    confirm: true,
  });
} catch (err) {
  fail('dispatch', String(err?.message || err));
}
if (envelope?._async !== true || typeof envelope?.job_id !== 'string') {
  fail(
    'dispatch',
    `expected { _async: true, job_id } envelope, got: ${JSON.stringify(envelope).slice(0, 400)}\n` +
      'If the queue binding is missing the call falls back to synchronous execution — check `wrangler queues list` and the EXEC_QUEUE producer.',
  );
}
console.log(`      queued job ${envelope.job_id}`);

console.log(`[2/3] Polling job to a terminal state (max ${timeoutSeconds}s)`);
const deadline = Date.now() + timeoutSeconds * 1000;
let lastStatus = 'queued';
let job = null;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  try {
    job = await callPlatformTool('gx.job', { job_id: envelope.job_id });
  } catch (err) {
    fail('poll', String(err?.message || err));
  }
  if (job.status !== lastStatus) {
    console.log(`      ${lastStatus} → ${job.status}`);
    lastStatus = job.status;
  }
  if (job.status === 'completed' || job.status === 'failed') break;
}

if (!job || (job.status !== 'completed' && job.status !== 'failed')) {
  fail(
    'poll',
    `job did not reach a terminal state within ${timeoutSeconds}s (last: ${lastStatus}). ` +
      'A job stuck in "queued" means the consumer never claimed it (queue() handler or consumer attach problem); ' +
      'stuck in "running" means the claim worked but the execution died (check ctx.exports/LOADER inside queue(), and the stale sweeper will fail it in ~10min).',
  );
}

console.log(`[3/3] Terminal state: ${job.status}`);
console.log(
  `      durationMs=${job.duration_ms} aiCostLight=${job.ai_cost_light} executionId=${job.execution_id}`,
);
if (job.status === 'failed') {
  // A failed FUNCTION still proves the spine (dispatch, claim, execute,
  // settle) — but call it out so the operator decides if the failure is the
  // function's fault or the platform's.
  console.log(`      error: ${JSON.stringify(job.error).slice(0, 400)}`);
  console.log(
    'NOTE: the durable-execution spine worked end-to-end (dispatched, claimed, executed, settled), ' +
      'but the function itself failed — verify this is expected for the chosen function/args.',
  );
  process.exit(2);
}
console.log('PASS: durable execution spine verified end-to-end.');
