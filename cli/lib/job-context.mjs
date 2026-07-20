/**
 * Pure-Node lease auth resolution shared by the npm entry point and MCP bridge.
 * Keep this module dependency-free so compute images can use it before Deno is
 * available. Job tokens are read from files and are never accepted on argv.
 */

import { readFileSync as nodeReadFileSync } from 'fs';
import { homedir as nodeHomedir } from 'os';
import { join } from 'path';

export const DEFAULT_API_URL = 'https://api.connectgalactic.com';
export const DEFAULT_JOB_GATEWAY_URL = 'https://galactic.internal/v1';
export const DEFAULT_JOB_TOKEN_FILE = '/run/galactic/job-token';

const JOB_ENV_KEYS = [
  'GALACTIC_JOB_TOKEN_FILE',
  'GALACTIC_GATEWAY_URL',
  'GALACTIC_LEASE_ID',
];

const LEGACY_API_URLS = new Set([
  'https://api.ultralightagent.com',
  'https://api.ultralight.dev',
  'https://ultralight-api-iikqz.ondigitalocean.app',
  'https://ultralight-api.rgn4jz429m.workers.dev',
]);

function present(env, key) {
  return Object.prototype.hasOwnProperty.call(env, key);
}

function normalizeUrl(raw, variableName) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variableName} must be a valid absolute URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${variableName} must use http or https`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${variableName} cannot contain credentials, a query, or a fragment`);
  }
  return url.toString().replace(/\/+$/, '');
}

export function resolveComputeJobEnvironment(env = process.env) {
  const hasJobSignal = JOB_ENV_KEYS.some((key) => present(env, key));
  if (!hasJobSignal) return null;

  const leaseId = env.GALACTIC_LEASE_ID?.trim();
  if (!leaseId) {
    throw new Error('Incomplete Galactic Compute job context: GALACTIC_LEASE_ID is required');
  }

  const explicitTokenFile = env.GALACTIC_JOB_TOKEN_FILE?.trim();
  if (present(env, 'GALACTIC_JOB_TOKEN_FILE') && !explicitTokenFile) {
    throw new Error('GALACTIC_JOB_TOKEN_FILE cannot be empty');
  }
  const explicitGateway = env.GALACTIC_GATEWAY_URL?.trim();
  if (present(env, 'GALACTIC_GATEWAY_URL') && !explicitGateway) {
    throw new Error('GALACTIC_GATEWAY_URL cannot be empty');
  }

  return {
    leaseId,
    tokenFile: explicitTokenFile || DEFAULT_JOB_TOKEN_FILE,
    gatewayUrl: normalizeUrl(explicitGateway || DEFAULT_JOB_GATEWAY_URL, 'GALACTIC_GATEWAY_URL'),
  };
}

function normalizeJobToken(raw) {
  const token = String(raw).trim();
  if (!token) throw new Error('Galactic Compute job token file is empty');
  if (token.length > 16_384 || /[\r\n\0]/.test(token)) {
    throw new Error('Galactic Compute job token file is invalid');
  }
  return token;
}

/**
 * Resolve bridge auth. When a job marker is present this function deliberately
 * returns before consulting env API tokens or either persistent config file.
 */
export function loadAuth(options = {}) {
  const env = options.env ?? process.env;
  const readFileSync = options.readFileSync ?? nodeReadFileSync;
  const homedir = options.homedir ?? nodeHomedir;
  const job = resolveComputeJobEnvironment(env);

  if (job) {
    let rawToken;
    try {
      rawToken = readFileSync(job.tokenFile, 'utf-8');
    } catch {
      throw new Error(`Unable to read Galactic Compute job token file: ${job.tokenFile}`);
    }
    return {
      token: normalizeJobToken(rawToken),
      apiUrl: job.gatewayUrl,
      jobMode: true,
      leaseId: job.leaseId,
    };
  }

  let token = env.GALACTIC_TOKEN || env.ULTRALIGHT_TOKEN ||
    env.GALACTIC_API_TOKEN || env.ULTRALIGHT_API_TOKEN || null;
  let apiUrl = env.GALACTIC_API_URL || env.ULTRALIGHT_API_URL || null;
  for (const dir of ['.galactic', '.ultralight']) {
    try {
      const cfg = JSON.parse(readFileSync(join(homedir(), dir, 'config.json'), 'utf-8'));
      if (!token && cfg?.auth?.token) token = cfg.auth.token;
      if (!apiUrl && cfg?.api_url) apiUrl = cfg.api_url;
      if (token) break;
    } catch {
      // Try the next persistent config location.
    }
  }
  apiUrl = normalizeUrl(apiUrl || DEFAULT_API_URL, 'GALACTIC_API_URL');
  if (LEGACY_API_URLS.has(apiUrl)) apiUrl = DEFAULT_API_URL;
  return { token, apiUrl, jobMode: false, leaseId: null };
}
