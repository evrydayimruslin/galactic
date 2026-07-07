// Galactic Deno Runtime
// Sandboxed execution with pre-bundled stdlib

import type {
  D1ExecResult,
  D1RunResult,
  LogEntry,
} from "../../shared/types/index.ts";
import { formatLight } from "../../shared/types/index.ts";
import type { AIRequest, AIResponse } from "../../shared/contracts/ai.ts";
import type { ResolvedCredential } from "../../shared/contracts/env.ts";
import type { BillingConfig } from "../services/billing-config.ts";
import type { D1DataService } from "../services/d1-data.ts";
import type { D1TestFixtureConfig } from "../services/d1-test-fixtures.ts";
import type { CloudOperationMeteringContext } from "../services/cloud-usage.ts";
import { buildEconomicIdempotencyKey } from "../services/economic-idempotency.ts";
import { mintSandboxAuthToken } from "../services/sandbox-actor.ts";

// User context passed to apps (subset of full user, safe to expose)
export interface UserContext {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  tier: string;
  provisional?: boolean;
}

export interface RuntimeConfig {
  appId: string;
  userId: string;
  ownerId: string;
  // The app's DB current_version. When set, the executed-bundle verify rejects a
  // live bundle whose signed attestation is for a different (e.g. downgraded)
  // version. Optional: paths that don't supply it skip the version check.
  expectedVersion?: string;
  executionId: string;
  code: string;
  permissions: string[];
  // Default-deny egress allowlist (manifest network.allowed_destinations as
  // canonical hosts). Undefined is treated as [] in the sandbox — no outbound.
  allowedDestinations?: string[];
  // Per-user secrets, decrypted, keyed by env var name (Phase 3 vault). Consumed
  // ONLY host-side by the CredentialBinding / NET binding — NEVER stringified
  // into the sandbox. The sandbox references these by key, never by value.
  credentials?: Record<string, ResolvedCredential>;
  userApiKey: string | null;
  aiRoute?: RuntimeAIRoute | null;
  // Why env.AI is unavailable when aiRoute is null (balance gate, no user,
  // route error) — surfaced verbatim to sandboxed ultralight.ai() callers.
  aiUnavailableReason?: string | null;
  // Authenticated user context (null if anonymous)
  user: UserContext | null;
  // App data storage (R2-based, zero config) — LEGACY, kept for internal R2 ops
  appDataService: AppDataService;
  // D1 relational data service (per-app, lazy-provisioned)
  d1DataService: D1DataService | null;
  // Fixture-backed D1 responses for ul.test without a live database
  d1Fixtures?: D1TestFixtureConfig | null;
  // User memory (for unified Memory.md - optional, can be null)
  memoryService: MemoryService | null;
  aiService: AIService;
  // Decrypted environment variables (injected as ultralight.env)
  envVars: Record<string, string>;
  // Supabase configuration (decrypted)
  supabase?: {
    url: string;
    anonKey: string;
    serviceKey?: string;
  };
  // Inter-app calls: base URL for calling other apps via MCP.
  baseUrl?: string;
  // The caller's raw bearer. SECURITY: this must NOT be injected into the
  // sandbox — app code can read injected values (e.g. via .toString()). The
  // runtime mints a short-lived, app-scoped sandbox actor token
  // (mintSandboxAuthToken) for ultralight.call instead; this field is retained
  // only as incoming request context and is no longer read by either sandbox.
  authToken?: string;
  appCallDependencies?: RuntimeAppCallDependency[];
  // Signed caller-context token (X-Galactic-Caller) minted server-side so a
  // cross-Agent call can prove WHO is calling without trusting sandbox code.
  // Asserts only the caller's OWN app id, so an app reading it cannot forge a
  // different caller.
  callerContextToken?: string;
  // Logical slot -> concrete target bindings for ultralight.use(slot).
  slotBindings?: Array<{ slot: string; targetAppId: string; functions: string[] }>;
  // Internal service auth for TCP protocol endpoints (/api/net/*)
  workerSecret?: string;
  // Worker's direct URL (not CDN) for internal fetch calls from Dynamic Workers
  workerBaseUrl?: string;
  // Per-execution timeout override (default: 30s, max: 120s)
  timeoutMs?: number;
  // Runtime R2/KV operation payer selected during cloud usage preflight.
  cloudOperationMetering?: CloudOperationMeteringContext | null;
  cloudOperationBillingConfig?:
    | Pick<
      BillingConfig,
      | "version"
      | "cloudUnitLightPer1k"
      | "r2OpsPerCloudUnit"
      | "kvOpsPerCloudUnit"
      | "d1ReadRowsPerCloudUnit"
      | "d1WriteRowsPerCloudUnit"
    >
    | null;
}

export interface RuntimeAppCallDependency {
  app: string;
  functions: string[];
  access?: "read" | "write";
}

export interface RuntimeAIRoute {
  provider: string;
  upstreamProvider?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  canonicalModelId?: string;
  billingModelId?: string;
  billingSource?: string;
  requestDefaults?: Record<string, unknown>;
  shouldDebitLight: boolean;
  // Metered (credits) route: re-check the wallet before EVERY ai() call so a
  // buyer cannot fan out many galactic.ai() calls in one execution and outspend
  // their balance. BYOK routes set this false. Mirrors ResolvedInferenceRoute.
  shouldRequireBalance: boolean;
}

interface RpcToolCallEnvelope {
  result?: {
    content?: Array<{ type: string; text?: string }>;
  };
  error?: {
    message?: string;
  };
}

function appCallAllowedByDependency(
  dependencies: RuntimeAppCallDependency[] | undefined,
  targetAppId: string,
  functionName: string,
): boolean {
  const normalizedTarget = targetAppId.trim();
  const normalizedFunction = functionName.trim();
  if (!normalizedTarget || !normalizedFunction) return false;

  return (dependencies || []).some((dependency) => {
    if (
      dependency.access !== undefined &&
      dependency.access !== "read" &&
      dependency.access !== "write"
    ) {
      return false;
    }
    if (dependency.app.trim() !== normalizedTarget) return false;
    return dependency.functions.some((fn) => fn.trim() === normalizedFunction);
  });
}

