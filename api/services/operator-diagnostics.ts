import type {
  LaunchOperatorDiagnosisProvenance,
  LaunchOperatorRunDiagnostic,
} from "../../shared/contracts/launch.ts";
import type { LogEntry } from "../../shared/types/index.ts";
import {
  OPERATOR_PROJECTION_REDACTION,
  redactOperatorProjectionText,
} from "./operator-projection-redaction.ts";

const MAX_CODE_CHARS = 80;
const MAX_SUMMARY_CHARS = 240;
const MAX_DETAIL_CHARS = 2_000;
const MAX_LOG_ENTRIES = 100;
const MAX_LOG_MESSAGE_CHARS = 2_000;
const UNKNOWN_SUMMARY =
  "We could not determine the failure cause from the available diagnostic data.";
const SECRET_ENV_KEY =
  /(?:api[_-]?key|auth|credential|database[_-]?url|pass(?:word)?|private[_-]?key|secret|token)/iu;

export interface OperatorDiagnosticPlatformFact {
  code: string;
  summary: string;
  detail?: string | null;
  retryable?: boolean | null;
}

export interface NormalizeOperatorDiagnosticInput {
  error?: unknown;
  provenance?: Exclude<LaunchOperatorDiagnosisProvenance, "combined">;
  platform?: OperatorDiagnosticPlatformFact | null;
  knownSecrets?: readonly (string | null | undefined)[];
}

export interface RedactedOperatorText {
  text: string;
  redacted: boolean;
  redactionCount: number;
}

export interface RuntimeDiagnosticSecretSource {
  envVars?: Record<string, string>;
  credentials?: Record<string, { value?: string }>;
  userApiKey?: string | null;
  authToken?: string;
  workerSecret?: string;
  callerContextToken?: string;
  aiRoute?: { apiKey?: string | null } | null;
  supabase?: {
    anonKey?: string;
    serviceKey?: string;
  } | null;
}

export function operatorCompatibilityError(
  diagnostic: LaunchOperatorRunDiagnostic,
  originalType?: unknown,
  knownSecrets: readonly (string | null | undefined)[] = [],
): { type: string; message: string } {
  const candidate = typeof originalType === "string" ? originalType : "";
  const safeType = redactOperatorDiagnosticText(
    candidate,
    knownSecrets,
    MAX_CODE_CHARS,
  );
  return {
    type: safeType.text === candidate &&
        /^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(candidate)
      ? candidate
      : diagnostic.causeCode || diagnostic.code,
    message: [diagnostic.summary, diagnostic.detail]
      .filter(Boolean)
      .join(" "),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value: string, maxChars: number): string {
  return value.length <= maxChars
    ? value
    : `${value.slice(0, Math.max(0, maxChars - 14))} …[truncated]`;
}

function normalizeCode(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const code = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-z0-9]+/giu, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return bounded(code || fallback, MAX_CODE_CHARS);
}

function exactSecretVariants(
  values: readonly (string | null | undefined)[],
): string[] {
  const variants = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length < 4) continue;
    variants.add(value);
    try {
      const encoded = encodeURIComponent(value);
      if (encoded !== value && encoded.length >= 4) variants.add(encoded);
    } catch {
      // A malformed UTF-16 value can fail encoding. The exact value remains.
    }
  }
  return [...variants].sort((a, b) => b.length - a.length);
}

export function redactOperatorDiagnosticText(
  value: unknown,
  knownSecrets: readonly (string | null | undefined)[] = [],
  maxChars = MAX_DETAIL_CHARS,
): RedactedOperatorText {
  let text = typeof value === "string"
    ? value
    : value === null || value === undefined
    ? ""
    : String(value);
  let redactionCount = 0;

  for (const secret of exactSecretVariants(knownSecrets)) {
    if (!text.includes(secret)) continue;
    redactionCount += text.split(secret).length - 1;
    text = text.split(secret).join(OPERATOR_PROJECTION_REDACTION);
  }

  const patternRedacted = redactOperatorProjectionText(text);
  if (patternRedacted !== text) redactionCount += 1;
  text = bounded(patternRedacted, maxChars);

  return {
    text,
    redacted: redactionCount > 0,
    redactionCount,
  };
}

export function collectRuntimeDiagnosticSecrets(
  source: RuntimeDiagnosticSecretSource,
): string[] {
  const values: Array<string | null | undefined> = [
    source.userApiKey,
    source.authToken,
    source.workerSecret,
    source.callerContextToken,
    source.aiRoute?.apiKey,
    source.supabase?.anonKey,
    source.supabase?.serviceKey,
    ...Object.values(source.credentials ?? {}).map((entry) => entry.value),
    ...Object.entries(source.envVars ?? {})
      .filter(([key]) => SECRET_ENV_KEY.test(key))
      .map(([, value]) => value),
  ];
  return exactSecretVariants(values);
}

