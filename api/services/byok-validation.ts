import { getEnv } from "../lib/env.ts";
import type {
  LaunchByokValidationResponse,
  LaunchInferenceOperation,
} from "../../shared/contracts/launch.ts";
import {
  type ActiveBYOKProvider,
  BYOK_PROVIDERS,
} from "../../shared/types/index.ts";
import { providerSupportsInferenceOperations } from "./release-inference-requirements.ts";

export const BYOK_VALIDATION_POLICY_VERSION = "launch-byok-v1";
const BYOK_VALIDATION_RECEIPT_TTL_MS = 5 * 60 * 1_000;
const BYOK_VALIDATION_REQUEST_TIMEOUT_MS = 12_000;
const BYOK_EMBEDDING_VALIDATION_MODEL = "openai/text-embedding-3-small";

type ByokValidationErrorCode =
  | "invalid_key"
  | "rate_limited"
  | "model_unavailable"
  | "unsupported_operation"
  | "provider_unavailable"
  | "validation_timeout"
  | "invalid_receipt"
  | "expired_receipt"
  | "validation_not_configured";

export class ByokValidationError extends Error {
  constructor(
    public readonly code: ByokValidationErrorCode,
    public readonly status: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ByokValidationError";
  }
}

interface ReceiptClaims {
  v: typeof BYOK_VALIDATION_POLICY_VERSION;
  sub: string;
  provider: ActiveBYOKProvider;
  model: string | null;
  operations: LaunchInferenceOperation[];
  keyFingerprint: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

interface VerifiedByokValidationReceipt {
  policyVersion: string;
  provider: ActiveBYOKProvider;
  model: string | null;
  operations: LaunchInferenceOperation[];
  validatedAt: string;
}

interface ValidateByokCredentialInput {
  userId: string;
  provider: ActiveBYOKProvider;
  apiKey: string;
  model?: string | null;
  operations: LaunchInferenceOperation[];
}

interface ByokValidationDependencies {
  fetchImpl?: typeof fetch;
  now?: () => number;
  signingSecret?: string;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) {
    mismatch |= left[index] ^ right[index];
  }
  return mismatch === 0;
}

async function sha256(value: string): Promise<string> {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bufferSource(utf8(value))),
    ),
  );
}

function resolveSigningSecret(explicit?: string): string {
  const secret = explicit || getEnv("BYOK_VALIDATION_SIGNING_SECRET") ||
    getEnv("BYOK_ENCRYPTION_KEY");
  if (!secret) {
    throw new ByokValidationError(
      "validation_not_configured",
      503,
      "Credential validation is temporarily unavailable",
    );
  }
  return secret;
}

