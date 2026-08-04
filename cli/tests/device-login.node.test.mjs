// WO-F4: node --test tests/device-login.node.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pollDeviceToken } from '../lib/device-login.mjs';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('pollDeviceToken waits through pending and 429, then lands the key once', async () => {
  const scripted = [
    jsonResponse({ success: true, status: 'pending', pollIntervalSeconds: 3 }),
    jsonResponse({ error: 'slow down' }, 429),
    jsonResponse({
      success: true,
      status: 'complete',
      plaintextToken: 'gx_devicekey123',
      tokenPrefix: 'gx_devic',
      scopes: ['apps:read'],
      expiresInDays: 90,
    }),
  ];
  let calls = 0;
  const sleeps = [];
  const result = await pollDeviceToken({
    apiUrl: 'https://api.example',
    deviceCode: 'ab'.repeat(32),
    fetchFn: async () => scripted[Math.min(calls++, scripted.length - 1)],
    sleep: async (ms) => sleeps.push(ms),
    maxTicks: 10,
  });
  assert.equal(result.plaintextToken, 'gx_devicekey123');
  assert.equal(calls, 3);
  assert.ok(sleeps.length >= 2, 'waited between polls');
});

test('pollDeviceToken surfaces terminal errors and gives up at maxTicks', async () => {
  await assert.rejects(
    () =>
      pollDeviceToken({
        apiUrl: 'https://api.example',
        deviceCode: 'ab'.repeat(32),
        fetchFn: async () => jsonResponse({ error: 'This device code has expired' }, 410),
        sleep: async () => {},
        maxTicks: 5,
      }),
    /expired/,
  );

  const gaveUp = await pollDeviceToken({
    apiUrl: 'https://api.example',
    deviceCode: 'ab'.repeat(32),
    fetchFn: async () => jsonResponse({ success: true, status: 'pending', pollIntervalSeconds: 3 }),
    sleep: async () => {},
    maxTicks: 3,
  });
  assert.equal(gaveUp, null);
});
