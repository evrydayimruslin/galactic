#!/usr/bin/env node
// Durable-execution smoke: dispatch an async run, then poll the job to a
// terminal state. One green pass proves the whole PR3 spine on a REAL
// deployment: the queue producer binding, the queue() consumer (including
// ctx.exports/LOADER availability inside it — undocumented platform
// behavior), the queued→running claim, the loaded-isolate resource limits,
// and settlement writing the job row that the launch facade serves.
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

function fail(step, detail) {
  console.error(`FAIL [${step}] ${detail}`);
  process.exit(1);
}

console.log(`[1/3] Dispatching async run: ${appId}.${functionName}`);
const runRes = await fetch(
  `${baseUrl}/api/launch/agents/${encodeURIComponent(appId)}/functions/${
    encodeURIComponent(functionName)
  }/run`,
  {
    method: 'POST',
    headers,
    body: JSON.stringify({ args: { ...fnArgs, _async: true } }),
  },
);
if (!runRes.ok) {
  fail('dispatch', `run endpoint returned ${runRes.status}: ${await runRes.text()}`);
}
const runBody = await runRes.json();
const envelope = runBody?.result;
if (envelope?._async !== true || typeof envelope?.job_id !== 'string') {
  fail(
    'dispatch',
    `expected { _async: true, job_id } envelope, got: ${JSON.stringify(runBody).slice(0, 400)}\n` +
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
  const jobRes = await fetch(`${baseUrl}/api/launch/jobs/${envelope.job_id}`, {
    headers,
  });
  if (!jobRes.ok) {
    fail('poll', `jobs endpoint returned ${jobRes.status}: ${await jobRes.text()}`);
  }
  job = await jobRes.json();
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
console.log(`      durationMs=${job.durationMs} aiCostCredits=${job.aiCostCredits} executionId=${job.executionId}`);
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
