// WO-F4: device-grant helpers for `galacticconnection login`. Pure Node,
// dependency-injected for node:test.

export async function mintDeviceCode({ apiUrl, fetchFn }) {
  const response = await fetchFn(`${apiUrl}/api/launch/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.success !== true) {
    throw new Error(
      body && typeof body.error === 'string'
        ? body.error
        : `device code mint failed (${response.status})`,
    );
  }
  return body;
}

/**
 * Poll until the human approves (returns the reveal-once key payload),
 * the code expires/resolves elsewhere (throws), or maxTicks elapses
 * (returns null). 429s and transient failures wait and continue.
 */
export async function pollDeviceToken({
  apiUrl,
  deviceCode,
  intervalSeconds = 3,
  fetchFn,
  sleep,
  maxTicks = 220,
}) {
  let ticks = 0;
  while (ticks < maxTicks) {
    ticks += 1;
    let response;
    try {
      response = await fetchFn(`${apiUrl}/api/launch/device/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode }),
      });
    } catch {
      await sleep(intervalSeconds * 1_000);
      continue;
    }
    if (response.status === 429) {
      await sleep(intervalSeconds * 2 * 1_000);
      continue;
    }
    const body = await response.json().catch(() => null);
    if (response.ok && body && body.success === true) {
      if (body.status === 'complete') return body;
      await sleep(intervalSeconds * 1_000);
      continue;
    }
    throw new Error(
      body && typeof body.error === 'string'
        ? body.error
        : `device login failed (${response.status})`,
    );
  }
  return null;
}
