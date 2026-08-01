import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyProductionApiReleaseState } from './verify-production-api-release-state.mjs';

const SHA = 'a'.repeat(40);
const API_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';

function status(versionId) {
  return { versions: [{ percentage: 100, version_id: versionId }] };
}

function sessionExport() {
  return {
    GxTestSession: {
      type: 'durable-object',
      storage: 'sqlite',
      state: 'created',
    },
  };
}

function fixture() {
  return {
    apiStatus: status(API_ID),
    apiVersion: {
      id: API_ID,
      annotations: { 'workers/tag': `api-${SHA}` },
      resources: {
        bindings: [{
          name: 'GX_TEST_SESSION',
          type: 'durable_object_namespace',
          class_name: 'GxTestSession',
          script_name: 'galactic-gx-test-session',
        }],
        script_runtime: { exports: sessionExport() },
      },
    },
    sessionStatus: status(SESSION_ID),
    sessionVersion: {
      id: SESSION_ID,
      annotations: { 'workers/tag': `gx-test-session-${SHA}` },
      resources: { script_runtime: { exports: sessionExport() } },
    },
    candidateSha: SHA,
  };
}

test('accepts only the exact stable API and gx.test session release pair', () => {
  assert.deepEqual(verifyProductionApiReleaseState(fixture()), {
    candidate_sha: SHA,
    active_api_version_id: API_ID,
    active_gx_test_session_version_id: SESSION_ID,
  });
});

test('rejects stale API and gx.test session release tags', () => {
  const staleApi = fixture();
  staleApi.apiVersion.annotations['workers/tag'] = `api-${'b'.repeat(40)}`;
  assert.throws(
    () => verifyProductionApiReleaseState(staleApi),
    /API tag does not match/u,
  );

  const staleSession = fixture();
  staleSession.sessionVersion.annotations['workers/tag'] = `gx-test-session-${'b'.repeat(40)}`;
  assert.throws(
    () => verifyProductionApiReleaseState(staleSession),
    /gx\.test session tag does not match/u,
  );
});

test('rejects mixed deployments and an unreviewed session binding', () => {
  const mixed = fixture();
  mixed.apiStatus.versions[0].version_id = '33333333-3333-4333-8333-333333333333';
  assert.throws(
    () => verifyProductionApiReleaseState(mixed),
    /API detail does not match/u,
  );

  const wrongBinding = fixture();
  wrongBinding.apiVersion.resources.bindings[0].script_name = 'other-worker';
  assert.throws(
    () => verifyProductionApiReleaseState(wrongBinding),
    /GX_TEST_SESSION binding/u,
  );
});

test('rejects split traffic and malformed release identities', () => {
  const split = fixture();
  split.sessionStatus.versions.push({
    percentage: 10,
    version_id: '44444444-4444-4444-8444-444444444444',
  });
  assert.throws(
    () => verifyProductionApiReleaseState(split),
    /exactly one stable 100% version/u,
  );

  assert.throws(
    () => verifyProductionApiReleaseState({ ...fixture(), candidateSha: 'ABC' }),
    /candidate SHA/u,
  );
});