function errorFields(error: unknown): {
  message: string | null;
  causeCode: string | null;
  detail: string | null;
} {
  if (error instanceof Error) {
    return {
      message: error.message || null,
      causeCode: error.name || null,
      detail: null,
    };
  }
  if (isRecord(error)) {
    const message = typeof error.message === "string"
      ? error.message
      : typeof error.error === "string"
      ? error.error
      : null;
    const causeCode = typeof error.type === "string"
      ? error.type
      : typeof error.name === "string"
      ? error.name
      : typeof error.code === "string"
      ? error.code
      : null;
    const detail = typeof error.detail === "string" ? error.detail : null;
    return { message, causeCode, detail };
  }
  if (typeof error === "string") {
    return { message: error, causeCode: null, detail: null };
  }
  return { message: null, causeCode: null, detail: null };
}

export function normalizeOperatorDiagnostic(
  input: NormalizeOperatorDiagnosticInput,
): LaunchOperatorRunDiagnostic {
  const provenance = input.provenance ?? "unknown";
  const fields = errorFields(input.error);
  const platform = input.platform ?? null;
  const knownSecrets = input.knownSecrets ?? [];
  const summaryValue = platform?.summary || fields.message || UNKNOWN_SUMMARY;
  const detailValue = platform
    ? platform.detail ??
      (provenance !== "platform" && provenance !== "unknown"
        ? fields.message
        : fields.detail)
    : fields.detail;
  const summary = redactOperatorDiagnosticText(
    summaryValue,
    knownSecrets,
    MAX_SUMMARY_CHARS,
  );
  const detail = detailValue
    ? redactOperatorDiagnosticText(detailValue, knownSecrets, MAX_DETAIL_CHARS)
    : null;
  const effectiveProvenance: LaunchOperatorDiagnosisProvenance = platform &&
      provenance !== "platform" && provenance !== "unknown"
    ? "combined"
    : platform
    ? "platform"
    : provenance;
  const code = platform
    ? normalizeCode(platform.code, "PLATFORM_ERROR")
    : provenance === "developer"
    ? "DEVELOPER_ERROR"
    : provenance === "provider"
    ? "PROVIDER_ERROR"
    : provenance === "platform"
    ? "PLATFORM_ERROR"
    : "UNKNOWN_ERROR";

  return {
    version: 1,
    code,
    causeCode: fields.causeCode
      ? normalizeCode(fields.causeCode, "ERROR")
      : null,
    summary: summary.text || UNKNOWN_SUMMARY,
    detail: detail?.text || null,
    provenance: effectiveProvenance,
    retryable: platform?.retryable ?? null,
    redacted: summary.redacted || (detail?.redacted ?? false),
  };
}

export function readOperatorDiagnostic(
  value: unknown,
  knownSecrets: readonly (string | null | undefined)[] = [],
): LaunchOperatorRunDiagnostic | null {
  if (value === null || value === undefined) return null;
  if (isRecord(value) && value.version === 1) {
    const provenance = [
        "platform",
        "provider",
        "developer",
        "combined",
        "unknown",
      ].includes(String(value.provenance))
      ? value.provenance as LaunchOperatorDiagnosisProvenance
      : "unknown";
    const summary = redactOperatorDiagnosticText(
      value.summary,
      knownSecrets,
      MAX_SUMMARY_CHARS,
    );
    const detail = typeof value.detail === "string"
      ? redactOperatorDiagnosticText(
        value.detail,
        knownSecrets,
        MAX_DETAIL_CHARS,
      )
      : null;
    return {
      version: 1,
      code: normalizeCode(value.code, "UNKNOWN_ERROR"),
      causeCode: value.causeCode
        ? normalizeCode(value.causeCode, "ERROR")
        : null,
      summary: summary.text || UNKNOWN_SUMMARY,
      detail: detail?.text || null,
      provenance,
      retryable: typeof value.retryable === "boolean" ? value.retryable : null,
      redacted: value.redacted === true || summary.redacted ||
        (detail?.redacted ?? false),
    };
  }
  return normalizeOperatorDiagnostic({
    error: value,
    provenance: "unknown",
    knownSecrets,
  });
}

export function redactOperatorLogEntries(
  logs: readonly LogEntry[],
  knownSecrets: readonly (string | null | undefined)[] = [],
): {
  logs: LogEntry[];
  droppedEntries: number;
  redactedEntries: number;
} {
  const kept = logs.slice(-MAX_LOG_ENTRIES);
  let redactedEntries = 0;
  const safe = kept.map((entry) => {
    const message = redactOperatorDiagnosticText(
      entry.message,
      knownSecrets,
      MAX_LOG_MESSAGE_CHARS,
    );
    if (message.redacted) redactedEntries += 1;
    return {
      time: typeof entry.time === "string" ? entry.time : "",
      level: typeof entry.level === "string" ? entry.level : "log",
      message: message.text,
    };
  });
  return {
    logs: safe,
    droppedEntries: logs.length - kept.length,
    redactedEntries,
  };
}