export interface AppDataService {
  store(key: string, value: unknown): Promise<void>;
  load(key: string): Promise<unknown>;
  remove(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
  // Query helpers
  query(prefix: string, options?: QueryOptions): Promise<QueryResult[]>;
  batchStore(items: Array<{ key: string; value: unknown }>): Promise<void>;
  batchLoad(keys: string[]): Promise<Array<{ key: string; value: unknown }>>;
  batchRemove(keys: string[]): Promise<void>;
}

export interface QueryOptions {
  filter?: (value: unknown) => boolean;
  sort?: { field: string; order: "asc" | "desc" };
  limit?: number;
  offset?: number;
}

export interface QueryResult {
  key: string;
  value: unknown;
  updatedAt?: string;
}

export interface MemoryService {
  remember(key: string, value: unknown): Promise<void>;
  recall(key: string): Promise<unknown>;
}

export interface AIService {
  call(request: AIRequest, apiKey: string): Promise<AIResponse>;
}

export interface ExecutionResult {
  success: boolean;
  result: unknown;
  logs: LogEntry[];
  durationMs: number;
  aiCostLight: number;
  error?: {
    type: string;
    message: string;
    stack?: string;
  };
  // sha256 of the Worker Loader reuse key — set ONLY when the execution ran on
  // the warm-reuse (loader.get) path. Cloudflare bills ~one Dynamic Worker load
  // per unique worker (= reuse key + code) per UTC day, resetting daily, so the
  // per-day load-floor dedup keys on THIS hash: the floor is charged once per
  // DISTINCT isolate-identity per day, tracking CF's meter even when a user
  // churns creds/BYOK/model/env and mints several isolates in one day. Absent
  // on the load() path (each call is its own CF unit → per-call floor).
  reuseKeyHash?: string;
}

// ============================================
// PRE-BUNDLED STDLIB
// These are available globally in user code
// ============================================

/**
 * UUID v4 generator (simple implementation)
 */
const uuid = {
  v4: (): string => {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === "x" ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  },
};

/**
 * Base64 encoding/decoding
 */
const base64 = {
  encode: (str: string): string => {
    return btoa(unescape(encodeURIComponent(str)));
  },
  decode: (str: string): string => {
    return decodeURIComponent(escape(atob(str)));
  },
  encodeBytes: (bytes: Uint8Array): string => {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  },
  decodeBytes: (str: string): Uint8Array => {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  },
};

/**
 * Simple hash functions using Web Crypto API
 */
const hash = {
  sha256: async (data: string): Promise<string> => {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest("SHA-256", dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  },
  sha512: async (data: string): Promise<string> => {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest("SHA-512", dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  },
  md5: (data: string): string => {
    // Simple MD5 for non-cryptographic use (checksums, etc)
    // For security, use sha256/sha512
    return simpleHash(data);
  },
};

// Simple non-crypto hash for MD5-like use cases
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

/**
 * Lodash-like utilities (subset of most common functions)
 */
const _ = {
  // Arrays
  chunk: <T>(arr: T[], size: number): T[][] => {
    const result: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      result.push(arr.slice(i, i + size));
    }
    return result;
  },
  compact: <T>(arr: (T | null | undefined | false | 0 | "")[]): T[] => {
    return arr.filter(Boolean) as T[];
  },
  uniq: <T>(arr: T[]): T[] => [...new Set(arr)],
  flatten: <T>(arr: (T | T[])[]): T[] => arr.flat() as T[],
  flattenDeep: (arr: unknown[]): unknown[] => arr.flat(Infinity),
  first: <T>(arr: T[]): T | undefined => arr[0],
  last: <T>(arr: T[]): T | undefined => arr[arr.length - 1],
  take: <T>(arr: T[], n: number): T[] => arr.slice(0, n),
  drop: <T>(arr: T[], n: number): T[] => arr.slice(n),
  shuffle: <T>(arr: T[]): T[] => {
    const result = [...arr];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  },
  sample: <T>(arr: T[]): T | undefined =>
    arr[Math.floor(Math.random() * arr.length)],
  sampleSize: <T>(arr: T[], n: number): T[] => _.shuffle(arr).slice(0, n),
  sortBy: <T>(arr: T[], key: keyof T | ((item: T) => unknown)): T[] => {
    return [...arr].sort((a, b) => {
      const aVal = typeof key === "function" ? key(a) : a[key];
      const bVal = typeof key === "function" ? key(b) : b[key];
      if ((aVal as number | string) < (bVal as number | string)) return -1;
      if ((aVal as number | string) > (bVal as number | string)) return 1;
      return 0;
    });
  },
  groupBy: <T>(
    arr: T[],
    key: keyof T | ((item: T) => string),
  ): Record<string, T[]> => {
    return arr.reduce((acc, item) => {
      const groupKey = typeof key === "function"
        ? key(item)
        : String(item[key]);
      (acc[groupKey] = acc[groupKey] || []).push(item);
      return acc;
    }, {} as Record<string, T[]>);
  },
  keyBy: <T>(
    arr: T[],
    key: keyof T | ((item: T) => string),
  ): Record<string, T> => {
    return arr.reduce((acc, item) => {
      const k = typeof key === "function" ? key(item) : String(item[key]);
      acc[k] = item;
      return acc;
    }, {} as Record<string, T>);
  },
  partition: <T>(arr: T[], predicate: (item: T) => boolean): [T[], T[]] => {
    const pass: T[] = [];
    const fail: T[] = [];
    arr.forEach((item) => (predicate(item) ? pass : fail).push(item));
    return [pass, fail];
  },

  // Objects
  pick: <T extends object, K extends keyof T>(
    obj: T,
    keys: K[],
  ): Pick<T, K> => {
    const result = {} as Pick<T, K>;
    keys.forEach((key) => {
      if (key in obj) result[key] = obj[key];
    });
    return result;
  },
  omit: <T extends object, K extends keyof T>(
    obj: T,
    keys: K[],
  ): Omit<T, K> => {
    const result = { ...obj };
    keys.forEach((key) => delete (result as T)[key]);
    return result as Omit<T, K>;
  },
  get: (obj: unknown, path: string, defaultValue?: unknown): unknown => {
    const keys = path.split(".");
    let result = obj;
    for (const key of keys) {
      if (result == null) return defaultValue;
      result = (result as Record<string, unknown>)[key];
    }
    return result ?? defaultValue;
  },
  set: <T extends object>(obj: T, path: string, value: unknown): T => {
    const keys = path.split(".");
    let current = obj as Record<string, unknown>;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!(keys[i] in current)) current[keys[i]] = {};
      current = current[keys[i]] as Record<string, unknown>;
    }
    current[keys[keys.length - 1]] = value;
    return obj;
  },
  merge: <T extends object>(...objects: Partial<T>[]): T => {
    return Object.assign({}, ...objects) as T;
  },
  cloneDeep: <T>(obj: T): T => JSON.parse(JSON.stringify(obj)),
  isEmpty: (value: unknown): boolean => {
    if (value == null) return true;
    if (Array.isArray(value) || typeof value === "string") {
      return value.length === 0;
    }
    if (typeof value === "object") return Object.keys(value).length === 0;
    return false;
  },

  // Strings
  camelCase: (str: string): string => {
    return str.replace(/[-_\s]+(.)?/g, (_, c) => c ? c.toUpperCase() : "");
  },
  snakeCase: (str: string): string => {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
      .replace(/^_/, "");
  },
  kebabCase: (str: string): string => {
    return str.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
      .replace(/^-/, "");
  },
  capitalize: (str: string): string =>
    str.charAt(0).toUpperCase() + str.slice(1),
  truncate: (str: string, length: number, end = "..."): string => {
    return str.length <= length ? str : str.slice(0, length - end.length) + end;
  },

  // Functions
  debounce: <T extends (...args: unknown[]) => unknown>(
    fn: T,
    wait: number,
  ): T => {
    let timeout: number | undefined;
    return ((...args: unknown[]) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn(...args), wait) as unknown as number;
    }) as T;
  },
  throttle: <T extends (...args: unknown[]) => unknown>(
    fn: T,
    wait: number,
  ): T => {
    let lastCall = 0;
    return ((...args: unknown[]) => {
      const now = Date.now();
      if (now - lastCall >= wait) {
        lastCall = now;
        return fn(...args);
      }
    }) as T;
  },

  // Numbers
  random: (min: number, max: number): number =>
    Math.floor(Math.random() * (max - min + 1)) + min,
  clamp: (num: number, min: number, max: number): number =>
    Math.min(Math.max(num, min), max),
  sum: (arr: number[]): number => arr.reduce((a, b) => a + b, 0),
  mean: (arr: number[]): number => arr.length ? _.sum(arr) / arr.length : 0,
  min: (arr: number[]): number => Math.min(...arr),
  max: (arr: number[]): number => Math.max(...arr),

  // Predicates
  isString: (value: unknown): value is string => typeof value === "string",
  isNumber: (value: unknown): value is number =>
    typeof value === "number" && !isNaN(value),
  isBoolean: (value: unknown): value is boolean => typeof value === "boolean",
  isArray: Array.isArray,
  isObject: (value: unknown): value is object =>
    value !== null && typeof value === "object" && !Array.isArray(value),
  isFunction: (value: unknown): value is Function =>
    typeof value === "function",
  isNil: (value: unknown): value is null | undefined => value == null,
};

/**
 * Date formatting utilities (date-fns style)
 */
const dateFns = {
  format: (date: Date | string | number, formatStr: string): string => {
    const d = new Date(date);
    const pad = (n: number) => n.toString().padStart(2, "0");

    const tokens: Record<string, string> = {
      "yyyy": d.getFullYear().toString(),
      "yy": d.getFullYear().toString().slice(-2),
      "MM": pad(d.getMonth() + 1),
      "M": (d.getMonth() + 1).toString(),
      "dd": pad(d.getDate()),
      "d": d.getDate().toString(),
      "HH": pad(d.getHours()),
      "H": d.getHours().toString(),
      "hh": pad(d.getHours() % 12 || 12),
      "h": (d.getHours() % 12 || 12).toString(),
      "mm": pad(d.getMinutes()),
      "m": d.getMinutes().toString(),
      "ss": pad(d.getSeconds()),
      "s": d.getSeconds().toString(),
      "a": d.getHours() < 12 ? "am" : "pm",
      "A": d.getHours() < 12 ? "AM" : "PM",
      "EEEE": [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ][d.getDay()],
      "EEE": ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()],
      "MMMM": [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ][d.getMonth()],
      "MMM": [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ][d.getMonth()],
    };

    let result = formatStr;
    // Sort by length descending to match longer tokens first
    Object.keys(tokens).sort((a, b) => b.length - a.length).forEach((token) => {
      result = result.replace(new RegExp(token, "g"), tokens[token]);
    });
    return result;
  },

  formatDistance: (
    date: Date | string | number,
    baseDate: Date | string | number = new Date(),
  ): string => {
    const d = new Date(date);
    const base = new Date(baseDate);
    const diff = Math.abs(d.getTime() - base.getTime());

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const months = Math.floor(days / 30);
    const years = Math.floor(days / 365);

    if (years > 0) return `${years} year${years > 1 ? "s" : ""} ago`;
    if (months > 0) return `${months} month${months > 1 ? "s" : ""} ago`;
    if (days > 0) return `${days} day${days > 1 ? "s" : ""} ago`;
    if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
    if (minutes > 0) return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
    return "just now";
  },

  addDays: (date: Date | string | number, days: number): Date => {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  },

  addHours: (date: Date | string | number, hours: number): Date => {
    const d = new Date(date);
    d.setHours(d.getHours() + hours);
    return d;
  },

  addMinutes: (date: Date | string | number, minutes: number): Date => {
    const d = new Date(date);
    d.setMinutes(d.getMinutes() + minutes);
    return d;
  },

  startOfDay: (date: Date | string | number): Date => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  },

  endOfDay: (date: Date | string | number): Date => {
    const d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
  },

  isAfter: (
    date: Date | string | number,
    dateToCompare: Date | string | number,
  ): boolean => {
    return new Date(date) > new Date(dateToCompare);
  },

  isBefore: (
    date: Date | string | number,
    dateToCompare: Date | string | number,
  ): boolean => {
    return new Date(date) < new Date(dateToCompare);
  },

  isToday: (date: Date | string | number): boolean => {
    const d = new Date(date);
    const today = new Date();
    return d.toDateString() === today.toDateString();
  },

  parseISO: (dateString: string): Date => new Date(dateString),
};

