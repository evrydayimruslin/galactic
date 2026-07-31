// Promotion-time authority diff for versions staged by connected builders.
//
// A builder may freely change implementation code, functions, descriptions,
// and other non-authority metadata. Expanding what the live Agent can reach,
// expose, schedule, or do with stored credentials remains an owner-session
// decision. This comparison is deliberately conservative at those boundaries.

import { resolveManifestEnvSchema } from "../../shared/contracts/manifest.ts";
import { normalizeManifestComputeConfig } from "../../shared/contracts/compute.ts";
import {
  GALACTIC_STABLE_EFFECT_IDS,
  type GalacticAuthorityLevel,
  galacticAuthorityLevelCoversEffects,
} from "./galactic-agent-document.ts";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function parseManifest(value: unknown): JsonRecord | null {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return asRecord(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = asRecord(value);
  if (record) {
    return `{${
      Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(record[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value) ?? "null";
}

function stringSet(value: unknown): Set<string> {
  return new Set(
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [],
  );
}

const GALACTIC_STABLE_EFFECT_SET = new Set<string>(
  GALACTIC_STABLE_EFFECT_IDS,
);

type FunctionEffectPolicy = "ask" | "free";

interface FunctionAuthoritySnapshot {
  hasSurface: boolean;
  effects: Map<string, FunctionEffectPolicy>;
  invalidFunctions: Set<string>;
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function hasFunctionAuthoritySurface(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => {
      const fn = asRecord(entry);
      return fn ? hasOwn(fn, "authority") : false;
    });
  }
  const functions = asRecord(value);
  if (!functions) return false;
  return Object.values(functions).some((entry) => {
    const fn = asRecord(entry);
    return fn ? hasOwn(fn, "authority") : false;
  });
}

/**
 * Normalize only the authority fields that can mint Galactic runtime effects.
 *
 * Once any function opts into the authority surface, the runtime treats every
 * function as authority-scoped. Missing or malformed declarations therefore
 * belong on the owner-review boundary instead of silently falling back to the
 * legacy app-level permission union.
 */
function functionAuthoritySnapshot(
  manifest: JsonRecord,
): FunctionAuthoritySnapshot {
  const hasSurface = hasFunctionAuthoritySurface(manifest.functions);
  const effects = new Map<string, FunctionEffectPolicy>();
  const invalidFunctions = new Set<string>();
  if (!hasSurface) return { hasSurface, effects, invalidFunctions };

  const functions = asRecord(manifest.functions);
  if (!functions) {
    invalidFunctions.add("*");
    return { hasSurface, effects, invalidFunctions };
  }

  for (const [functionName, rawDeclaration] of Object.entries(functions)) {
    const declaration = asRecord(rawDeclaration);
    if (!declaration || !hasOwn(declaration, "authority")) {
      invalidFunctions.add(functionName);
      continue;
    }
    const authority = asRecord(declaration.authority);
    if (!authority) {
      invalidFunctions.add(functionName);
      continue;
    }
    const hasUnknownKey = Object.keys(authority).some((key) =>
      key !== "level" && key !== "effects" &&
      (!key.startsWith("x-") || key.length <= 2)
    );
    const level = authority.level;
    const levelValid = level === "read" || level === "internal_write" ||
      level === "external_write";
    const rawEffects = asRecord(authority.effects);
    if (hasUnknownKey || !levelValid || !rawEffects) {
      invalidFunctions.add(functionName);
      continue;
    }

    const stableEffects: Array<[string, FunctionEffectPolicy]> = [];
    let effectsValid = true;
    for (const [effect, policy] of Object.entries(rawEffects)) {
      if (policy !== "ask" && policy !== "free") {
        effectsValid = false;
        break;
      }
      if (GALACTIC_STABLE_EFFECT_SET.has(effect)) {
        stableEffects.push([effect, policy]);
      } else if (!effect.startsWith("x-") || effect.length <= 2) {
        effectsValid = false;
        break;
      }
    }
    if (
      !effectsValid ||
      !galacticAuthorityLevelCoversEffects(
        level as GalacticAuthorityLevel,
        stableEffects.map(([effect]) => effect),
      )
    ) {
      invalidFunctions.add(functionName);
      continue;
    }
    for (const [effect, policy] of stableEffects) {
      effects.set(`${functionName}\0${effect}`, policy);
    }
  }

  return { hasSurface, effects, invalidFunctions };
}

function addFunctionAuthorityExpansions(
  output: string[],
  currentManifest: JsonRecord,
  targetManifest: JsonRecord,
): void {
  const current = functionAuthoritySnapshot(currentManifest);
  const target = functionAuthoritySnapshot(targetManifest);
  if (!current.hasSurface && !target.hasSurface) return;

  if (current.hasSurface && !target.hasSurface) {
    // Removing the function-level surface restores the legacy app-wide
    // permission union, which can grant every function every app capability.
    output.push("functions.authority:removed");
    return;
  }

  for (const functionName of target.invalidFunctions) {
    output.push(`functions.authority.invalid:${functionName}`);
  }

  for (const [pair, targetPolicy] of target.effects) {
    const currentPolicy = current.effects.get(pair);
    if (!currentPolicy) {
      output.push(`functions.authority:${pair}`);
    } else if (currentPolicy === "ask" && targetPolicy === "free") {
      output.push(`functions.authority.free:${pair}`);
    }
  }
}

function networkHosts(manifest: JsonRecord): Set<string> {
  const network = asRecord(manifest.network);
  const destinations = Array.isArray(network?.allowed_destinations)
    ? network.allowed_destinations
    : [];
  const hosts = destinations.flatMap((destination) => {
    if (typeof destination === "string") return [destination];
    const host = asRecord(destination)?.host;
    return typeof host === "string" ? [host] : [];
  });
  return new Set(hosts.map((host) => host.trim().toLowerCase()));
}

function externalFunctionAuthorities(manifest: JsonRecord): Set<string> {
  const declarations = Array.isArray(manifest.external_functions)
    ? manifest.external_functions
    : [];
  const authorities: string[] = [];
  for (const declaration of declarations) {
    const record = asRecord(declaration);
    if (!record || typeof record.app !== "string") continue;
    const access = typeof record.access === "string" ? record.access : "read";
    for (const fn of stringSet(record.functions)) {
      authorities.push(`${record.app.trim()}\u0000${access}\u0000${fn}`);
    }
  }
  return new Set(authorities);
}

function interfaceAuthorities(manifest: JsonRecord): Set<string> {
  const declarations = Array.isArray(manifest.interfaces)
    ? manifest.interfaces
    : [];
  const authorities: string[] = [];
  for (const declaration of declarations) {
    const record = asRecord(declaration);
    if (!record || typeof record.id !== "string") continue;
    for (const fn of stringSet(record.functions)) {
      authorities.push(`${record.id.trim()}\u0000${fn}`);
    }
  }
  return new Set(authorities);
}

function widgetDependencyAuthorities(manifest: JsonRecord): Set<string> {
  const authorities: string[] = [];

  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const dependency of value) {
      const record = asRecord(dependency);
      if (!record || typeof record.app !== "string") continue;
      const app = record.app.trim();
      if (!app) continue;
      const access = typeof record.access === "string" ? record.access : "read";
      for (const fn of stringSet(record.functions)) {
        const functionName = fn.trim();
        if (functionName) {
          authorities.push(`${app}\u0000${access}\u0000${functionName}`);
        }
      }
    }
  };

  if (!Array.isArray(manifest.widgets)) return new Set();
  for (const widget of manifest.widgets) {
    const record = asRecord(widget);
    if (!record) continue;
    collect(record.dependencies);
    if (!Array.isArray(record.cards)) continue;
    for (const card of record.cards) {
      collect(asRecord(card)?.dependencies);
    }
  }

  return new Set(authorities);
}

function computeCallerAuthorities(manifest: JsonRecord): Set<string> {
  const functions = asRecord(manifest.functions) ?? {};
  return new Set(
    Object.entries(functions)
      .filter(([, declaration]) => asRecord(declaration)?.uses_compute === true)
      .map(([functionName]) => functionName),
  );
}

function readablePerUserEnvKeys(manifest: JsonRecord): Set<string> {
  const schema = resolveManifestEnvSchema(manifest);
  return new Set(
    Object.entries(schema)
      .filter(([, entry]) =>
        entry.scope === "per_user" &&
        entry.input !== "password" &&
        !entry.credential
      )
      .map(([key]) => key),
  );
}

function perUserEnvKeys(manifest: JsonRecord): Set<string> {
  const schema = resolveManifestEnvSchema(manifest);
  return new Set(
    Object.entries(schema)
      .filter(([, entry]) => entry.scope === "per_user")
      .map(([key]) => key),
  );
}

function credentialBindings(manifest: JsonRecord): Map<string, string> {
  const combined = {
    ...(asRecord(manifest.env) || {}),
    ...(asRecord(manifest.env_vars) || {}),
  };
  const bindings = new Map<string, string>();
  for (const [key, value] of Object.entries(combined)) {
    const credential = asRecord(value)?.credential;
    if (credential !== undefined) {
      bindings.set(key, canonicalJson(credential));
    }
  }
  return bindings;
}

function positiveLimit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : Number.POSITIVE_INFINITY;
}

function addSetExpansions(
  output: string[],
  path: string,
  before: Set<string>,
  after: Set<string>,
): void {
  for (const authority of after) {
    if (!before.has(authority)) output.push(`${path}:${authority}`);
  }
}

/**
 * Return human-readable authority paths introduced by `targetManifest`.
 * An empty array means promotion is safe for a scoped builder credential.
 * Invalid or absent manifests fail closed at the caller, not in this helper.
 */
export function findManifestAuthorityExpansions(
  currentManifest: unknown,
  targetManifest: unknown,
): string[] {
  const current = parseManifest(currentManifest) || {};
  const target = parseManifest(targetManifest) || {};
  const expansions: string[] = [];

  addSetExpansions(
    expansions,
    "permissions",
    stringSet(current.permissions),
    stringSet(target.permissions),
  );
  addFunctionAuthorityExpansions(expansions, current, target);

  const currentCompute = normalizeManifestComputeConfig(current.compute);
  const targetCompute = normalizeManifestComputeConfig(target.compute);
  if (
    targetCompute &&
    currentCompute?.profile !== targetCompute.profile
  ) {
    expansions.push(`compute.profile:${targetCompute.profile}`);
  }
  addSetExpansions(
    expansions,
    "compute.tools",
    new Set(currentCompute?.tools || []),
    new Set(targetCompute?.tools || []),
  );
  addSetExpansions(
    expansions,
    "compute.secrets",
    new Set(currentCompute?.secrets || []),
    new Set(targetCompute?.secrets || []),
  );
  // Per-function uses_compute is part of the execution principal. Once an
  // owner has approved the Agent-level ceiling, adding a new caller would
  // otherwise let a scoped builder activate that ceiling for new code without
  // owner promotion.
  addSetExpansions(
    expansions,
    "compute.callers",
    computeCallerAuthorities(current),
    computeCallerAuthorities(target),
  );
  addSetExpansions(
    expansions,
    "network.allowed_destinations",
    networkHosts(current),
    networkHosts(target),
  );
  addSetExpansions(
    expansions,
    "external_functions",
    externalFunctionAuthorities(current),
    externalFunctionAuthorities(target),
  );
  addSetExpansions(
    expansions,
    "interfaces.functions",
    interfaceAuthorities(current),
    interfaceAuthorities(target),
  );
  addSetExpansions(
    expansions,
    "widgets.dependencies",
    widgetDependencyAuthorities(current),
    widgetDependencyAuthorities(target),
  );

  // Abstract imports do not activate grants themselves, but changing the
  // requested wiring is an owner-reviewed responsibility change.
  if (
    canonicalJson(current.imports ?? {}) !== canonicalJson(target.imports ?? {})
  ) {
    expansions.push("imports");
  }

  // Manifest routines encode mission, cadence, capabilities, approval policy,
  // and budget defaults. Any change belongs on the owner approval surface.
  if (
    canonicalJson(current.routines ?? []) !==
      canonicalJson(target.routines ?? [])
  ) {
    expansions.push("routines");
  }

  if (
    canonicalJson(current.http ?? null) !== canonicalJson(target.http ?? null)
  ) {
    expansions.push("http");
  }
  if (
    canonicalJson(current.access_policy ?? null) !==
      canonicalJson(target.access_policy ?? null)
  ) {
    expansions.push("access_policy");
  }

  const currentCredentials = credentialBindings(current);
  for (const [key, binding] of credentialBindings(target)) {
    if (currentCredentials.get(key) !== binding) {
      expansions.push(`env_vars.${key}.credential`);
    }
  }

  // A retained user_app_secrets row can outlive an old manifest version. A
  // newly declared per-user key can therefore reactivate stored data even if
  // the new declaration is still vaulted, so the owner must review it.
  addSetExpansions(
    expansions,
    "env_vars.per_user",
    perUserEnvKeys(current),
    perUserEnvKeys(target),
  );

  // Per-user values classified as password/credential inputs stay in the
  // parent-side vault. Reclassifying one as ordinary config injects the
  // already-stored plaintext into the sandbox, which is an authority increase
  // even when no new key or credential declaration was added.
  addSetExpansions(
    expansions,
    "env_vars.readable_per_user",
    readablePerUserEnvKeys(current),
    readablePerUserEnvKeys(target),
  );

  const currentRate = asRecord(current.rate_limit) || {};
  const targetRate = asRecord(target.rate_limit) || {};
  for (const field of ["calls_per_minute", "calls_per_day"]) {
    if (positiveLimit(targetRate[field]) > positiveLimit(currentRate[field])) {
      expansions.push(`rate_limit.${field}`);
    }
  }

  if (current.flight_recorder === true && target.flight_recorder !== true) {
    expansions.push("flight_recorder");
  }

  return [...new Set(expansions)].sort();
}

export interface ManifestAuthorityChange {
  change: "added" | "removed" | "changed";
  path: string;
  label: string;
}

function publicAuthorityPath(value: string): string {
  return value
    .replaceAll("\0", ".")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .slice(0, 240);
}

function authorityChangeLabel(path: string): string {
  return publicAuthorityPath(path)
    .replaceAll("_", " ")
    .replace(/\.+/gu, " › ")
    .replace(":", " › ");
}

/**
 * Symmetric, sanitized owner-facing authority delta. The enforcement helper
 * above intentionally returns internal canonical keys; this projection never
 * exposes their NUL separators and distinguishes expansion from removal.
 */
export function summarizeManifestAuthorityChanges(
  currentManifest: unknown,
  targetManifest: unknown,
): ManifestAuthorityChange[] {
  const added = new Set(
    findManifestAuthorityExpansions(currentManifest, targetManifest).map(
      publicAuthorityPath,
    ),
  );
  const removed = new Set(
    findManifestAuthorityExpansions(targetManifest, currentManifest).map(
      publicAuthorityPath,
    ),
  );
  const paths = [...new Set([...added, ...removed])].sort();
  return paths.map((path) => ({
    change: added.has(path) && removed.has(path)
      ? "changed"
      : added.has(path)
      ? "added"
      : "removed",
    path,
    label: authorityChangeLabel(path),
  }));
}
