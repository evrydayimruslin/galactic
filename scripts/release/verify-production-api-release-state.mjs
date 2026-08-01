#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;

function fail(message) {
  throw new Error(`Production API release state is invalid: ${message}`);
}

function stableVersionId(status, label) {
  const versions = Array.isArray(status?.versions) ? status.versions : [];
  if (
    versions.length !== 1 ||
    Number(versions[0]?.percentage) !== 100 ||
    typeof versions[0]?.version_id !== 'string' ||
    !UUID.test(versions[0].version_id)
  ) {
    fail(`${label} must have exactly one stable 100% version`);
  }
  return versions[0].version_id;
}

function assertVersionIdentity(version, expectedId, expectedTag, label) {
  if (version?.id !== expectedId) {
    fail(`${label} detail does not match its stable deployment`);
  }
  if (version?.annotations?.['workers/tag'] !== expectedTag) {
    fail(`${label} tag does not match the release commit`);
  }
}

function assertSessionExport(version, label) {
  const session = version?.resources?.script_runtime?.exports?.GxTestSession;
  if (
    session === null ||
    typeof session !== 'object' ||
    Array.isArray(session) ||
    session.type !== 'durable-object' ||
    session.storage !== 'sqlite' ||
    ![undefined, 'created'].includes(session.state)
  ) {
    fail(`${label} does not expose the reviewed SQLite GxTestSession`);
  }
}

function assertApiSessionBinding(version) {
  const bindings = Array.isArray(version?.resources?.bindings)
    ? version.resources.bindings.filter((binding) => binding?.name === 'GX_TEST_SESSION')
    : [];
  if (
    bindings.length !== 1 ||
    bindings[0]?.type !== 'durable_object_namespace' ||
    bindings[0]?.class_name !== 'GxTestSession' ||
    bindings[0]?.script_name !== 'galactic-gx-test-session'
  ) {
    fail('API GX_TEST_SESSION binding does not target the reviewed Worker');
  }
}

export function verifyProductionApiReleaseState({
  apiStatus,
  apiVersion,
  sessionStatus,
  sessionVersion,
  candidateSha,
}) {
  if (typeof candidateSha !== 'string' || !COMMIT_SHA.test(candidateSha)) {
    fail('candidate SHA must be 40 lowercase hexadecimal characters');
  }

  const apiVersionId = stableVersionId(apiStatus, 'API');
  const sessionVersionId = stableVersionId(sessionStatus, 'gx.test session');
  assertVersionIdentity(
    apiVersion,
    apiVersionId,
    `api-${candidateSha}`,
    'API',
  );
  assertVersionIdentity(
    sessionVersion,
    sessionVersionId,
    `gx-test-session-${candidateSha}`,
    'gx.test session',
  );
  assertSessionExport(apiVersion, 'API');
  assertSessionExport(sessionVersion, 'gx.test session Worker');
  assertApiSessionBinding(apiVersion);

  return {
    candidate_sha: candidateSha,
    active_api_version_id: apiVersionId,
    active_gx_test_session_version_id: sessionVersionId,
  };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function main(argv) {
  if (argv.length !== 5) {
    throw new Error(
      'Usage: verify-production-api-release-state.mjs ' +
        '<api-status-json> <api-version-json> <session-status-json> ' +
        '<session-version-json> <candidate-sha>',
    );
  }
  const result = verifyProductionApiReleaseState({
    apiStatus: readJson(argv[0], 'API deployment status'),
    apiVersion: readJson(argv[1], 'API version detail'),
    sessionStatus: readJson(argv[2], 'gx.test session deployment status'),
    sessionVersion: readJson(argv[3], 'gx.test session version detail'),
    candidateSha: argv[4],
  });
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