/**
 * Simple schema validation (Zod-like API)
 * Not a full Zod implementation, but covers common use cases
 */
const schema = {
  string: () => new StringSchema(),
  number: () => new NumberSchema(),
  boolean: () => new BooleanSchema(),
  array: <T>(itemSchema: BaseSchema<T>) => new ArraySchema(itemSchema),
  object: <T extends Record<string, BaseSchema<unknown>>>(shape: T) =>
    new ObjectSchema(shape),
  optional: <T>(innerSchema: BaseSchema<T>) => new OptionalSchema(innerSchema),
  union: <T extends BaseSchema<unknown>[]>(...schemas: T) =>
    new UnionSchema(schemas),
  literal: <T extends string | number | boolean>(value: T) =>
    new LiteralSchema(value),
  enum: <T extends string[]>(...values: T) => new EnumSchema(values),
  any: () => new AnySchema(),
};

class BaseSchema<T> {
  protected _optional = false;
  protected _default: T | undefined;

  parse(value: unknown): T {
    const result = this.safeParse(value);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.data;
  }

  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: string } {
    return { success: true, data: value as T };
  }

  optional(): OptionalSchema<T> {
    return new OptionalSchema(this);
  }

  default(defaultValue: T): this {
    this._default = defaultValue;
    return this;
  }
}

class StringSchema extends BaseSchema<string> {
  private _minLength?: number;
  private _maxLength?: number;
  private _pattern?: RegExp;
  private _email = false;
  private _url = false;

  override safeParse(
    value: unknown,
  ): { success: true; data: string } | { success: false; error: string } {
    if (value === undefined && this._default !== undefined) {
      return { success: true, data: this._default };
    }
    if (typeof value !== "string") {
      return { success: false, error: "Expected string" };
    }
    if (this._minLength !== undefined && value.length < this._minLength) {
      return {
        success: false,
        error: `String must be at least ${this._minLength} characters`,
      };
    }
    if (this._maxLength !== undefined && value.length > this._maxLength) {
      return {
        success: false,
        error: `String must be at most ${this._maxLength} characters`,
      };
    }
    if (this._pattern && !this._pattern.test(value)) {
      return { success: false, error: "String does not match pattern" };
    }
    if (this._email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return { success: false, error: "Invalid email format" };
    }
    if (this._url && !/^https?:\/\/.+/.test(value)) {
      return { success: false, error: "Invalid URL format" };
    }
    return { success: true, data: value };
  }

  min(length: number): this {
    this._minLength = length;
    return this;
  }
  max(length: number): this {
    this._maxLength = length;
    return this;
  }
  length(length: number): this {
    this._minLength = length;
    this._maxLength = length;
    return this;
  }
  regex(pattern: RegExp): this {
    this._pattern = pattern;
    return this;
  }
  email(): this {
    this._email = true;
    return this;
  }
  url(): this {
    this._url = true;
    return this;
  }
}

class NumberSchema extends BaseSchema<number> {
  private _min?: number;
  private _max?: number;
  private _int = false;

  override safeParse(
    value: unknown,
  ): { success: true; data: number } | { success: false; error: string } {
    if (value === undefined && this._default !== undefined) {
      return { success: true, data: this._default };
    }
    if (typeof value !== "number" || isNaN(value)) {
      return { success: false, error: "Expected number" };
    }
    if (this._int && !Number.isInteger(value)) {
      return { success: false, error: "Expected integer" };
    }
    if (this._min !== undefined && value < this._min) {
      return { success: false, error: `Number must be >= ${this._min}` };
    }
    if (this._max !== undefined && value > this._max) {
      return { success: false, error: `Number must be <= ${this._max}` };
    }
    return { success: true, data: value };
  }

  min(value: number): this {
    this._min = value;
    return this;
  }
  max(value: number): this {
    this._max = value;
    return this;
  }
  int(): this {
    this._int = true;
    return this;
  }
  positive(): this {
    this._min = 0;
    return this;
  }
  negative(): this {
    this._max = 0;
    return this;
  }
}

class BooleanSchema extends BaseSchema<boolean> {
  override safeParse(
    value: unknown,
  ): { success: true; data: boolean } | { success: false; error: string } {
    if (value === undefined && this._default !== undefined) {
      return { success: true, data: this._default };
    }
    if (typeof value !== "boolean") {
      return { success: false, error: "Expected boolean" };
    }
    return { success: true, data: value };
  }
}

class ArraySchema<T> extends BaseSchema<T[]> {
  private _minLength?: number;
  private _maxLength?: number;

  constructor(private itemSchema: BaseSchema<T>) {
    super();
  }

  override safeParse(
    value: unknown,
  ): { success: true; data: T[] } | { success: false; error: string } {
    if (!Array.isArray(value)) {
      return { success: false, error: "Expected array" };
    }
    if (this._minLength !== undefined && value.length < this._minLength) {
      return {
        success: false,
        error: `Array must have at least ${this._minLength} items`,
      };
    }
    if (this._maxLength !== undefined && value.length > this._maxLength) {
      return {
        success: false,
        error: `Array must have at most ${this._maxLength} items`,
      };
    }
    const results: T[] = [];
    for (let i = 0; i < value.length; i++) {
      const result = this.itemSchema.safeParse(value[i]);
      if (!result.success) {
        return { success: false, error: `[${i}]: ${result.error}` };
      }
      results.push(result.data);
    }
    return { success: true, data: results };
  }

  min(length: number): this {
    this._minLength = length;
    return this;
  }
  max(length: number): this {
    this._maxLength = length;
    return this;
  }
  nonempty(): this {
    this._minLength = 1;
    return this;
  }
}

class ObjectSchema<T extends Record<string, BaseSchema<unknown>>>
  extends BaseSchema<
    { [K in keyof T]: T[K] extends BaseSchema<infer U> ? U : never }
  > {
  constructor(private shape: T) {
    super();
  }

  override safeParse(
    value: unknown,
  ): {
    success: true;
    data: { [K in keyof T]: T[K] extends BaseSchema<infer U> ? U : never };
  } | { success: false; error: string } {
    if (typeof value !== "object" || value === null) {
      return { success: false, error: "Expected object" };
    }
    const result: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(this.shape)) {
      const fieldResult = schema.safeParse(
        (value as Record<string, unknown>)[key],
      );
      if (!fieldResult.success) {
        return { success: false, error: `${key}: ${fieldResult.error}` };
      }
      result[key] = fieldResult.data;
    }
    return {
      success: true,
      data: result as {
        [K in keyof T]: T[K] extends BaseSchema<infer U> ? U : never;
      },
    };
  }
}

class OptionalSchema<T> extends BaseSchema<T | undefined> {
  constructor(private innerSchema: BaseSchema<T>) {
    super();
  }

  override safeParse(
    value: unknown,
  ): { success: true; data: T | undefined } | {
    success: false;
    error: string;
  } {
    if (value === undefined || value === null) {
      return { success: true, data: undefined };
    }
    return this.innerSchema.safeParse(value);
  }
}

class UnionSchema<T extends BaseSchema<unknown>[]>
  extends BaseSchema<T[number] extends BaseSchema<infer U> ? U : never> {
  constructor(private schemas: T) {
    super();
  }

  override safeParse(
    value: unknown,
  ):
    | { success: true; data: T[number] extends BaseSchema<infer U> ? U : never }
    | { success: false; error: string } {
    for (const schema of this.schemas) {
      const result = schema.safeParse(value);
      if (result.success) {
        return result as {
          success: true;
          data: T[number] extends BaseSchema<infer U> ? U : never;
        };
      }
    }
    return {
      success: false,
      error: "Value does not match any schema in union",
    };
  }
}

class LiteralSchema<T extends string | number | boolean> extends BaseSchema<T> {
  constructor(private literalValue: T) {
    super();
  }

  override safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: string } {
    if (value !== this.literalValue) {
      return {
        success: false,
        error: `Expected ${JSON.stringify(this.literalValue)}`,
      };
    }
    return { success: true, data: value as T };
  }
}

class EnumSchema<T extends string[]> extends BaseSchema<T[number]> {
  constructor(private values: T) {
    super();
  }

  override safeParse(
    value: unknown,
  ): { success: true; data: T[number] } | { success: false; error: string } {
    if (!this.values.includes(value as string)) {
      return {
        success: false,
        error: `Expected one of: ${this.values.join(", ")}`,
      };
    }
    return { success: true, data: value as T[number] };
  }
}

class AnySchema extends BaseSchema<unknown> {
  override safeParse(value: unknown): { success: true; data: unknown } {
    return { success: true, data: value };
  }
}

/**
 * Simple markdown parser (basic features)
 */
