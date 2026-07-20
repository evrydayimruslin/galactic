/**
 * CLI Configuration Management
 *
 * Config file location: ~/.galactic/config.json
 * (the legacy ~/.ultralight/config.json is read as a fallback for upgraders and
 *  migrated forward on the next save)
 */

import { join } from 'https://deno.land/std@0.208.0/path/mod.ts';

export interface Config {
  api_url: string;
  auth?: {
    token: string;
    expires_at?: string;  // Optional - API tokens may not have expiry
    refresh_token?: string;
    is_api_token?: boolean;  // True for gx_xxx (or legacy ul_xxx) tokens
    is_job_token?: boolean;  // Ephemeral lease token; never persisted
  };
  runtime?: {
    kind: 'compute-job';
    lease_id: string;
    token_file: string;
  };
  defaults?: {
    visibility?: 'private' | 'unlisted' | 'public';
    auto_docs?: boolean;
  };
}

import { loadRuntimeConfig } from './job-context.ts';

const DEFAULT_API_URL = 'https://api.connectgalactic.com';
const LEGACY_API_URLS = new Set([
  'https://api.ultralightagent.com',
  'https://api.ultralight.dev',
  'https://ultralight-api-iikqz.ondigitalocean.app',
  'https://ultralight-api.rgn4jz429m.workers.dev',
]);

const DEFAULT_CONFIG: Config = {
  api_url: DEFAULT_API_URL,
  defaults: {
    visibility: 'private',
    auto_docs: true,
  },
};

function normalizeConfig(config: Config): Config {
  const normalized: Config = {
    ...DEFAULT_CONFIG,
    ...config,
    defaults: {
      ...DEFAULT_CONFIG.defaults,
      ...config.defaults,
    },
  };

  if (LEGACY_API_URLS.has(normalized.api_url)) {
    normalized.api_url = DEFAULT_API_URL;
  }

  return normalized;
}

function getHome(): string {
  return Deno.env.get('HOME') || Deno.env.get('USERPROFILE') || '.';
}

function getConfigDir(): string {
  return join(getHome(), '.galactic');
}

function getConfigPath(): string {
  return join(getConfigDir(), 'config.json');
}

// Pre-rebrand location; read as a fallback and removed once migrated forward.
function getLegacyConfigPath(): string {
  return join(getHome(), '.ultralight', 'config.json');
}

export async function getConfig(): Promise<Config> {
  // Prefer the current ~/.galactic location, then fall back to the legacy
  // ~/.ultralight location so upgraders keep their saved token until the next
  // saveConfig() migrates it forward.
  for (const path of [getConfigPath(), getLegacyConfigPath()]) {
    try {
      const content = await Deno.readTextFile(path);
      const config = JSON.parse(content) as Config;
      return normalizeConfig(config);
    } catch {
      // Try the next candidate location.
    }
  }
  return DEFAULT_CONFIG;
}

/**
 * Resolve CLI auth for this process. Compute-job mode bypasses getConfig(), so
 * no persistent human token can be read or used as a fallback inside a body.
 */
export async function getRuntimeConfig(): Promise<Config> {
  return await loadRuntimeConfig({
    readPersistentConfig: getConfig,
  });
}

export async function saveConfig(config: Config): Promise<void> {
  const configDir = getConfigDir();
  const configPath = getConfigPath();

  // Ensure config directory exists
  try {
    await Deno.mkdir(configDir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  await Deno.writeTextFile(configPath, JSON.stringify(config, null, 2));

  // Migrate forward: once the token lives in ~/.galactic, drop the stale legacy
  // copy so `logout` can't leave a usable token behind in ~/.ultralight.
  try {
    await Deno.remove(getLegacyConfigPath());
  } catch {
    // No legacy file (already migrated, or fresh install) — nothing to clean up.
  }
}

export async function clearConfig(): Promise<void> {
  const config = await getConfig();
  delete config.auth;
  await saveConfig(config);
}

/**
 * Simple argument parser
 */
export interface ParsedArgs {
  _: (string | number)[];
  help?: boolean;
  [key: string]: unknown;
}

export interface ParseOptions {
  string?: string[];
  boolean?: string[];
  number?: string[];
  alias?: Record<string, string>;
  default?: Record<string, unknown>;
}

export function parseArgs(args: string[], options: ParseOptions = {}): ParsedArgs {
  const result: ParsedArgs = { _: [] };

  const stringSet = new Set(options.string || []);
  const booleanSet = new Set(options.boolean || []);
  const numberSet = new Set(options.number || []);
  const aliasMap = new Map<string, string>();

  // Build alias map (alias -> canonical)
  // Input format: { shortAlias: canonicalName } e.g., { t: 'token' }
  for (const [alias, canonical] of Object.entries(options.alias || {})) {
    aliasMap.set(alias, canonical);
  }

  // Apply defaults
  for (const [key, value] of Object.entries(options.default || {})) {
    result[key] = value;
  }

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      result.help = true;
      i++;
      continue;
    }

    if (arg.startsWith('--')) {
      // Long option
      const equalIndex = arg.indexOf('=');
      let key: string;
      let value: string | undefined;

      if (equalIndex !== -1) {
        key = arg.slice(2, equalIndex);
        value = arg.slice(equalIndex + 1);
      } else {
        key = arg.slice(2);
        value = undefined;
      }

      // Resolve alias
      key = aliasMap.get(key) || key;

      if (booleanSet.has(key)) {
        result[key] = value === undefined ? true : value !== 'false';
      } else if (value !== undefined) {
        result[key] = numberSet.has(key) ? Number(value) : value;
      } else if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        result[key] = numberSet.has(key) ? Number(args[i + 1]) : args[i + 1];
        i++;
      } else {
        result[key] = true;
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      // Short option
      let key = arg.slice(1);
      key = aliasMap.get(key) || key;

      if (booleanSet.has(key)) {
        result[key] = true;
      } else if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        result[key] = numberSet.has(key) ? Number(args[i + 1]) : args[i + 1];
        i++;
      } else {
        result[key] = true;
      }
    } else {
      // Positional argument
      result._.push(arg);
    }

    i++;
  }

  return result;
}
