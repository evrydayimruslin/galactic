/**
 * OpenRouter Key Provisioning Service
 *
 * Uses the OpenRouter Management API to create per-user API keys.
 * The platform's OPENROUTER_API_KEY is a provisioning/management key
 * that can only create and manage keys — not make chat completions.
 *
 * Flow:
 *   1. User sends first chat message
 *   2. Server checks if user has an OpenRouter key stored
 *   3. If not, creates one via POST /api/v1/keys (management key)
 *   4. Stores the key (encrypted) in user record
 *   5. Uses the per-user key for all subsequent OpenRouter requests
 *
 * Docs: https://openrouter.ai/docs/api/api-reference/api-keys/create-keys
 */

import { getEnv } from '../lib/env.ts';
import { decryptApiKey, encryptApiKey } from './api-key-crypto.ts';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const PLATFORM_OR_KEY = '_platform_openrouter';
// Reserved key in the same byok_keys JSONB holding the user's chosen OpenRouter
// model slug for the platform (credits-billed Light) path. Plaintext — it's a
// model id, not a secret. Hidden from byok_configs by parseByokConfigs' provider
// filter, exactly like _platform_openrouter.
const PLATFORM_MODEL_KEY = '_platform_model';

// ── Types ──

interface OpenRouterKeyResponse {
  data: {
    hash: string;
    name: string;
    label: string;
    disabled: boolean;
    limit: number | null;
    limit_remaining: number | null;
    limit_reset: string | null;
    usage: number;
    created_at: string;
    expires_at: string | null;
  };
  key: string; // The actual API key — only returned on creation
}

type StoredByokKeys = Record<string, Record<string, unknown>>;

interface EncryptedPlatformOpenRouterEntry {
  encrypted_key: string;
  added_at: string;
  provisioned_at: string;
  managed_by_platform: true;
  [key: string]: unknown;
}

// ── Create Key ──

/**
 * Create a new OpenRouter API key for a user via the Management API.
 * Returns the plaintext key (shown only once).
 */
export async function createOpenRouterKey(userId: string, userEmail: string): Promise<string> {
  if (!getEnv('OPENROUTER_API_KEY')) {
    throw new Error('OPENROUTER_API_KEY (management key) not configured');
  }

  const keyName = `ul-${userId.substring(0, 8)}-${userEmail.split('@')[0]}`;

  console.log(`[OR-KEYS] Creating OpenRouter key for user ${userId} (name: ${keyName})`);

  const res = await fetch(`${OPENROUTER_BASE}/keys`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${getEnv('OPENROUTER_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: keyName,
      // No limit — we handle billing ourselves via balance_light
      limit: null,
      limit_reset: null,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[OR-KEYS] Failed to create key: ${res.status} — ${errText}`);
    throw new Error(`OpenRouter key creation failed (${res.status}): ${errText}`);
  }

  const data = await res.json() as OpenRouterKeyResponse;
  console.log(`[OR-KEYS] Key created — hash: ${data.data.hash}, name: ${data.data.name}`);

  return data.key;
}

// ── Store / Retrieve Key ──

function isEncryptedPlatformEntry(value: unknown): value is EncryptedPlatformOpenRouterEntry {
  return !!value && typeof value === 'object' && typeof (value as { encrypted_key?: unknown }).encrypted_key === 'string';
}

async function fetchUserByokKeys(userId: string): Promise<StoredByokKeys | null> {
  const res = await fetch(
    `${getEnv('SUPABASE_URL')}/rest/v1/users?id=eq.${userId}&select=byok_keys`,
    {
      headers: {
        'apikey': getEnv('SUPABASE_SERVICE_ROLE_KEY'),
        'Authorization': `Bearer ${getEnv('SUPABASE_SERVICE_ROLE_KEY')}`,
      },
    }
  );

  if (!res.ok) {
    console.error(`[OR-KEYS] Failed to fetch stored key for ${userId}`);
    return null;
  }

  const rows = await res.json() as { byok_keys: StoredByokKeys | null }[];
  return rows?.[0]?.byok_keys || {};
}

async function patchUserByokKeys(userId: string, byokKeys: StoredByokKeys): Promise<void> {
  const patchRes = await fetch(
    `${getEnv('SUPABASE_URL')}/rest/v1/users?id=eq.${userId}`,
    {
      method: 'PATCH',
      headers: {
        'apikey': getEnv('SUPABASE_SERVICE_ROLE_KEY'),
        'Authorization': `Bearer ${getEnv('SUPABASE_SERVICE_ROLE_KEY')}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ byok_keys: byokKeys }),
    }
  );

  if (!patchRes.ok) {
    const errText = await patchRes.text();
    console.error(`[OR-KEYS] Failed to store key for ${userId}: ${errText}`);
    throw new Error(`Failed to store OpenRouter key: ${errText}`);
  }
}