const markdown = {
  /**
   * Parse markdown to HTML
   */
  toHtml: (md: string): string => {
    let html = md;

    // Escape HTML
    html = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(
      />/g,
      "&gt;",
    );

    // Headers
    html = html.replace(/^######\s+(.+)$/gm, "<h6>$1</h6>");
    html = html.replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>");
    html = html.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
    html = html.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

    // Bold and italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
    html = html.replace(/___(.+?)___/g, "<strong><em>$1</em></strong>");
    html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");
    html = html.replace(/_(.+?)_/g, "<em>$1</em>");

    // Code blocks
    html = html.replace(
      /```(\w*)\n([\s\S]*?)```/g,
      '<pre><code class="language-$1">$2</code></pre>',
    );
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Links and images
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // Lists
    html = html.replace(/^\s*[-*]\s+(.+)$/gm, "<li>$1</li>");
    html = html.replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>");
    html = html.replace(/^\s*(\d+)\.\s+(.+)$/gm, "<li>$2</li>");

    // Blockquotes
    html = html.replace(/^>\s+(.+)$/gm, "<blockquote>$1</blockquote>");

    // Horizontal rules
    html = html.replace(/^---+$/gm, "<hr>");
    html = html.replace(/^\*\*\*+$/gm, "<hr>");

    // Paragraphs (lines not already wrapped)
    html = html.replace(/^(?!<[a-z]|$)(.+)$/gm, "<p>$1</p>");

    // Clean up extra paragraph tags around block elements
    html = html.replace(
      /<p>(<(?:h[1-6]|ul|ol|li|blockquote|pre|hr)[^>]*>)/g,
      "$1",
    );
    html = html.replace(/(<\/(?:h[1-6]|ul|ol|li|blockquote|pre)>)<\/p>/g, "$1");

    return html;
  },

  /**
   * Strip markdown to plain text
   */
  toText: (md: string): string => {
    let text = md;
    // Remove headers markers
    text = text.replace(/^#+\s+/gm, "");
    // Remove emphasis
    text = text.replace(/\*\*\*(.+?)\*\*\*/g, "$1");
    text = text.replace(/\*\*(.+?)\*\*/g, "$1");
    text = text.replace(/\*(.+?)\*/g, "$1");
    text = text.replace(/___(.+?)___/g, "$1");
    text = text.replace(/__(.+?)__/g, "$1");
    text = text.replace(/_(.+?)_/g, "$1");
    // Remove code blocks
    text = text.replace(/```[\s\S]*?```/g, "");
    text = text.replace(/`([^`]+)`/g, "$1");
    // Remove links but keep text
    text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
    // Remove blockquotes
    text = text.replace(/^>\s+/gm, "");
    // Remove list markers
    text = text.replace(/^\s*[-*]\s+/gm, "");
    text = text.replace(/^\s*\d+\.\s+/gm, "");
    // Remove horizontal rules
    text = text.replace(/^---+$/gm, "");
    text = text.replace(/^\*\*\*+$/gm, "");
    return text.trim();
  },
};

/**
 * String manipulation utilities
 */
const str = {
  /**
   * Convert string to URL-friendly slug
   */
  slugify: (text: string): string => {
    return text
      .toString()
      .toLowerCase()
      .trim()
      .replace(/\s+/g, "-") // Replace spaces with -
      .replace(/[^\w\-]+/g, "") // Remove non-word chars
      .replace(/\-\-+/g, "-") // Replace multiple - with single -
      .replace(/^-+/, "") // Trim - from start
      .replace(/-+$/, ""); // Trim - from end
  },

  /**
   * Pluralize a word based on count
   */
  pluralize: (word: string, count: number, plural?: string): string => {
    if (count === 1) return word;
    return plural || (word + "s");
  },

  /**
   * Convert to title case
   */
  titleCase: (text: string): string => {
    return text.replace(
      /\w\S*/g,
      (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    );
  },

  /**
   * Escape HTML special characters
   */
  escapeHtml: (text: string): string => {
    const escapes: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return text.replace(/[&<>"']/g, (c) => escapes[c]);
  },

  /**
   * Unescape HTML entities
   */
  unescapeHtml: (text: string): string => {
    const unescapes: Record<string, string> = {
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&#39;": "'",
    };
    return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => unescapes[m]);
  },

  /**
   * Word count
   */
  wordCount: (text: string): number => {
    return text.trim().split(/\s+/).filter(Boolean).length;
  },

  /**
   * Truncate to word boundary
   */
  truncateWords: (text: string, count: number, suffix = "..."): string => {
    const words = text.trim().split(/\s+/);
    if (words.length <= count) return text;
    return words.slice(0, count).join(" ") + suffix;
  },

  /**
   * Generate a random string
   */
  random: (length: number, charset = "alphanumeric"): string => {
    const charsets: Record<string, string> = {
      alphanumeric:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
      alpha: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
      numeric: "0123456789",
      hex: "0123456789abcdef",
    };
    const chars = charsets[charset] || charset;
    let result = "";
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  },
};

/**
 * Simple JWT utilities (decode only - no signing for security)
 */
const jwt = {
  /**
   * Decode a JWT without verification
   * WARNING: This does NOT verify the signature. Only use for reading claims
   * from tokens that have already been verified by your auth system.
   */
  decode: (
    token: string,
  ):
    | { header: Record<string, unknown>; payload: Record<string, unknown> }
    | null => {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return null;

      const header = JSON.parse(
        atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")),
      );
      const payload = JSON.parse(
        atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
      );

      return { header, payload };
    } catch {
      return null;
    }
  },

  /**
   * Check if a JWT is expired
   */
  isExpired: (token: string): boolean => {
    const decoded = jwt.decode(token);
    if (!decoded) return true;
    const exp = decoded.payload.exp as number | undefined;
    if (!exp) return false;
    return exp * 1000 < Date.now();
  },

  /**
   * Get expiration date from JWT
   */
  getExpiration: (token: string): Date | null => {
    const decoded = jwt.decode(token);
    if (!decoded) return null;
    const exp = decoded.payload.exp as number | undefined;
    if (!exp) return null;
    return new Date(exp * 1000);
  },
};

/**
 * HTTP helper utilities for building responses
 */
const http = {
  /**
   * Create a JSON response
   */
  json: (
    data: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ): Response => {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    });
  },

  /**
   * Create a text response
   */
  text: (
    data: string,
    status = 200,
    headers: Record<string, string> = {},
  ): Response => {
    return new Response(data, {
      status,
      headers: {
        "Content-Type": "text/plain",
        ...headers,
      },
    });
  },

  /**
   * Create an HTML response
   */
  html: (
    data: string,
    status = 200,
    headers: Record<string, string> = {},
  ): Response => {
    return new Response(data, {
      status,
      headers: {
        "Content-Type": "text/html",
        ...headers,
      },
    });
  },

  /**
   * Create a redirect response
   */
  redirect: (url: string, status = 302): Response => {
    return new Response(null, {
      status,
      headers: { Location: url },
    });
  },

  /**
   * Create an error response
   */
  error: (message: string, status = 400, details?: unknown): Response => {
    return new Response(JSON.stringify({ error: message, details }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  },
};

/**
 * Create a lightweight Supabase client
 * Provides core functionality compatible with @supabase/supabase-js
 */
type SandboxFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function createSupabaseClient(
  supabaseUrl: string,
  anonKey: string,
  serviceKey: string | undefined,
  fetchFn: SandboxFetch,
) {
  const apiUrl = `${supabaseUrl}/rest/v1`;
  const authUrl = `${supabaseUrl}/auth/v1`;

  // Use service key if available, otherwise anon key
  const apiKey = serviceKey || anonKey;

  const headers = {
    "apikey": anonKey, // Always use anon key for apikey header
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation",
  };

  // Query builder for .from() calls
  function createQueryBuilder(table: string) {
    let queryParts: string[] = [];
    let selectColumns = "*";
    let bodyData: unknown = null;
    let method = "GET";
    let singleResult = false;
    let countOption: string | null = null;
    let preferHeaders: string[] = ["return=representation"];

    const builder = {
      select: (
        columns = "*",
        options?: { count?: "exact" | "planned" | "estimated" },
      ) => {
        selectColumns = columns;
        method = "GET";
        if (options?.count) {
          countOption = options.count;
          preferHeaders.push(`count=${options.count}`);
        }
        return builder;
      },
      insert: (data: unknown, options?: { defaultToNull?: boolean }) => {
        bodyData = data;
        method = "POST";
        if (options?.defaultToNull === false) {
          preferHeaders.push("missing=default");
        }
        return builder;
      },
      update: (data: unknown) => {
        bodyData = data;
        method = "PATCH";
        return builder;
      },
      upsert: (
        data: unknown,
        options?: { onConflict?: string; ignoreDuplicates?: boolean },
      ) => {
        bodyData = data;
        method = "POST";
        preferHeaders.push("resolution=merge-duplicates");
        if (options?.onConflict) {
          preferHeaders.push(`on_conflict=${options.onConflict}`);
        }
        if (options?.ignoreDuplicates) {
          preferHeaders.push("resolution=ignore-duplicates");
        }
        return builder;
      },
      delete: () => {
        method = "DELETE";
        return builder;
      },
      eq: (column: string, value: unknown) => {
        queryParts.push(`${column}=eq.${encodeURIComponent(String(value))}`);
        return builder;
      },
      neq: (column: string, value: unknown) => {
        queryParts.push(`${column}=neq.${encodeURIComponent(String(value))}`);
        return builder;
      },
      gt: (column: string, value: unknown) => {
        queryParts.push(`${column}=gt.${encodeURIComponent(String(value))}`);
        return builder;
      },
      gte: (column: string, value: unknown) => {
        queryParts.push(`${column}=gte.${encodeURIComponent(String(value))}`);
        return builder;
      },
      lt: (column: string, value: unknown) => {
        queryParts.push(`${column}=lt.${encodeURIComponent(String(value))}`);
        return builder;
      },
      lte: (column: string, value: unknown) => {
        queryParts.push(`${column}=lte.${encodeURIComponent(String(value))}`);
        return builder;
      },
      like: (column: string, pattern: string) => {
        queryParts.push(`${column}=like.${encodeURIComponent(pattern)}`);
        return builder;
      },
      ilike: (column: string, pattern: string) => {
        queryParts.push(`${column}=ilike.${encodeURIComponent(pattern)}`);
        return builder;
      },
      is: (column: string, value: null | boolean) => {
        queryParts.push(`${column}=is.${value}`);
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        queryParts.push(
          `${column}=in.(${
            values.map((v) => encodeURIComponent(String(v))).join(",")
          })`,
        );
        return builder;
      },
      contains: (column: string, value: unknown) => {
        queryParts.push(
          `${column}=cs.${encodeURIComponent(JSON.stringify(value))}`,
        );
        return builder;
      },
      containedBy: (column: string, value: unknown) => {
        queryParts.push(
          `${column}=cd.${encodeURIComponent(JSON.stringify(value))}`,
        );
        return builder;
      },
      order: (
        column: string,
        options?: { ascending?: boolean; nullsFirst?: boolean },
      ) => {
        const direction = options?.ascending === false ? "desc" : "asc";
        const nulls = options?.nullsFirst ? "nullsfirst" : "nullslast";
        queryParts.push(`order=${column}.${direction}.${nulls}`);
        return builder;
      },
      limit: (count: number) => {
        queryParts.push(`limit=${count}`);
        return builder;
      },
      range: (from: number, to: number) => {
        preferHeaders.push(`offset=${from}`);
        queryParts.push(`limit=${to - from + 1}`);
        return builder;
      },
      single: () => {
        singleResult = true;
        preferHeaders.push("return=representation");
        return builder;
      },
      maybeSingle: () => {
        singleResult = true;
        return builder;
      },
      // Execute the query
      then: async (
        resolve: (
          result: { data: unknown; error: unknown; count?: number },
        ) => void,
      ) => {
        try {
          let url = `${apiUrl}/${table}`;
          if (method === "GET" && selectColumns !== "*") {
            queryParts.unshift(`select=${encodeURIComponent(selectColumns)}`);
          }
          if (queryParts.length > 0) {
            url += "?" + queryParts.join("&");
          }

          const reqHeaders: Record<string, string> = {
            ...headers,
            "Prefer": preferHeaders.join(", "),
          };

          if (singleResult && method === "GET") {
            reqHeaders["Accept"] = "application/vnd.pgrst.object+json";
          }

          const response = await fetchFn(url, {
            method,
            headers: reqHeaders,
            body: bodyData ? JSON.stringify(bodyData) : undefined,
          });

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({
              message: response.statusText,
            }));
            resolve({ data: null, error: errorData });
            return;
          }

          let data = await response.json().catch(() => null);

          // Handle count header
          let count: number | undefined;
          const contentRange = response.headers.get("content-range");
          if (contentRange && countOption) {
            const match = contentRange.match(/\/(\d+|\*)/);
            if (match && match[1] !== "*") {
              count = parseInt(match[1], 10);
            }
          }

          // Handle single result
          if (singleResult && Array.isArray(data)) {
            data = data[0] || null;
          }

          resolve({ data, error: null, count });
        } catch (err) {
          resolve({ data: null, error: err });
        }
      },
    };

    return builder;
  }

  // RPC (stored procedures) builder
  function createRpcBuilder(fnName: string, params?: Record<string, unknown>) {
    return {
      then: async (
        resolve: (result: { data: unknown; error: unknown }) => void,
      ) => {
        try {
          const url = `${apiUrl}/rpc/${fnName}`;
          const response = await fetchFn(url, {
            method: "POST",
            headers,
            body: params ? JSON.stringify(params) : "{}",
          });

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({
              message: response.statusText,
            }));
            resolve({ data: null, error: errorData });
            return;
          }

          const data = await response.json().catch(() => null);
          resolve({ data, error: null });
        } catch (err) {
          resolve({ data: null, error: err });
        }
      },
    };
  }

  return {
    from: (table: string) => createQueryBuilder(table),
    rpc: (fnName: string, params?: Record<string, unknown>) =>
      createRpcBuilder(fnName, params),

    // Auth helpers (limited - mainly for reading user from JWT)
    auth: {
      getUser: async () => {
        // In Galactic context, user is available via ultralight.user
        // This is a placeholder for compatibility
        return { data: { user: null }, error: null };
      },
    },

    // Storage helpers (basic)
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, file: Blob | ArrayBuffer) => {
          const storageUrl =
            `${supabaseUrl}/storage/v1/object/${bucket}/${path}`;
          try {
            const response = await fetchFn(storageUrl, {
              method: "POST",
              headers: {
                "apikey": anonKey,
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": file instanceof Blob
                  ? file.type
                  : "application/octet-stream",
              },
              body: file,
            });
            if (!response.ok) {
              const error = await response.json().catch(() => ({
                message: response.statusText,
              }));
              return { data: null, error };
            }
            const data = await response.json();
            return { data, error: null };
          } catch (err) {
            return { data: null, error: err };
          }
        },
        download: async (path: string) => {
          const storageUrl =
            `${supabaseUrl}/storage/v1/object/${bucket}/${path}`;
          try {
            const response = await fetchFn(storageUrl, {
              headers: {
                "apikey": anonKey,
                "Authorization": `Bearer ${apiKey}`,
              },
            });
            if (!response.ok) {
              const error = await response.json().catch(() => ({
                message: response.statusText,
              }));
              return { data: null, error };
            }
            const blob = await response.blob();
            return { data: blob, error: null };
          } catch (err) {
            return { data: null, error: err };
          }
        },
        getPublicUrl: (path: string) => {
          return {
            data: {
              publicUrl:
                `${supabaseUrl}/storage/v1/object/public/${bucket}/${path}`,
            },
          };
        },
      }),
    },
  };
}

// ============================================
// SANDBOX EXECUTION
// ============================================

/**
 * Executes user code with soft isolation
 */
export async function executeInSandbox(
  config: RuntimeConfig,
  functionName: string,
  args: unknown[],
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const logs: LogEntry[] = [];
  let aiCostLight = 0;

  // SECURITY: the SDK's inter-app call uses this bearer, not the caller's raw
  // token. Mint a short-lived token scoped to this app's allowed call targets
  // so the user's real key never reaches sandbox code. Null when anonymous,
  // which trips the existing "missing authToken" guard in call().
  const sandboxAuthToken = await mintSandboxAuthToken({
    user: config.user,
    appId: config.appId,
    executionId: config.executionId,
    hasBroadCallPermission: config.permissions.includes("app:call"),
    dependencyAppIds: (config.appCallDependencies || [])
      .map((dependency) => dependency.app)
      .filter(Boolean),
  });

  const capturedConsole = {
    log: (...items: unknown[]) => {
      const message = items.map(formatLogItem).join(" ");
      logs.push({ time: new Date().toISOString(), level: "log", message });
    },
    error: (...items: unknown[]) => {
      const message = items.map(formatLogItem).join(" ");
      logs.push({ time: new Date().toISOString(), level: "error", message });
    },
    warn: (...items: unknown[]) => {
      const message = items.map(formatLogItem).join(" ");
      logs.push({ time: new Date().toISOString(), level: "warn", message });
    },
    info: (...items: unknown[]) => {
      const message = items.map(formatLogItem).join(" ");
      logs.push({ time: new Date().toISOString(), level: "info", message });
    },
  };

  try {
    // Track timers created by user code so we can clean them up
    const activeTimers = new Set<number>();
    const activeIntervals = new Set<number>();

    // Fetch guards
    const MAX_CONCURRENT_FETCHES = 20;
    const MAX_FETCH_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB
    const FETCH_TIMEOUT_MS = 15_000; // 15 seconds per request
    let activeFetchCount = 0;

    const openFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      const parsedUrl = new URL(url);

      // Only allow HTTPS (and localhost for development)
      if (
        parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "localhost"
      ) {
        throw new Error(
          `Only HTTPS URLs are allowed. Got: ${parsedUrl.protocol}`,
        );
      }

      if (activeFetchCount >= MAX_CONCURRENT_FETCHES) {
        throw new Error(
          `Concurrent fetch limit exceeded (max ${MAX_CONCURRENT_FETCHES})`,
        );
      }

      activeFetchCount++;
      try {
        const controller = new AbortController();
        const fetchTimeout = setTimeout(
          () => controller.abort(),
          FETCH_TIMEOUT_MS,
        );

        const response = await fetch(input, {
          ...init,
          signal: init?.signal || controller.signal,
        });

        clearTimeout(fetchTimeout);

        // Wrap response to enforce size limit on body reads
        const contentLength = response.headers.get("content-length");
        if (
          contentLength &&
          parseInt(contentLength, 10) > MAX_FETCH_RESPONSE_BYTES
        ) {
          throw new Error(
            `Response too large (${contentLength} bytes, max ${MAX_FETCH_RESPONSE_BYTES})`,
          );
        }

        return response;
      } finally {
        activeFetchCount--;
      }
    };

    // ── net:connect — TCP/TLS socket access (gated by permission) ──
    // Exposes Deno.connect and Deno.connectTls for apps that need raw socket access
    // (IMAP, SMTP, database drivers, etc). Only available when manifest declares net:connect.
    const MAX_CONCURRENT_CONNECTIONS = 5;
    let activeConnectionCount = 0;
    const CONNECTION_TIMEOUT_MS = 30_000;

    const hasNetConnect = config.permissions.includes("net:connect");

    // @ts-ignore — Deno global
    const _Deno = globalThis.Deno;

    const sandboxConnect = async (
      options: { hostname: string; port: number },
    ) => {
      if (!hasNetConnect) {
        throw new Error(
          'net:connect permission required. Add "net:connect" to your manifest permissions array.',
        );
      }
      if (activeConnectionCount >= MAX_CONCURRENT_CONNECTIONS) {
        throw new Error(
          `Concurrent connection limit exceeded (max ${MAX_CONCURRENT_CONNECTIONS})`,
        );
      }
      if (!options?.hostname || !options?.port) {
        throw new Error("hostname and port are required");
      }
      // Block connections to localhost/internal networks
      const host = options.hostname.toLowerCase();
      if (
        host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" ||
        host.startsWith("10.") || host.startsWith("192.168.") ||
        host.startsWith("172.")
      ) {
        throw new Error(
          "Connections to internal/private networks are not allowed",
        );
      }

      activeConnectionCount++;
      capturedConsole.log(
        `[net:connect] TCP ${options.hostname}:${options.port}`,
      );
      try {
        const conn = await _Deno.connect({
          hostname: options.hostname,
          port: options.port,
        });
        // Wrap to track cleanup
        const originalClose = conn.close.bind(conn);
        conn.close = () => {
          activeConnectionCount--;
          return originalClose();
        };
        return conn;
      } catch (e) {
        activeConnectionCount--;
        throw e;
      }
    };

    const sandboxConnectTls = async (
      options: { hostname: string; port: number },
    ) => {
      if (!hasNetConnect) {
        throw new Error(
          'net:connect permission required. Add "net:connect" to your manifest permissions array.',
        );
      }
      if (activeConnectionCount >= MAX_CONCURRENT_CONNECTIONS) {
        throw new Error(
          `Concurrent connection limit exceeded (max ${MAX_CONCURRENT_CONNECTIONS})`,
        );
      }
      if (!options?.hostname || !options?.port) {
        throw new Error("hostname and port are required");
      }
      const host = options.hostname.toLowerCase();
      if (
        host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" ||
        host.startsWith("10.") || host.startsWith("192.168.") ||
        host.startsWith("172.")
      ) {
        throw new Error(
          "Connections to internal/private networks are not allowed",
        );
      }

      activeConnectionCount++;
      capturedConsole.log(
        `[net:connect] TLS ${options.hostname}:${options.port}`,
      );
      try {
        const conn = await _Deno.connectTls({
          hostname: options.hostname,
          port: options.port,
        });
        const originalClose = conn.close.bind(conn);
        conn.close = () => {
          activeConnectionCount--;
          return originalClose();
        };
        return conn;
      } catch (e) {
        activeConnectionCount--;
        throw e;
      }
    };

    // User ID validation for D1 queries — ensures data isolation between users.
    // Every SELECT/UPDATE/DELETE must reference user_id in a WHERE clause.
    // Every INSERT must include user_id in the column list.
    function _validateUserIdInQuery(sql: string, context: string): void {
      const normalized = sql.toLowerCase().replace(/\s+/g, " ").trim();

      // Skip system table queries (internal use)
      if (normalized.includes("_migrations") || normalized.includes("_usage")) {
        return;
      }

      // For INSERT/REPLACE: must reference user_id column
      if (/^(insert|replace)\s/i.test(normalized)) {
        if (!normalized.includes("user_id")) {
          throw new Error(
            `[Galactic] db.${context}(): INSERT statements must include user_id. ` +
              `Add user_id to your column list and pass ultralight.user.id as the value.`,
          );
        }
        return;
      }

      // For SELECT/UPDATE/DELETE: must have user_id in WHERE
      if (/^(select|update|delete)\s/i.test(normalized)) {
        if (!normalized.includes("user_id")) {
          throw new Error(
            `[Galactic] db.${context}(): Queries must filter by user_id. ` +
              `Add WHERE user_id = ? to your query and pass ultralight.user.id.`,
          );
        }
      }
    }

    // Create SDK with D1 relational database and user memory (Supabase)
    const sdk = {
      // ENVIRONMENT VARIABLES - Decrypted, read-only
      env: Object.freeze({ ...config.envVars }),

      // USER CONTEXT - Authenticated user info (null if anonymous)
      user: config.user,

      // Check if user is authenticated
      isAuthenticated: (): boolean => config.user !== null,

      // Require authentication - throws if not authenticated
      requireAuth: (): UserContext => {
        if (!config.user) {
          throw new Error(
            "Authentication required. Please sign in to use this feature.",
          );
        }
        return config.user;
      },

      // APP DATA STORAGE - Key-value, per-app (R2-based, zero config)
      // Used by app function code to persist data without needing a database.
      store: async (key: string, value: unknown): Promise<void> => {
        await config.appDataService.store(key, value);
        capturedConsole.log(`[SDK] store("${key}")`);
      },
      load: async (key: string): Promise<unknown> => {
        const value = await config.appDataService.load(key);
        capturedConsole.log(`[SDK] load("${key}")`);
        return value;
      },
      list: async (prefix?: string): Promise<string[]> => {
        const keys = await config.appDataService.list(prefix);
        capturedConsole.log(
          `[SDK] list("${prefix || ""}") → ${keys.length} keys`,
        );
        return keys;
      },
      remove: async (key: string): Promise<void> => {
        await config.appDataService.remove(key);
        capturedConsole.log(`[SDK] remove("${key}")`);
      },
      query: async (
        prefix: string,
        options?: { limit?: number; offset?: number },
      ): Promise<QueryResult[]> => {
        const results = await config.appDataService.query(prefix, options);
        capturedConsole.log(
          `[SDK] query("${prefix}") → ${results.length} results`,
        );
        return results;
      },

      // D1 RELATIONAL DATABASE - SQL-based, per-app
      // Every query must include user_id for data isolation.
      // Schema managed via migrations/ folder in the app bundle.
      db: {
        /**
         * Execute INSERT/UPDATE/DELETE. Returns { success, meta }.
         * SQL must reference user_id column.
         */
        run: async (sql: string, params?: unknown[]): Promise<D1RunResult> => {
          if (!config.d1DataService) {
            throw new Error(
              "D1 database not available. Ensure your app has a migrations/ folder.",
            );
          }
          _validateUserIdInQuery(sql, "run");
          const result = await config.d1DataService.run(sql, params);
          capturedConsole.log(
            `[SDK] db.run(${sql.slice(0, 80)}${sql.length > 80 ? "..." : ""})`,
          );
          return result;
        },

        /**
         * Execute SELECT. Returns all matching rows.
         * SQL must filter by user_id.
         */
        all: async <T = Record<string, unknown>>(
          sql: string,
          params?: unknown[],
        ): Promise<T[]> => {
          if (!config.d1DataService) {
            throw new Error(
              "D1 database not available. Ensure your app has a migrations/ folder.",
            );
          }
          _validateUserIdInQuery(sql, "all");
          const result = await config.d1DataService.all<T>(sql, params);
          capturedConsole.log(
            `[SDK] db.all(${sql.slice(0, 80)}${
              sql.length > 80 ? "..." : ""
            }) → ${result.length} rows`,
          );
          return result;
        },

        /**
         * Execute SELECT. Returns first row or null.
         */
        first: async <T = Record<string, unknown>>(
          sql: string,
          params?: unknown[],
        ): Promise<T | null> => {
          if (!config.d1DataService) {
            throw new Error(
              "D1 database not available. Ensure your app has a migrations/ folder.",
            );
          }
          _validateUserIdInQuery(sql, "first");
          const result = await config.d1DataService.first<T>(sql, params);
          capturedConsole.log(
            `[SDK] db.first(${sql.slice(0, 80)}${
              sql.length > 80 ? "..." : ""
            })`,
          );
          return result;
        },

        /**
         * Execute raw DDL — blocked at runtime. Use migrations/ for schema changes.
         */
        exec: async (_sql: string): Promise<D1ExecResult> => {
          throw new Error(
            "ultralight.db.exec() is not available at runtime. Use migrations/ for schema changes.",
          );
        },

        /**
         * Execute multiple statements atomically (transaction).
         */
        batch: async (
          statements: Array<{ sql: string; params?: unknown[] }>,
        ): Promise<D1RunResult[]> => {
          if (!config.d1DataService) {
            throw new Error(
              "D1 database not available. Ensure your app has a migrations/ folder.",
            );
          }
          for (const stmt of statements) {
            _validateUserIdInQuery(stmt.sql, "batch");
          }
          const result = await config.d1DataService.batch(statements);
          capturedConsole.log(
            `[SDK] db.batch(${statements.length} statements)`,
          );
          return result;
        },
      },

      // USER MEMORY - For unified Memory.md
      remember: async (key: string, value: unknown) => {
        if (!config.permissions.includes("memory:write")) {
          throw new Error("memory:write permission required");
        }
        if (!config.memoryService) {
          throw new Error(
            "User memory not available - use store() for app data",
          );
        }
        await config.memoryService.remember(key, value);
        capturedConsole.log(`[SDK] remember("${key}")`);
      },
      recall: async (key: string) => {
        if (!config.permissions.includes("memory:read")) {
          throw new Error("memory:read permission required");
        }
        if (!config.memoryService) {
          throw new Error(
            "User memory not available - use load() for app data",
          );
        }
        const value = await config.memoryService.recall(key);
        capturedConsole.log(`[SDK] recall("${key}")`);
        return value;
      },

      // AI - Routes through BYOK when configured, otherwise platform credits.
      ai: async (request: AIRequest): Promise<AIResponse> => {
        if (!config.permissions.includes("ai:call")) {
          throw new Error("ai:call permission required");
        }
        capturedConsole.log(`[SDK] ai()`);
        // The AI service now has the provider route bound to it, so we just pass the request.
        const response = await config.aiService.call(
          request,
          config.userApiKey || "",
        );
        // Check for route/provider errors returned by the service.
        const aiError = (response as AIResponse & { error?: string }).error;
        if (aiError) {
          throw new Error(aiError);
        }
        return response;
      },

      // CALL - Inter-app function calls via MCP
      call: async (
        targetAppId: string,
        functionName: string,
        callArgs?: Record<string, unknown>,
      ): Promise<unknown> => {
        if (
          typeof targetAppId !== "string" || !targetAppId.trim() ||
          typeof functionName !== "string" || !functionName.trim()
        ) {
          throw new Error("target app id and function name are required");
        }
        const hasBroadCallPermission = config.permissions.includes("app:call");
        const hasDeclaredDependency = appCallAllowedByDependency(
          config.appCallDependencies,
          targetAppId,
          functionName,
        );
        if (!hasBroadCallPermission && !hasDeclaredDependency) {
          throw new Error(
            "app:call permission or a matching dependency is required",
          );
        }
        if (!config.baseUrl || !sandboxAuthToken) {
          throw new Error(
            "Inter-app calls not available (missing baseUrl or authToken)",
          );
        }
        if (targetAppId === config.appId && !callArgs?._allowSelfCall) {
          capturedConsole.log(
            `[SDK] call("${targetAppId}", "${functionName}") — self-call`,
          );
        } else {
          capturedConsole.log(
            `[SDK] call("${targetAppId}", "${functionName}")`,
          );
        }

        const rpcRequest = {
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/call",
          params: {
            name: functionName,
            arguments: callArgs || {},
          },
        };

        const response = await openFetch(
          `${config.baseUrl}/mcp/${targetAppId}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${sandboxAuthToken}`,
            },
            body: JSON.stringify(rpcRequest),
          },
        );

        if (!response.ok) {
          const text = await response.text().catch(() => response.statusText);
          throw new Error(
            `ultralight.call failed (${response.status}): ${text}`,
          );
        }

        const rpcResponse = await response.json() as RpcToolCallEnvelope;

        if (rpcResponse.error) {
          throw new Error(
            `ultralight.call RPC error: ${
              rpcResponse.error.message || JSON.stringify(rpcResponse.error)
            }`,
          );
        }

        // Unwrap MCP tool result — result.content[0].text is the JSON-encoded return value
        const result = rpcResponse.result;
        if (result?.content && Array.isArray(result.content)) {
          const textBlock = result.content.find((c: { type: string }) =>
            c.type === "text"
          );
          if (textBlock?.text) {
            try {
              return JSON.parse(textBlock.text);
            } catch {
              return textBlock.text;
            }
          }
        }
        return result;
      },

      // PAYMENTS — in-app purchases via the internal ledger.
      // Charges the calling user and credits the app owner NET of the 15%
      // platform fee — waived to 0% when the buyer is the developer's own
      // attributed customer. This is the SAME fee + referral path as per-call
      // pricing (reason "in_app_purchase" is a first-class monetization kind in
      // transfer_light). to_balance reflects the net credit; platform_fee /
      // fee_waived expose the split.
      charge: async (
        amountLight: number,
        reason?: string,
      ): Promise<{
        success: boolean;
        from_balance: number;
        to_balance: number;
        platform_fee: number;
        fee_waived: number;
      }> => {
        if (!config.user) {
          throw new Error(
            "Authentication required. User must be signed in to make purchases.",
          );
        }
        if (
          typeof amountLight !== "number" || amountLight < 1 ||
          amountLight > 100000
        ) {
          throw new Error("amountLight must be between 1 and 100000");
        }
        if (config.userId === config.ownerId) {
          throw new Error("Cannot charge yourself");
        }

        capturedConsole.log(
          `[SDK] charge(${amountLight}, "${reason || "in_app_purchase"}")`,
        );

        // @ts-ignore
        const _Deno = globalThis.Deno;
        const SUPABASE_URL = _Deno?.env?.get("SUPABASE_URL") || "";
        const SUPABASE_KEY = _Deno?.env?.get("SUPABASE_SERVICE_ROLE_KEY") || "";

        if (!SUPABASE_URL || !SUPABASE_KEY) {
          throw new Error("Payment system unavailable");
        }

        // Atomic transfer: caller → owner. The app-provided reason is stored as
        // metadata so the platform transfer rail keeps a controlled reason set.
        const transferRes = await openFetch(
          `${SUPABASE_URL}/rest/v1/rpc/transfer_light`,
          {
            method: "POST",
            headers: {
              "apikey": SUPABASE_KEY,
              "Authorization": `Bearer ${SUPABASE_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              p_from_user: config.userId,
              p_to_user: config.ownerId,
              p_amount_light: Math.round(amountLight),
              p_reason: "in_app_purchase",
              p_app_id: config.appId,
              p_idempotency_key: buildEconomicIdempotencyKey(
                "sandbox_purchase_transfer",
                [
                  config.executionId,
                  config.userId,
                  config.appId,
                  amountLight,
                  reason || "in_app_purchase",
                ],
              ),
              p_metadata: {
                developer_reason: reason || null,
              },
            }),
          },
        );

        if (!transferRes.ok) {
          throw new Error("Payment transfer failed");
        }

        const rows = await transferRes.json() as Array<{
          from_new_balance: number;
          to_new_balance: number;
          platform_fee?: number;
          fee_waived?: number;
        }>;
        if (!rows || rows.length === 0) {
          throw new Error(
            `Insufficient balance. This purchase costs ${
              formatLight(amountLight)
            }. Top up your balance to continue.`,
          );
        }

        return {
          success: true,
          from_balance: rows[0].from_new_balance,
          to_balance: rows[0].to_new_balance,
          platform_fee: rows[0].platform_fee ?? 0,
          fee_waived: rows[0].fee_waived ?? 0,
        };
      },

      // net:connect — TCP/TLS sockets (Deno path)
      net: hasNetConnect
        ? {
          connectTls: async (hostname: string, port: number) => {
            return sandboxConnectTls({ hostname, port });
          },
          connectPlain: async (hostname: string, port: number) => {
            return sandboxConnect({ hostname, port });
          },
          connectStartTls: async (hostname: string, port: number) => {
            const conn = await sandboxConnect({ hostname, port });
            return await _Deno.startTls(conn, { hostname });
          },
        }
        : {
          connectTls: () => {
            throw new Error("net:connect permission required.");
          },
          connectPlain: () => {
            throw new Error("net:connect permission required.");
          },
          connectStartTls: () => {
            throw new Error("net:connect permission required.");
          },
        },
    };

    // Create Supabase client if configured
    let supabaseClient: unknown = null;
    if (config.supabase?.url && config.supabase?.anonKey) {
      supabaseClient = createSupabaseClient(
        config.supabase.url,
        config.supabase.anonKey,
        config.supabase.serviceKey,
        openFetch,
      );
      capturedConsole.log("[SDK] Supabase client initialized");
    }

    // Mock React/ReactDOM for MCP function execution
    // These are only used by the UI rendering code, not MCP functions
    // Providing stubs prevents "Dynamic require" errors when bundled code loads
    const mockReact = {
      createElement: () => null,
      useState: () => [null, () => {}],
      useEffect: () => {},
      useCallback: (fn: unknown) => fn,
      useMemo: (fn: () => unknown) => fn(),
      useRef: () => ({ current: null }),
      useContext: () => null,
      createContext: () => ({ Provider: () => null, Consumer: () => null }),
      Fragment: Symbol("Fragment"),
      StrictMode: Symbol("StrictMode"),
      // JSX runtime
      jsx: () => null,
      jsxs: () => null,
      jsxDEV: () => null,
    };

    const mockReactDOM = {
      createRoot: () => ({
        render: () => {},
        unmount: () => {},
      }),
      render: () => {},
    };

    // Require function for IIFE-bundled code that has external dependencies
    // This provides mock implementations for browser-only modules
    const sandboxRequire = (moduleName: string) => {
      // React ecosystem - provide mocks since MCP functions don't need actual React
      if (
        moduleName === "react" || moduleName.startsWith("https://esm.sh/react")
      ) {
        return mockReact;
      }
      if (
        moduleName === "react/jsx-runtime" ||
        moduleName.includes("react") && moduleName.includes("jsx-runtime")
      ) {
        return mockReact;
      }
      if (
        moduleName === "react-dom" || moduleName === "react-dom/client" ||
        moduleName.startsWith("https://esm.sh/react-dom")
      ) {
        return mockReactDOM;
      }

      // Unknown module - throw helpful error
      throw new Error(
        `Module "${moduleName}" is not available in the MCP sandbox. Only backend functions are supported.`,
      );
    };

    // Build execution context with pre-bundled stdlib
    const context: Record<string, unknown> = {
      // Require function for IIFE bundles with external deps
      require: sandboxRequire,

      // SDK
      ultralight: sdk,

      // Console
      console: capturedConsole,

      // Network (all HTTPS allowed)
      fetch: openFetch,

      // TCP/TLS sockets (requires net:connect permission)
      Deno: hasNetConnect
        ? {
          connect: sandboxConnect,
          connectTls: sandboxConnectTls,
        }
        : undefined,

      // Timers — tracked for cleanup after execution
      setTimeout: (fn: () => void, ms: number) => {
        const id = setTimeout(fn, Math.min(ms, 30000));
        activeTimers.add(id as unknown as number);
        return id;
      },
      clearTimeout: (id: number) => {
        activeTimers.delete(id);
        clearTimeout(id);
      },
      setInterval: (fn: () => void, ms: number) => {
        const id = setInterval(fn, Math.max(ms, 100)); // Min 100ms
        activeIntervals.add(id as unknown as number);
        return id;
      },
      clearInterval: (id: number) => {
        activeIntervals.delete(id);
        clearInterval(id);
      },

      // Built-in globals
      URL,
      URLSearchParams,
      JSON,
      Math,
      Date,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Promise,
      Error,
      RegExp,
      Map,
      Set,
      WeakMap,
      WeakSet,
      Symbol,
      BigInt,
      Uint8Array,
      Int8Array,
      Uint16Array,
      Int16Array,
      Uint32Array,
      Int32Array,
      Float32Array,
      Float64Array,
      ArrayBuffer,
      TextEncoder,
      TextDecoder,
      atob,
      btoa,
      crypto,

      // PRE-BUNDLED STDLIB - Available globally!
      _, // Lodash-like utilities
      uuid, // UUID generation
      base64, // Base64 encoding/decoding
      hash, // SHA-256, SHA-512, MD5
      dateFns, // Date formatting and manipulation
      schema, // Zod-like validation
      markdown, // Markdown to HTML/text
      str, // String utilities (slugify, pluralize, etc.)
      jwt, // JWT decoding (read-only)
      http, // HTTP response helpers
    };

    // Add Supabase client if configured (or null placeholder)
    // Always include in context so wrapper code can reference it
    context.supabase = supabaseClient || null;

    // Create a custom globalThis that has ultralight, supabase, uuid, and _ set
    // This is needed because app code often does: const ultralight = globalThis.ultralight
    // which executes before our context variables are available
    const sandboxGlobalThis: Record<string, unknown> = {
      ultralight: sdk,
      uuid,
      _,
      console: capturedConsole,
      fetch: openFetch,
      Deno: hasNetConnect
        ? { connect: sandboxConnect, connectTls: sandboxConnectTls }
        : undefined,
      setTimeout: context.setTimeout as typeof globalThis.setTimeout,
      clearTimeout: context.clearTimeout as typeof globalThis.clearTimeout,
      setInterval: context.setInterval as typeof globalThis.setInterval,
      clearInterval: context.clearInterval as typeof globalThis.clearInterval,
      URL,
      URLSearchParams,
      JSON,
      Math,
      Date,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Promise,
      Error,
      RegExp,
      Map,
      Set,
      crypto,
      TextEncoder,
      TextDecoder,
      atob,
      btoa,
      require: sandboxRequire,
    };

    // Add supabase to globalThis if configured
    if (supabaseClient) {
      sandboxGlobalThis.supabase = supabaseClient;
    }

    // Add globalThis to context
    context.globalThis = sandboxGlobalThis;

    // Try to execute using Function constructor
    let userFunc: Function;

    try {
      const contextKeys = Object.keys(context);
      const contextValues = Object.values(context);

      // The bundled code uses IIFE format with --global-name=__exports
      // This means exports are available on the __exports object, e.g.:
      // var __exports = (() => { ... return { addTweet, getTweet, ... }; })();
      //
      // CRITICAL: The bundled IIFE code often reads from globalThis at the top level:
      //   const ultralight = globalThis.ultralight;
      // This happens BEFORE our context variables are available in the function scope.
      // So we MUST set up globalThis properties BEFORE the bundled code runs.
      //
      // We need to check both direct scope (for legacy/unbundled code) and __exports
      const wrapperCode = `
        "use strict";

        // Set up globalThis properties BEFORE bundled code runs
        // This is critical because bundled code captures these at module init time
        globalThis.ultralight = ultralight;
        // Galactic rename: galactic.* is the new SDK namespace, aliased to the
        // same object so galactic.ai()/galactic.call()/... === ultralight.*.
        // ultralight.* stays a permanent alias — every deployed app keeps working.
        globalThis.galactic = ultralight;
        globalThis.uuid = uuid;
        globalThis._ = _;
        globalThis.console = console;
        globalThis.fetch = fetch;
        globalThis.require = require;
        // Only set supabase if it's configured (it might be null for apps using R2 storage)
        if (supabase !== null) {
          globalThis.supabase = supabase;
        }

        // Now run the bundled code - it will find ultralight etc. on globalThis
        ${config.code}

        // Check for the function - could be a direct variable or on __exports (IIFE bundle)
        let __targetFn = null;

        // First check __exports (IIFE bundled code)
        if (typeof __exports !== 'undefined' && __exports !== null && typeof __exports["${functionName}"] === 'function') {
          __targetFn = __exports["${functionName}"];
        }
        // Then check if it's a direct variable (unbundled or simple code)
        else if (typeof ${functionName} === 'function') {
          __targetFn = ${functionName};
        }

        if (!__targetFn) {
          // List available functions for debugging
          let available = [];
          if (typeof __exports !== 'undefined' && __exports !== null) {
            available = Object.keys(__exports).filter(k => typeof __exports[k] === 'function');
          }
          throw new Error('Function "${functionName}" not found. Available functions: ' + (available.length > 0 ? available.join(', ') : 'none'));
        }

        return __targetFn(...args);
      `;

      const AsyncFunction =
        Object.getPrototypeOf(async function () {}).constructor;
      const fn = new AsyncFunction("args", ...contextKeys, wrapperCode);
      // Pass args directly, not as rest parameter (which would wrap in another array)
      userFunc = (callArgs: unknown[]) => fn(callArgs, ...contextValues);
    } catch (compileErr) {
      throw new Error(
        `Code compilation failed: ${
          compileErr instanceof Error ? compileErr.message : String(compileErr)
        }`,
      );
    }

    // Execute with timeout — prevent user code from hanging the server
    const MAX_TIMEOUT_MS = 120_000; // 2 minutes hard cap
    const EXECUTION_TIMEOUT_MS = Math.min(
      config.timeoutMs || 30_000,
      MAX_TIMEOUT_MS,
    );
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          new Error(
            `Execution timed out after ${EXECUTION_TIMEOUT_MS / 1000}s`,
          ),
        );
      }, EXECUTION_TIMEOUT_MS);
    });

    let result: unknown;
    try {
      result = await Promise.race([userFunc(args), timeoutPromise]);
    } finally {
      // Always clean up: cancel timeout and all user-created timers/intervals
      if (timeoutId) clearTimeout(timeoutId);
      for (const id of activeTimers) clearTimeout(id);
      for (const id of activeIntervals) clearInterval(id);
      activeTimers.clear();
      activeIntervals.clear();
    }

    const durationMs = Date.now() - startTime;

    // Guard against oversized results
    const MAX_RESULT_BYTES = 5 * 1024 * 1024; // 5 MB
    const serialized = JSON.stringify(result);
    if (serialized && serialized.length > MAX_RESULT_BYTES) {
      return {
        success: false,
        result: null,
        logs,
        durationMs,
        aiCostLight,
        error: {
          type: "ResultTooLarge",
          message: `Result size (${
            (serialized.length / 1024 / 1024).toFixed(1)
          } MB) exceeds limit (${MAX_RESULT_BYTES / 1024 / 1024} MB)`,
        },
      };
    }

    return {
      success: true,
      result,
      logs,
      durationMs,
      aiCostLight,
    };
  } catch (error) {
    // Clean up any lingering timers on error path too
    const durationMs = Date.now() - startTime;

    return {
      success: false,
      result: null,
      logs,
      durationMs,
      aiCostLight,
      error: {
        type: error instanceof Error ? error.constructor.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
        // Stack traces intentionally omitted — never expose internal paths to callers
      },
    };
  }
}

function formatLogItem(item: unknown): string {
  if (typeof item === "string") return item;
  if (item === null) return "null";
  if (item === undefined) return "undefined";
  if (typeof item === "object") {
    try {
      return JSON.stringify(item);
    } catch {
      return "[Object]";
    }
  }
  return String(item);
}
