/**
 * CLI Configuration Management
 *
 * Config file location: ~/.ultralight/config.json
 */

import { join } from 'https://deno.land/std@0.208.0/path/mod.ts';

export interface Config {
  api_url: string;
  auth?: {
    token: string;
    expires_at?: string;  // Optional - API tokens may not have expiry
    refresh_token?: string;
    is_api_token?: boolean;  // True for ul_xxx tokens
  };
  defaults?: {
    visibility?: 'private' | 'unlisted' | 'public';
    auto_docs?: boolean;
  };
}

const DEFAULT_API_URL = 'https://ultralight-api.rgn4jz429m.workers.dev';
const LEGACY_API_URLS = new Set([
  'https://api.ultralight.dev',
  'https://ultralight-api-iikqz.ondigitalocean.app',
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

function getConfigDir(): string {
  const home = Deno.env.get('HOME') || Deno.env.get('USERPROFILE') || '.';
  return join(home, '.ultralight');
}

function getConfigPath(): string {
  return join(getConfigDir(), 'config.json');
}

export async function getConfig(): Promise<Config> {
  try {
    const configPath = getConfigPath();
    const content = await Deno.readTextFile(configPath);
    const config = JSON.parse(content) as Config;
    return normalizeConfig(config);
  } catch {
    return DEFAULT_CONFIG;
  }
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
