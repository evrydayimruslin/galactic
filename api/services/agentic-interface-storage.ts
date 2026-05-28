import {
  type AgenticInterfaceSpec,
  type AgenticInterfaceVerificationResult,
  validateAgenticInterfaceSpec,
} from "../../shared/contracts/agentic-interface.ts";
import { getEnv } from "../lib/env.ts";
import {
  getCommandSurfaceInventory as defaultGetCommandSurfaceInventory,
  type CommandSurfaceInventory,
} from "./command-surfaces.ts";
import {
  type FunctionIndex,
  getOrRebuildFunctionIndex as defaultGetOrRebuildFunctionIndex,
} from "./function-index.ts";
import { verifyAgenticInterfaceSpec } from "./agentic-interface-validate.ts";

export interface AgenticInterfaceStorageInput {
  interface_key?: unknown;
  title?: unknown;
  description?: unknown;
  icon?: unknown;
  spec?: unknown;
  source_prompt?: unknown;
  status?: unknown;
}

interface AgenticInterfaceRow {
  id: string;
  interface_key: string;
  title?: string | null;
  description?: string | null;
  icon?: string | null;
  spec: AgenticInterfaceSpec;
  source_prompt?: string | null;
  mode?: string | null;
  status?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface AgenticInterfaceSummary {
  id: string;
  interface_key: string;
  title: string;
  description: string | null;
  icon: string | null;
  source_prompt: string | null;
  mode: "saved";
  status: "active" | "archived";
  component_count: number;
  action_count: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface StoredAgenticInterface extends AgenticInterfaceSummary {
  stored_spec: AgenticInterfaceSpec;
  normalized_spec: AgenticInterfaceSpec;
  verification: AgenticInterfaceVerificationResult;
  warnings: AgenticInterfaceVerificationResult["warnings"];
  dropped: AgenticInterfaceVerificationResult["dropped"];
}

export interface AgenticInterfaceStorageDependencies {
  getFunctionIndex?: (userId: string) => Promise<FunctionIndex>;
  getCommandSurfaceInventory?: (userId: string) => Promise<CommandSurfaceInventory>;
  now?: () => Date;
}

const INTERFACE_KEY_RE = /^[a-z0-9_-]{1,64}$/;
const TITLE_MAX = 96;
const DESCRIPTION_MAX = 320;
const ICON_MAX = 64;
const SOURCE_PROMPT_MAX = 4000;
const SELECT_COLUMNS =
  "id,interface_key,title,description,icon,spec,source_prompt,mode,status,created_at,updated_at";

function getSupabaseEnv(): {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
} {
  return {
    SUPABASE_URL: getEnv("SUPABASE_URL"),
    SUPABASE_SERVICE_ROLE_KEY: getEnv("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

function serviceHeaders(prefer?: string): Record<string, string> {
  const { SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  return {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...(prefer ? { "Prefer": prefer } : {}),
  };
}

function humanizeKey(key: string): string {
  return key
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Interface";
}

function slugifyKey(value: unknown, fallback = "interface"): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return normalizeInterfaceKey(slug || fallback);
}

export function normalizeInterfaceKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("interface_key is required");
  }
  const normalized = value.trim();
  if (!INTERFACE_KEY_RE.test(normalized)) {
    throw new Error(
      "interface_key must be 1-64 lowercase letters, numbers, dashes, or underscores",
    );
  }
  return normalized;
}

function optionalString(
  value: unknown,
  field: string,
  max: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > max) {
    throw new Error(`${field} must be ${max} characters or fewer`);
  }
  return text;
}

function normalizeTitle(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") throw new Error("title must be a string");
  const text = value.trim();
  if (!text) return fallback;
  if (text.length > TITLE_MAX) {
    throw new Error(`title must be ${TITLE_MAX} characters or fewer`);
  }
  return text;
}

function normalizeStatus(value: unknown): "active" | "archived" {
  if (value === undefined || value === null || value === "") return "active";
  if (value === "active" || value === "archived") return value;
  throw new Error("status must be active or archived");
}

function countItems(spec: AgenticInterfaceSpec): {
  component_count: number;
  action_count: number;
} {
  return {
    component_count: spec.components?.length || 0,
    action_count: spec.actions?.length || 0,
  };
}

async function verifySpecForUser(
  userId: string,
  specInput: unknown,
  dependencies: AgenticInterfaceStorageDependencies,
): Promise<AgenticInterfaceVerificationResult> {
  const validation = validateAgenticInterfaceSpec(specInput);
  if (!validation.valid || !validation.spec) {
    throw new Error(
      validation.errors[0]?.message || "Invalid agentic interface spec",
    );
  }
  const fnIndex = await (dependencies.getFunctionIndex ||
    defaultGetOrRebuildFunctionIndex)(userId);
  const inventory = await (dependencies.getCommandSurfaceInventory ||
    defaultGetCommandSurfaceInventory)(userId);
  const verification = verifyAgenticInterfaceSpec(validation.spec, {
    fnIndex,
    inventory,
  });
  return {
    ...verification,
    spec: {
      ...verification.spec,
      mode: "saved",
    },
  };
}

function metadataForInput(
  input: AgenticInterfaceStorageInput,
  interfaceKey: string,
  spec: AgenticInterfaceSpec,
): {
  title: string;
  description: string | null;
  icon: string | null;
  source_prompt: string | null;
  status: "active" | "archived";
} {
  const has = (field: keyof AgenticInterfaceStorageInput) =>
    Object.prototype.hasOwnProperty.call(input, field);
  return {
    title: normalizeTitle(input.title, spec.title || humanizeKey(interfaceKey)),
    description: optionalString(
      has("description") ? input.description : spec.description,
      "description",
      DESCRIPTION_MAX,
    ) ?? null,
    icon: optionalString(input.icon, "icon", ICON_MAX) ?? null,
    source_prompt: optionalString(
      has("source_prompt") ? input.source_prompt : spec.provenance?.prompt,
      "source_prompt",
      SOURCE_PROMPT_MAX,
    ) ?? null,
    status: normalizeStatus(input.status),
  };
}

function summarizeRow(row: AgenticInterfaceRow): AgenticInterfaceSummary {
  const spec = row.spec;
  return {
    id: row.id,
    interface_key: normalizeInterfaceKey(row.interface_key),
    title: row.title || spec.title || humanizeKey(row.interface_key),
    description: row.description === undefined
      ? spec.description ?? null
      : row.description,
    icon: row.icon ?? null,
    source_prompt: row.source_prompt === undefined
      ? spec.provenance?.prompt ?? null
      : row.source_prompt,
    mode: "saved",
    status: row.status === "archived" ? "archived" : "active",
    ...countItems(spec),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function storedFromRow(
  userId: string,
  row: AgenticInterfaceRow,
  dependencies: AgenticInterfaceStorageDependencies,
  existingVerification?: AgenticInterfaceVerificationResult,
): Promise<StoredAgenticInterface> {
  const verification = existingVerification ||
    await verifySpecForUser(userId, row.spec, dependencies);
  const normalizedSpec = verification.spec;
  return {
    ...summarizeRow({ ...row, spec: normalizedSpec }),
    stored_spec: row.spec,
    normalized_spec: normalizedSpec,
    verification,
    warnings: verification.warnings,
    dropped: verification.dropped,
  };
}

async function fetchInterfaceRow(
  userId: string,
  interfaceKey: string,
): Promise<AgenticInterfaceRow | null> {
  const { SUPABASE_URL } = getSupabaseEnv();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_agentic_interfaces?user_id=eq.${userId}&interface_key=eq.${
      encodeURIComponent(interfaceKey)
    }&deleted_at=is.null&select=${SELECT_COLUMNS}&limit=1`,
    { headers: serviceHeaders() },
  );
  if (!res.ok) {
    throw new Error(`Failed to load agentic interface (${res.status})`);
  }
  const rows = await res.json() as AgenticInterfaceRow[];
  return rows[0] ?? null;
}

export async function listAgenticInterfaces(
  userId: string,
): Promise<{ interfaces: AgenticInterfaceSummary[] }> {
  const { SUPABASE_URL } = getSupabaseEnv();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_agentic_interfaces?user_id=eq.${userId}&deleted_at=is.null&select=${SELECT_COLUMNS}&order=updated_at.desc,interface_key.asc`,
    { headers: serviceHeaders() },
  );
  if (!res.ok) {
    throw new Error(`Failed to list agentic interfaces (${res.status})`);
  }
  const rows = await res.json() as AgenticInterfaceRow[];
  return { interfaces: rows.map(summarizeRow) };
}

export async function getAgenticInterface(
  userId: string,
  interfaceKeyInput: unknown,
  dependencies: AgenticInterfaceStorageDependencies = {},
): Promise<StoredAgenticInterface> {
  const interfaceKey = normalizeInterfaceKey(interfaceKeyInput);
  const row = await fetchInterfaceRow(userId, interfaceKey);
  if (!row) throw new Error(`Agentic interface "${interfaceKey}" not found`);
  return await storedFromRow(userId, row, dependencies);
}

export async function saveAgenticInterface(
  userId: string,
  input: AgenticInterfaceStorageInput,
  dependencies: AgenticInterfaceStorageDependencies = {},
): Promise<StoredAgenticInterface> {
  if (input.spec === undefined) throw new Error("spec is required");
  const verification = await verifySpecForUser(userId, input.spec, dependencies);
  const spec = verification.spec;
  const interfaceKey = input.interface_key === undefined
    ? slugifyKey(input.title ?? spec.title, spec.id || "interface")
    : normalizeInterfaceKey(input.interface_key);
  const metadata = metadataForInput(input, interfaceKey, spec);
  const now = (dependencies.now || (() => new Date()))().toISOString();
  const { SUPABASE_URL } = getSupabaseEnv();

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_agentic_interfaces?on_conflict=user_id,interface_key`,
    {
      method: "POST",
      headers: serviceHeaders("resolution=merge-duplicates,return=representation"),
      body: JSON.stringify({
        user_id: userId,
        interface_key: interfaceKey,
        ...metadata,
        mode: "saved",
        spec,
        deleted_at: null,
        updated_at: now,
      }),
    },
  );
  if (!res.ok) {
    const message = await res.text().catch(() => res.statusText);
    throw new Error(
      `Failed to save agentic interface (${res.status}): ${message}`,
    );
  }

  const rows = await res.json() as AgenticInterfaceRow[];
  const row = rows[0];
  if (!row) {
    throw new Error("Saved agentic interface response was empty");
  }
  return await storedFromRow(userId, row, dependencies, verification);
}

export async function updateAgenticInterface(
  userId: string,
  interfaceKeyInput: unknown,
  input: AgenticInterfaceStorageInput,
  dependencies: AgenticInterfaceStorageDependencies = {},
): Promise<StoredAgenticInterface> {
  const interfaceKey = normalizeInterfaceKey(interfaceKeyInput);
  const existing = await fetchInterfaceRow(userId, interfaceKey);
  if (!existing) throw new Error(`Agentic interface "${interfaceKey}" not found`);

  const verification = input.spec === undefined
    ? await verifySpecForUser(userId, existing.spec, dependencies)
    : await verifySpecForUser(userId, input.spec, dependencies);
  const spec = verification.spec;
  const has = (field: keyof AgenticInterfaceStorageInput) =>
    Object.prototype.hasOwnProperty.call(input, field);
  const metadata = metadataForInput(
    {
      title: has("title") ? input.title : existing.title,
      description: has("description") ? input.description : existing.description,
      icon: has("icon") ? input.icon : existing.icon,
      source_prompt: has("source_prompt") ? input.source_prompt : existing.source_prompt,
      status: has("status") ? input.status : existing.status,
    },
    interfaceKey,
    spec,
  );
  const now = (dependencies.now || (() => new Date()))().toISOString();
  const { SUPABASE_URL } = getSupabaseEnv();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_agentic_interfaces?user_id=eq.${userId}&interface_key=eq.${
      encodeURIComponent(interfaceKey)
    }&deleted_at=is.null`,
    {
      method: "PATCH",
      headers: serviceHeaders("return=representation"),
      body: JSON.stringify({
        ...metadata,
        spec,
        mode: "saved",
        updated_at: now,
      }),
    },
  );
  if (!res.ok) {
    const message = await res.text().catch(() => res.statusText);
    throw new Error(
      `Failed to update agentic interface (${res.status}): ${message}`,
    );
  }
  const rows = await res.json() as AgenticInterfaceRow[];
  const row = rows[0];
  if (!row) {
    throw new Error("Updated agentic interface response was empty");
  }
  return await storedFromRow(userId, row, dependencies, verification);
}

export async function deleteAgenticInterface(
  userId: string,
  interfaceKeyInput: unknown,
  dependencies: Pick<AgenticInterfaceStorageDependencies, "now"> = {},
): Promise<{ ok: true; interface_key: string }> {
  const interfaceKey = normalizeInterfaceKey(interfaceKeyInput);
  const now = (dependencies.now || (() => new Date()))().toISOString();
  const { SUPABASE_URL } = getSupabaseEnv();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_agentic_interfaces?user_id=eq.${userId}&interface_key=eq.${
      encodeURIComponent(interfaceKey)
    }&deleted_at=is.null`,
    {
      method: "PATCH",
      headers: serviceHeaders("return=minimal"),
      body: JSON.stringify({
        status: "archived",
        deleted_at: now,
        updated_at: now,
      }),
    },
  );
  if (!res.ok) {
    const message = await res.text().catch(() => res.statusText);
    throw new Error(
      `Failed to delete agentic interface (${res.status}): ${message}`,
    );
  }
  return { ok: true, interface_key: interfaceKey };
}