async function buildEncryptedPlatformEntry(key: string, provisionedAt = new Date().toISOString()): Promise<EncryptedPlatformOpenRouterEntry> {
  return {
    encrypted_key: await encryptApiKey(key),
    added_at: provisionedAt,
    provisioned_at: provisionedAt,
    managed_by_platform: true,
  };
}

/**
 * Get the user's OpenRouter API key from the database.
 * Reads from byok_keys._platform_openrouter in the users table.
 * Returns null if no key is stored.
 */
export async function getStoredOpenRouterKey(userId: string): Promise<string | null> {
  const byokKeys = await fetchUserByokKeys(userId);
  if (!byokKeys) return null;

  const entry = byokKeys[PLATFORM_OR_KEY];
  if (!entry) return null;

  if (isEncryptedPlatformEntry(entry)) {
    try {
      return await decryptApiKey(entry.encrypted_key);
    } catch (err) {
      console.error(`[OR-KEYS] Failed to decrypt stored key for ${userId}:`, err);
      return null;
    }
  }

  if (entry && typeof entry === 'object' && typeof (entry as { key?: unknown }).key === 'string') {
    // Legacy plaintext entry. Lazily migrate it to canonical encryption — the
    // same transformation as the crypto backfill (encrypt in place, drop the
    // plaintext) — then use it. Best-effort: a write failure never blocks
    // inference; we return the usable key and retry the migration next read.
    const { key: legacyPlaintext, ...rest } = entry as { key: string; [k: string]: unknown };
    try {
      const upgraded: StoredByokKeys = {
        ...byokKeys,
        [PLATFORM_OR_KEY]: {
          ...rest,
          encrypted_key: await encryptApiKey(legacyPlaintext),
          managed_by_platform: true,
          added_at: typeof rest.added_at === 'string' ? rest.added_at : new Date().toISOString(),
          provisioned_at: typeof rest.provisioned_at === 'string' ? rest.provisioned_at : new Date().toISOString(),
        },
      };
      await patchUserByokKeys(userId, upgraded);
      console.log(`[OR-KEYS] Auto-migrated legacy plaintext platform key to encrypted for user ${userId}`);
    } catch (err) {
      console.error(`[OR-KEYS] Failed to auto-migrate legacy plaintext key for ${userId} (using plaintext this call):`, err);
    }
    return legacyPlaintext;
  }

  return null;
}

/**
 * Store an OpenRouter API key for a user.
 * Merges into the existing byok_keys JSONB column under _platform_openrouter.
 */
export async function storeOpenRouterKey(userId: string, key: string): Promise<void> {
  const currentKeys = await fetchUserByokKeys(userId);
  if (currentKeys === null) {
    throw new Error(`Failed to fetch OpenRouter key state for ${userId}`);
  }

  const updatedKeys = {
    ...currentKeys,
    [PLATFORM_OR_KEY]: await buildEncryptedPlatformEntry(key),
  };

  await patchUserByokKeys(userId, updatedKeys);

  console.log(`[OR-KEYS] Key stored for user ${userId} in byok_keys.${PLATFORM_OR_KEY}`);
}

// ── Platform inference model preference ──
// Note: reads happen inline in user.ts getUser (off the already-loaded
// byok_keys, no extra fetch), so there is no getter here — only the setter.

/**
 * Set (or clear, when model is null/empty) the user's platform inference model.
 * Merges into byok_keys so it preserves _platform_openrouter and every provider
 * key — same merge-and-PATCH discipline as storeOpenRouterKey.
 */
export async function setPlatformInferenceModel(userId: string, model: string | null): Promise<void> {
  const currentKeys = await fetchUserByokKeys(userId);
  if (currentKeys === null) {
    throw new Error(`Failed to fetch byok_keys for ${userId}`);
  }
  const next: StoredByokKeys = { ...currentKeys };
  const trimmed = model?.trim();
  if (trimmed) {
    next[PLATFORM_MODEL_KEY] = { model: trimmed, added_at: new Date().toISOString() };
  } else {
    delete next[PLATFORM_MODEL_KEY];
  }
  await patchUserByokKeys(userId, next);
  console.log(`[OR-KEYS] Platform model for ${userId} set to ${trimmed || '(cleared)'}`);
}

// ── Get or Create ──

/**
 * Get the user's OpenRouter API key, creating one if needed.
 * This is the main entry point — called before every chat request.
 */
export async function getOrCreateOpenRouterKey(
  userId: string,
  userEmail: string,
): Promise<string> {
  // 1. Check if user already has a key
  const existingKey = await getStoredOpenRouterKey(userId);
  if (existingKey) {
    return existingKey;
  }

  // 2. Create a new key via OpenRouter Management API
  const newKey = await createOpenRouterKey(userId, userEmail);

  // 3. Store it for future use
  await storeOpenRouterKey(userId, newKey);

  return newKey;
}
