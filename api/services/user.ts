// User Service
// Handles user settings, BYOK configuration, and preferences

import type {
  ActiveBYOKProvider,
  BYOKConfig,
  BYOKProvider,
  BYOKValidationMetadata,
  User,
} from "../../shared/types/index.ts";
import { isActiveBYOKProvider } from "../../shared/types/index.ts";
import { getEnv } from "../lib/env.ts";
import { decryptApiKey, encryptApiKey } from "./api-key-crypto.ts";

// ============================================
// USER SERVICE
// ============================================

export interface UserService {
  // User profile
  getUser(userId: string): Promise<UserProfile | null>;
  updateUser(
    userId: string,
    updates: Partial<UserProfile>,
  ): Promise<UserProfile>;

  // BYOK management
  getBYOKConfigs(userId: string): Promise<BYOKConfig[]>;
  addBYOKProvider(
    userId: string,
    provider: BYOKProvider,
    apiKey: string,
    model?: string,
  ): Promise<BYOKConfig>;
  updateBYOKProvider(
    userId: string,
    provider: BYOKProvider,
    updates: { apiKey?: string; model?: string },
  ): Promise<BYOKConfig>;
  saveValidatedBYOKProvider(
    userId: string,
    provider: ActiveBYOKProvider,
    apiKey: string,
    model: string | undefined,
    validation: BYOKValidationMetadata,
    setPrimary: boolean,
  ): Promise<BYOKConfig>;
  removeBYOKProvider(userId: string, provider: BYOKProvider): Promise<void>;
  setPrimaryProvider(userId: string, provider: BYOKProvider): Promise<void>;
  getDecryptedApiKey(
    userId: string,
    provider: BYOKProvider,
  ): Promise<string | null>;
}

export interface UserProfile {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  tier: string;
  country: string | null;
  featured_app_id: string | null;
  profile_slug: string | null;
  byok_enabled: boolean;
  byok_provider: BYOKProvider | null;
  byok_configs: BYOKConfig[];
  /** OpenRouter slug for the platform (credits) Light path; null = provider default. */
  platform_inference_model: string | null;
  /** Spendable balance in Light. Loaded for free-mode/economic-state checks. */
  balance_light: number;
}

// Database row structure
interface RawByokEntry {
  encrypted_key?: string;
  model?: string;
  added_at?: string;
  validation?: unknown;
  [key: string]: unknown;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  tier: string;
  country: string | null;
  featured_app_id: string | null;
  profile_slug: string | null;
  byok_enabled: boolean;
  byok_provider: string | null;
  byok_keys: Record<string, RawByokEntry> | null;
  balance_light: number | null;
}

function isKnownByokProvider(
  provider: string,
): provider is ActiveBYOKProvider {
  return isActiveBYOKProvider(provider);
}

function hasUsableByokKey(
  entry: RawByokEntry | undefined,
): boolean {
  return typeof entry?.encrypted_key === "string" &&
    entry.encrypted_key.length > 0;
}