async function signingKey(secret: string): Promise<CryptoKey> {
  // Domain-separate the receipt key even when deployments temporarily fall
  // back to the already-configured BYOK encryption secret.
  const material = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      bufferSource(utf8(`galactic:byok-validation:v1:${secret}`)),
    ),
  );
  return await crypto.subtle.importKey(
    "raw",
    material,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function normalizeOperations(
  operations: readonly LaunchInferenceOperation[],
): LaunchInferenceOperation[] {
  const result = [...new Set(operations)];
  if (
    result.some((operation) =>
      operation !== "generate" && operation !== "embed"
    )
  ) {
    throw new ByokValidationError(
      "unsupported_operation",
      422,
      "The requested inference operation is not supported",
    );
  }
  return result.sort((left, right) =>
    (left === "generate" ? 0 : 1) - (right === "generate" ? 0 : 1)
  );
}

function providerError(
  status: number,
  operation: LaunchInferenceOperation,
): ByokValidationError {
  if (status === 401 || status === 403) {
    return new ByokValidationError(
      "invalid_key",
      400,
      "The provider rejected this API key",
      { operation, providerStatus: status },
    );
  }
  if (status === 429) {
    return new ByokValidationError(
      "rate_limited",
      429,
      "The provider rate-limited the validation request. Try again shortly.",
      { operation, providerStatus: status },
    );
  }
  if (status === 400 || status === 404 || status === 422) {
    return new ByokValidationError(
      "model_unavailable",
      422,
      "The selected model is unavailable for this API key",
      { operation, providerStatus: status },
    );
  }
  return new ByokValidationError(
    "provider_unavailable",
    502,
    "The provider could not validate this key. Try again shortly.",
    { operation, providerStatus: status },
  );
}

async function runProviderCheck(
  provider: ActiveBYOKProvider,
  apiKey: string,
  model: string,
  operation: LaunchInferenceOperation,
  fetchImpl: typeof fetch,
): Promise<void> {
  const info = BYOK_PROVIDERS[provider];
  const endpoint = operation === "generate"
    ? "/chat/completions"
    : "/embeddings";
  const body = operation === "generate"
    ? {
      model,
      messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: 1,
      temperature: 0,
    }
    : {
      model: BYOK_EMBEDDING_VALIDATION_MODEL,
      input: "galactic credential validation",
    };

  let response: Response;
  try {
    response = await fetchImpl(
      `${info.baseUrl.replace(/\/$/, "")}${endpoint}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://connectgalactic.com",
          "X-Title": "Galactic credential validation",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(BYOK_VALIDATION_REQUEST_TIMEOUT_MS),
      },
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new ByokValidationError(
        "validation_timeout",
        504,
        "The provider did not respond in time. Try again.",
        { operation },
      );
    }
    throw new ByokValidationError(
      "provider_unavailable",
      502,
      "The provider could not be reached. Try again shortly.",
      { operation },
    );
  }
  if (!response.ok) throw providerError(response.status, operation);
}

async function issueReceipt(
  claims: ReceiptClaims,
  secret: string,
): Promise<string> {
  const payload = base64Url(utf8(JSON.stringify(claims)));
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await signingKey(secret),
      bufferSource(utf8(payload)),
    ),
  );
  return `${payload}.${base64Url(signature)}`;
}

export async function validateByokCredential(
  input: ValidateByokCredentialInput,
  dependencies: ByokValidationDependencies = {},
): Promise<LaunchByokValidationResponse> {
  const operations = normalizeOperations(input.operations);
  if (operations.length === 0) {
    throw new ByokValidationError(
      "unsupported_operation",
      422,
      "At least one inference operation is required",
    );
  }
  if (!providerSupportsInferenceOperations(input.provider, operations)) {
    throw new ByokValidationError(
      "unsupported_operation",
      422,
      `${
        BYOK_PROVIDERS[input.provider].name
      } does not support every required operation`,
      { operations },
    );
  }

  const model = input.model?.trim() ||
    BYOK_PROVIDERS[input.provider].defaultModel;
  for (const operation of operations) {
    await runProviderCheck(
      input.provider,
      input.apiKey,
      model,
      operation,
      dependencies.fetchImpl ?? fetch,
    );
  }

  const now = (dependencies.now ?? Date.now)();
  const expiresAt = now + BYOK_VALIDATION_RECEIPT_TTL_MS;
  const claims: ReceiptClaims = {
    v: BYOK_VALIDATION_POLICY_VERSION,
    sub: input.userId,
    provider: input.provider,
    model,
    operations,
    keyFingerprint: await sha256(input.apiKey),
    issuedAt: now,
    expiresAt,
    nonce: crypto.randomUUID(),
  };
  return {
    valid: true,
    provider: input.provider,
    model,
    operations,
    validationReceipt: await issueReceipt(
      claims,
      resolveSigningSecret(dependencies.signingSecret),
    ),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export async function verifyByokValidationReceipt(
  receipt: string,
  input: ValidateByokCredentialInput,
  dependencies: Pick<ByokValidationDependencies, "now" | "signingSecret"> = {},
): Promise<VerifiedByokValidationReceipt> {
  try {
    const [payload, encodedSignature, extra] = receipt.split(".");
    if (!payload || !encodedSignature || extra !== undefined) {
      throw new Error("shape");
    }
    const expected = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await signingKey(resolveSigningSecret(dependencies.signingSecret)),
        bufferSource(utf8(payload)),
      ),
    );
    if (!timingSafeEqual(expected, decodeBase64Url(encodedSignature))) {
      throw new Error("signature");
    }
    const claims = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(payload)),
    ) as ReceiptClaims;
    const now = (dependencies.now ?? Date.now)();
    if (claims.expiresAt <= now) {
      throw new ByokValidationError(
        "expired_receipt",
        409,
        "The key test expired. Test the key again before saving.",
      );
    }
    const operations = normalizeOperations(input.operations);
    if (
      claims.v !== BYOK_VALIDATION_POLICY_VERSION ||
      claims.sub !== input.userId ||
      claims.provider !== input.provider ||
      claims.model !==
        (input.model?.trim() || BYOK_PROVIDERS[input.provider].defaultModel) ||
      JSON.stringify(claims.operations) !== JSON.stringify(operations) ||
      claims.keyFingerprint !== await sha256(input.apiKey)
    ) {
      throw new Error("binding");
    }
    return {
      policyVersion: claims.v,
      provider: claims.provider,
      model: claims.model,
      operations: claims.operations,
      validatedAt: new Date(claims.issuedAt).toISOString(),
    };
  } catch (error) {
    if (error instanceof ByokValidationError) throw error;
    throw new ByokValidationError(
      "invalid_receipt",
      409,
      "The key test no longer matches these credentials. Test the key again.",
    );
  }
}
