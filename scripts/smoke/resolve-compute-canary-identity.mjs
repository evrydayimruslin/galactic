#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { chmod, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { ownerSessionTarget, resolveSmokeOwner } from './with-staging-owner-session.mjs';

export const COMPUTE_CANARY_IDENTITY_KIND = 'galactic_compute_canary_identity';
export const COMPUTE_CANARY_IDENTITY_SCHEMA_VERSION = 1;

const CANARY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function containsControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if ((codePoint >= 0 && codePoint <= 31) || codePoint === 127) return true;
  }
  return false;
}

export class ComputeCanaryIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ComputeCanaryIdentityError';
  }
}

function fail(message) {
  throw new ComputeCanaryIdentityError(message);
}

function requiredSecret(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} is required.`);
  }
  return value;
}

function canonicalUuid(value, label) {
  if (typeof value !== 'string' || !CANARY_UUID.test(value)) {
    fail(`${label} is not a canonical canary UUID.`);
  }
  return value.toLowerCase();
}

export function computeCanaryIdentityEvidence({ target, owner }) {
  let environment;
  try {
    environment = ownerSessionTarget(target);
  } catch {
    fail('Compute canary target is invalid.');
  }
  if (owner === null || typeof owner !== 'object' || Array.isArray(owner)) {
    fail('Compute canary owner proof is invalid.');
  }
  const ownerId = canonicalUuid(owner.id, 'Compute canary owner id');
  const agentId = canonicalUuid(
    owner.smokeAgentId,
    'Compute canary Agent id',
  );
  const allowlistEntry = `${ownerId}/${agentId}`;
  if (
    allowlistEntry.includes(',') ||
    allowlistEntry.split('/').length !== 2
  ) {
    fail('Compute canary allowlist identity is invalid.');
  }
  return {
    schema_version: COMPUTE_CANARY_IDENTITY_SCHEMA_VERSION,
    kind: COMPUTE_CANARY_IDENTITY_KIND,
    target: environment.name,
    owner_id: ownerId,
    agent_id: agentId,
    allowlist_entry: allowlistEntry,
  };
}

export function computeCanaryIdentityOutputPath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    containsControlCharacter(value) ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    basename(value).length === 0 ||
    dirname(value) === value
  ) {
    fail('Compute canary identity output path is invalid.');
  }
  return value;
}

/**
 * Publish one private evidence file from a same-directory temporary file. The
 * temporary and final files are both mode 0600, and a failed publication never
 * leaves the temporary identity record behind.
 */
export async function writeComputeCanaryIdentityEvidence(
  outputPath,
  evidence,
  {
    writeFileImpl = writeFile,
    chmodImpl = chmod,
    renameImpl = rename,
    unlinkImpl = unlink,
    randomUuidImpl = randomUUID,
  } = {},
) {
  const destination = computeCanaryIdentityOutputPath(outputPath);
  const verifiedEvidence = computeCanaryIdentityEvidence({
    target: evidence?.target,
    owner: {
      id: evidence?.owner_id,
      smokeAgentId: evidence?.agent_id,
    },
  });
  if (
    evidence?.schema_version !== verifiedEvidence.schema_version ||
    evidence?.kind !== verifiedEvidence.kind ||
    evidence?.allowlist_entry !== verifiedEvidence.allowlist_entry ||
    Object.keys(evidence ?? {}).length !== Object.keys(verifiedEvidence).length
  ) {
    fail('Compute canary identity evidence is invalid.');
  }

  const temporary = resolve(
    dirname(destination),
    `.${basename(destination)}.${
      canonicalUuid(
        randomUuidImpl(),
        'Compute canary identity temporary id',
      )
    }.tmp`,
  );
  if (temporary === destination || dirname(temporary) !== dirname(destination)) {
    fail('Compute canary identity temporary path is invalid.');
  }
  const serialized = `${JSON.stringify(verifiedEvidence, null, 2)}\n`;
  try {
    await writeFileImpl(temporary, serialized, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await chmodImpl(temporary, 0o600);
    await renameImpl(temporary, destination);
  } catch {
    // A failed write can still leave a partially created file. The name is
    // random, same-directory, and validated above, so always attempt cleanup.
    await unlinkImpl(temporary).catch(() => undefined);
    fail('Compute canary identity evidence could not be written.');
  }
  return destination;
}

export async function resolveComputeCanaryIdentity({
  target,
  apiToken,
  smokeAgentId,
  outputPath,
  resolveOwner = resolveSmokeOwner,
  writeEvidence = writeComputeCanaryIdentityEvidence,
}) {
  let environment;
  try {
    environment = ownerSessionTarget(target);
  } catch {
    fail('Compute canary target is invalid.');
  }
  const token = requiredSecret(apiToken, 'ULTRALIGHT_TOKEN');
  const requestedAgentId = canonicalUuid(
    smokeAgentId,
    'GALACTIC_SMOKE_APP_ID',
  );
  const destination = computeCanaryIdentityOutputPath(outputPath);

  let owner;
  try {
    owner = await resolveOwner({
      target: environment.name,
      apiBase: environment.apiBase,
      apiToken: token,
      smokeAgentId: requestedAgentId,
    });
  } catch {
    // Resolver failures can contain upstream bodies or injected credentials.
    // Collapse them to a fixed message before they reach Actions logs.
    fail('Compute canary identity resolution failed.');
  }
  const evidence = computeCanaryIdentityEvidence({
    target: environment.name,
    owner,
  });
  if (evidence.agent_id !== requestedAgentId) {
    fail('Compute canary owner proof does not match the requested Agent.');
  }
  try {
    await writeEvidence(destination, evidence);
  } catch {
    // Publication dependencies must not be able to echo credentials either.
    fail('Compute canary identity evidence could not be written.');
  }
  return evidence;
}

export function computeCanaryIdentityConfigFromCli(argv, env = process.env) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 4 ||
    argv[0] !== '--target' ||
    argv[2] !== '--output'
  ) {
    fail(
      'Usage: resolve-compute-canary-identity.mjs ' +
        '--target <staging|production> --output <absolute-json-path>',
    );
  }
  let target;
  try {
    target = ownerSessionTarget(argv[1]).name;
  } catch {
    fail('Compute canary target is invalid.');
  }
  return {
    target,
    outputPath: computeCanaryIdentityOutputPath(argv[3]),
    apiToken: requiredSecret(env.ULTRALIGHT_TOKEN, 'ULTRALIGHT_TOKEN'),
    smokeAgentId: canonicalUuid(
      env.GALACTIC_SMOKE_APP_ID,
      'GALACTIC_SMOKE_APP_ID',
    ),
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  await resolveComputeCanaryIdentity(
    computeCanaryIdentityConfigFromCli(argv, env),
  );
  console.log('Compute canary identity evidence written.');
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(
      error instanceof ComputeCanaryIdentityError
        ? error.message
        : 'Compute canary identity resolution failed.',
    );
    process.exitCode = 1;
  }
}