export function createUserService(): UserService {
  // Direct REST API calls to Supabase

  async function getUser(userId: string): Promise<UserProfile | null> {
    const response = await fetch(
      `${
        getEnv("SUPABASE_URL")
      }/rest/v1/users?id=eq.${userId}&select=id,email,display_name,avatar_url,tier,country,featured_app_id,profile_slug,byok_enabled,byok_provider,byok_keys,balance_light`,
      {
        headers: {
          "apikey": getEnv("SUPABASE_SERVICE_ROLE_KEY"),
          "Authorization": `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to get user: ${await response.text()}`);
    }

    const users = await response.json() as UserRow[];
    if (users.length === 0) return null;

    const user = users[0];
    const byokConfigs = parseByokConfigs(user.byok_keys);
    const platformModelEntry = user.byok_keys?.["_platform_model"];
    const platformInferenceModel =
      typeof platformModelEntry?.model === "string" &&
        platformModelEntry.model.trim()
        ? platformModelEntry.model.trim()
        : null;
    const configProviders = new Set(
      byokConfigs
        .filter((config) => config.has_key)
        .map((config) => config.provider),
    );
    const primaryProvider = user.byok_provider &&
        configProviders.has(user.byok_provider as BYOKProvider)
      ? user.byok_provider as BYOKProvider
      : byokConfigs.find((config) => config.has_key)?.provider || null;

    return {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      tier: user.tier || "free",
      country: user.country || null,
      featured_app_id: user.featured_app_id || null,
      profile_slug: user.profile_slug || null,
      byok_enabled: (user.byok_enabled || false) && configProviders.size > 0,
      byok_provider: primaryProvider,
      byok_configs: byokConfigs,
      platform_inference_model: platformInferenceModel,
      balance_light: typeof user.balance_light === "number"
        ? user.balance_light
        : 0,
    };
  }

  async function updateUser(
    userId: string,
    updates: Partial<UserProfile>,
  ): Promise<UserProfile> {
    const response = await fetch(
      `${getEnv("SUPABASE_URL")}/rest/v1/users?id=eq.${userId}`,
      {
        method: "PATCH",
        headers: {
          "apikey": getEnv("SUPABASE_SERVICE_ROLE_KEY"),
          "Authorization": `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
          "Prefer": "return=representation",
        },
        body: JSON.stringify({
          ...updates,
          updated_at: new Date().toISOString(),
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to update user: ${await response.text()}`);
    }

    const user = await getUser(userId);
    if (!user) throw new Error("User not found after update");
    return user;
  }

  async function getBYOKConfigs(userId: string): Promise<BYOKConfig[]> {
    const user = await getUser(userId);
    return user?.byok_configs || [];
  }

  async function addBYOKProvider(
    userId: string,
    provider: BYOKProvider,
    apiKey: string,
    model?: string,
  ): Promise<BYOKConfig> {
    // Encrypt the API key
    const encryptedKey = await encryptApiKey(apiKey);
    const addedAt = new Date().toISOString();

    // Get current user to merge configs
    const user = await getUser(userId);
    const currentKeys = await getRawByokKeys(userId);

    // Add new provider config
    const newKeys = {
      ...currentKeys,
      [provider]: {
        encrypted_key: encryptedKey,
        model,
        added_at: addedAt,
      },
    };

    // Update user with new config
    // If this is the first provider, set it as primary
    const isPrimaryUpdate = !user?.byok_provider ||
      !isKnownByokProvider(user.byok_provider);

    const response = await fetch(
      `${getEnv("SUPABASE_URL")}/rest/v1/users?id=eq.${userId}`,
      {
        method: "PATCH",
        headers: {
          "apikey": getEnv("SUPABASE_SERVICE_ROLE_KEY"),
          "Authorization": `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          byok_keys: newKeys,
          byok_enabled: true,
          ...(isPrimaryUpdate ? { byok_provider: provider } : {}),
          updated_at: new Date().toISOString(),
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Failed to add BYOK provider: ${await response.text()}`);
    }

    return {
      provider,
      has_key: true,
      model,
      added_at: addedAt,
    };
  }

  async function updateBYOKProvider(
    userId: string,
    provider: BYOKProvider,
    updates: { apiKey?: string; model?: string },
  ): Promise<BYOKConfig> {
    const currentKeys = await getRawByokKeys(userId);

    if (!currentKeys[provider]) {
      throw new Error(`Provider ${provider} not configured`);
    }

    const trimmedApiKey = updates.apiKey?.trim();
    if (!trimmedApiKey && !hasUsableByokKey(currentKeys[provider])) {
      throw new Error(`Provider ${provider} not configured`);
    }

    const updatedConfig = {
      ...currentKeys[provider],
      ...(trimmedApiKey
        ? { encrypted_key: await encryptApiKey(trimmedApiKey) }
        : {}),
      ...(updates.model !== undefined ? { model: updates.model } : {}),
    };
    // Any unvalidated key/model mutation invalidates prior proof. The launch
    // funnel uses saveValidatedBYOKProvider for an atomic validated write.
    if (trimmedApiKey || updates.model !== undefined) {
      delete updatedConfig.validation;
    }

    const newKeys = {
      ...currentKeys,
      [provider]: updatedConfig,
    };

    const response = await fetch(
      `${getEnv("SUPABASE_URL")}/rest/v1/users?id=eq.${userId}`,
      {
        method: "PATCH",
        headers: {
          "apikey": getEnv("SUPABASE_SERVICE_ROLE_KEY"),
          "Authorization": `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          byok_keys: newKeys,
          updated_at: new Date().toISOString(),
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Failed to update BYOK provider: ${await response.text()}`,
      );
    }

    return {
      provider,
      has_key: hasUsableByokKey(updatedConfig),
      model: updatedConfig.model,
      added_at: updatedConfig.added_at || new Date(0).toISOString(),
    };
  }

  async function saveValidatedBYOKProvider(
    userId: string,
    provider: ActiveBYOKProvider,
    apiKey: string,
    model: string | undefined,
    validation: BYOKValidationMetadata,
    setPrimary: boolean,
  ): Promise<BYOKConfig> {
    const encryptedKey = await encryptApiKey(apiKey);
    const response = await fetch(
      `${
        getEnv("SUPABASE_URL")
      }/rest/v1/rpc/save_validated_launch_byok_provider`,
      {
        method: "POST",
        headers: {
          "apikey": getEnv("SUPABASE_SERVICE_ROLE_KEY"),
          "Authorization": `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          p_user_id: userId,
          p_provider: provider,
          p_encrypted_key: encryptedKey,
          p_model: model ?? null,
          p_validation: validation,
          p_set_primary: setPrimary,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Failed to save validated BYOK provider: ${await response.text()}`,
      );
    }
    const addedAt = new Date().toISOString();
    return {
      provider,
      has_key: true,
      model,
      added_at: addedAt,
      validation,
    };
  }

  async function removeBYOKProvider(
    userId: string,
    provider: BYOKProvider,
  ): Promise<void> {
    const currentKeys = await getRawByokKeys(userId);
    const user = await getUser(userId);

    // Remove the provider
    delete currentKeys[provider];

    // If this was the primary provider, clear it or set a new one
    const remainingProviders = Object.entries(currentKeys)
      .filter(([provider, config]) =>
        isKnownByokProvider(provider) && hasUsableByokKey(config)
      )
      .map(([provider]) => provider as BYOKProvider);
    const newPrimary = remainingProviders[0] || null;
    const byokEnabled = remainingProviders.length > 0;

    const response = await fetch(
      `${getEnv("SUPABASE_URL")}/rest/v1/users?id=eq.${userId}`,
      {
        method: "PATCH",
        headers: {
          "apikey": getEnv("SUPABASE_SERVICE_ROLE_KEY"),
          "Authorization": `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          byok_keys: Object.keys(currentKeys).length > 0 ? currentKeys : null,
          byok_provider: user?.byok_provider === provider
            ? newPrimary
            : user?.byok_provider,
          byok_enabled: byokEnabled,
          updated_at: new Date().toISOString(),
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Failed to remove BYOK provider: ${await response.text()}`,
      );
    }
  }

  async function setPrimaryProvider(
    userId: string,
    provider: BYOKProvider,
  ): Promise<void> {
    const currentKeys = await getRawByokKeys(userId);

    if (!hasUsableByokKey(currentKeys[provider])) {
      throw new Error(`Provider ${provider} not configured`);
    }

    const response = await fetch(
      `${getEnv("SUPABASE_URL")}/rest/v1/users?id=eq.${userId}`,
      {
        method: "PATCH",
        headers: {
          "apikey": getEnv("SUPABASE_SERVICE_ROLE_KEY"),
          "Authorization": `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          byok_provider: provider,
          updated_at: new Date().toISOString(),
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Failed to set primary BYOK provider: ${await response.text()}`,
      );
    }
  }

  async function getDecryptedApiKey(
    userId: string,
    provider: BYOKProvider,
  ): Promise<string | null> {
    const currentKeys = await getRawByokKeys(userId);
    const config = currentKeys[provider];

    if (!config?.encrypted_key) {
      return null;
    }

    try {
      return await decryptApiKey(config.encrypted_key);
    } catch (error) {
      console.error("Failed to decrypt API key:", error);
      return null;
    }
  }

  // Helper to get raw byok_keys from database
  async function getRawByokKeys(
    userId: string,
  ): Promise<Record<string, RawByokEntry>> {
    const response = await fetch(
      `${
        getEnv("SUPABASE_URL")
      }/rest/v1/users?id=eq.${userId}&select=byok_keys`,
      {
        headers: {
          "apikey": getEnv("SUPABASE_SERVICE_ROLE_KEY"),
          "Authorization": `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to get user: ${await response.text()}`);
    }

    const users = await response.json() as {
      byok_keys: Record<string, RawByokEntry> | null;
    }[];
    return users[0]?.byok_keys || {};
  }

  // Helper to parse byok_keys into BYOKConfig array
  function parseValidation(
    provider: ActiveBYOKProvider,
    value: unknown,
  ): BYOKValidationMetadata | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const operations = Array.isArray(record.operations)
      ? record.operations.filter((
        operation,
      ): operation is "generate" | "embed" =>
        operation === "generate" || operation === "embed"
      )
      : [];
    if (
      record.provider !== provider ||
      typeof record.policy_version !== "string" ||
      typeof record.key_version !== "string" ||
      typeof record.validated_at !== "string" ||
      operations.length === 0
    ) return undefined;
    return {
      policy_version: record.policy_version,
      key_version: record.key_version,
      provider,
      ...(typeof record.model === "string" ? { model: record.model } : {}),
      operations,
      validated_at: record.validated_at,
    };
  }

  function parseByokConfigs(
    byokKeys: Record<string, RawByokEntry> | null,
  ): BYOKConfig[] {
    if (!byokKeys) return [];

    return Object.entries(byokKeys)
      .filter(([provider]) => isKnownByokProvider(provider))
      .map(([provider, config]) => ({
        provider: provider as BYOKProvider,
        has_key: hasUsableByokKey(config),
        model: config.model,
        added_at: config.added_at || new Date(0).toISOString(),
        validation: parseValidation(
          provider as ActiveBYOKProvider,
          config.validation,
        ),
      }));
  }

  return {
    getUser,
    updateUser,
    getBYOKConfigs,
    addBYOKProvider,
    updateBYOKProvider,
    saveValidatedBYOKProvider,
    removeBYOKProvider,
    setPrimaryProvider,
    getDecryptedApiKey,
  };
}
