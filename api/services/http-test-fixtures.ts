// Exact, provider-agnostic HTTP fixtures for gx.test.
//
// This module deliberately has no outbound primitive. It validates authored
// fixture data, matches an already-intercepted Request, and materializes a
// canned Response. A caller must treat a null match as a blocked external
// effect; there is never a network fallback.

export const HTTP_TEST_FIXTURE_LIMITS = Object.freeze({
  max_entries: 32,
  // Bounds the complete normalized config before it is copied into both
  // parent-side HTTP bindings. Individual body limits alone would otherwise
  // permit dozens of MiB to be cloned before gx.test executes any code.
  max_config_bytes: 4 * 1024 * 1024,
  max_id_length: 64,
  max_method_length: 32,
  max_url_bytes: 4 * 1024,
  max_request_body_bytes: 256 * 1024,
  max_response_headers: 32,
  max_response_header_name_bytes: 128,
  max_response_header_value_bytes: 8 * 1024,
  max_response_headers_bytes: 32 * 1024,
  max_response_body_bytes: 1024 * 1024,
});

export type HttpTestFixtureKind = "raw" | "credential";

export interface HttpTestFixtureRequest {
  method: string;
  url: string;
  body_sha256?: string;
}

export interface HttpTestFixtureResponse {
  status: number;
  headers: Record<string, string>;
  body_text?: string;
  body_base64?: string;
}

export interface HttpTestFixture {
  id: string;
  kind: HttpTestFixtureKind;
  credential_key?: string;
  request: HttpTestFixtureRequest;
  response: HttpTestFixtureResponse;
}

export type HttpTestFixtureConfig = HttpTestFixture[];

interface HttpTestFixtureAttempt {
  kind: HttpTestFixtureKind;
  request: Request;
  credentialKey?: string;
}

interface HttpTestFixtureMatch {
  fixture: HttpTestFixture | null;
  requestBodyBytes: number;
}

export class HttpTestFixtureValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path} ${message}`);
    this.name = "HttpTestFixtureValidationError";
    this.path = path;
  }
}

export class HttpTestFixtureRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpTestFixtureRequestError";
  }
}

const ENTRY_KEYS = new Set([
  "id",
  "kind",
  "credential_key",
  "request",
  "response",
]);
const REQUEST_KEYS = new Set(["method", "url", "body_sha256"]);
const RESPONSE_KEYS = new Set([
  "status",
  "headers",
  "body_text",
  "body_base64",
]);
const FIXTURE_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const CREDENTIAL_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
const HTTP_METHOD = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FORBIDDEN_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "location",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const BODYLESS_STATUSES = new Set([204, 205]);
const textEncoder = new TextEncoder();

function fail(path: string, message: string): never {
  throw new HttpTestFixtureValidationError(path, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (!isRecord(value)) fail(path, "must be an object");
  return value;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "is not supported");
  }
}

function utf8Length(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function normalizeMethod(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > HTTP_TEST_FIXTURE_LIMITS.max_method_length ||
    !HTTP_METHOD.test(value)
  ) {
    fail(path, "must be a valid HTTP token of at most 32 characters");
  }
  return value.toUpperCase();
}

function normalizeUrl(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    utf8Length(value) > HTTP_TEST_FIXTURE_LIMITS.max_url_bytes
  ) {
    fail(path, "must be a bounded absolute HTTP(S) URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(path, "must be a valid absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail(path, "must use http or https");
  }
  const schemeSeparator = value.indexOf("://");
  const authority = schemeSeparator === -1
    ? ""
    : value.slice(schemeSeparator + 3).split(/[/?#]/, 1)[0];
  if (parsed.username || parsed.password || authority.includes("@")) {
    fail(path, "must not contain user information");
  }
  if (value.includes("#")) {
    fail(path, "must not contain a fragment");
  }

  const normalized = parsed.href;
  if (utf8Length(normalized) > HTTP_TEST_FIXTURE_LIMITS.max_url_bytes) {
    fail(path, "normalizes beyond the 4 KiB URL limit");
  }
  return normalized;
}

function normalizeHeaders(
  value: unknown,
  path: string,
): Record<string, string> {
  if (value === undefined) return {};
  const raw = requireRecord(value, path);
  const entries = Object.entries(raw);
  if (entries.length > HTTP_TEST_FIXTURE_LIMITS.max_response_headers) {
    fail(path, "contains more than 32 headers");
  }

  // Header names such as "__proto__" are valid HTTP tokens. A null-prototype
  // map prevents those names from mutating the output object's prototype or
  // disappearing from the normalized, digest-bound fixture.
  const normalized = Object.create(null) as Record<string, string>;
  let totalBytes = 0;
  for (const [authoredName, authoredValue] of entries) {
    if (
      !HEADER_NAME.test(authoredName) ||
      utf8Length(authoredName) >
        HTTP_TEST_FIXTURE_LIMITS.max_response_header_name_bytes
    ) {
      fail(`${path}.${authoredName}`, "has an invalid header name");
    }
    const name = authoredName.toLowerCase();
    if (Object.hasOwn(normalized, name)) {
      fail(`${path}.${authoredName}`, `duplicates header "${name}"`);
    }
    if (FORBIDDEN_RESPONSE_HEADERS.has(name)) {
      fail(`${path}.${authoredName}`, "is not allowed in a test response");
    }
    if (
      typeof authoredValue !== "string" ||
      /[\u0000-\u001f\u007f]/.test(authoredValue)
    ) {
      fail(`${path}.${authoredName}`, "must be a control-free string");
    }
    const headerValue = authoredValue.trim();
    if (
      utf8Length(headerValue) >
        HTTP_TEST_FIXTURE_LIMITS.max_response_header_value_bytes
    ) {
      fail(`${path}.${authoredName}`, "exceeds the 8 KiB value limit");
    }
    totalBytes += utf8Length(name) + utf8Length(headerValue);
    if (
      totalBytes > HTTP_TEST_FIXTURE_LIMITS.max_response_headers_bytes
    ) {
      fail(path, "exceeds the 32 KiB aggregate header limit");
    }
    normalized[name] = headerValue;
  }
  return normalized;
}

function decodeBase64(value: string, path: string): Uint8Array {
  const maxEncodedLength =
    Math.ceil(HTTP_TEST_FIXTURE_LIMITS.max_response_body_bytes / 3) * 4;
  if (
    value.length > maxEncodedLength ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
      .test(value)
  ) {
    fail(path, "must be canonical padded base64");
  }

  let binary: string;
  try {
    binary = atob(value);
  } catch {
    fail(path, "must be canonical padded base64");
  }
  if (btoa(binary) !== value) {
    fail(path, "must be canonical padded base64");
  }
  if (
    binary.length > HTTP_TEST_FIXTURE_LIMITS.max_response_body_bytes
  ) {
    fail(path, "decodes beyond the 1 MiB response-body limit");
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function normalizeResponse(
  value: unknown,
  path: string,
): HttpTestFixtureResponse {
  const response = requireRecord(value, path);
  assertKnownKeys(response, RESPONSE_KEYS, path);

  const status = response.status;
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 200 ||
    status > 599
  ) {
    fail(`${path}.status`, "must be an integer from 200 through 599");
  }
  if (status >= 300 && status <= 399) {
    fail(`${path}.status`, "must not be a redirect status");
  }
  if (BODYLESS_STATUSES.has(status)) {
    fail(`${path}.status`, "must permit a response body");
  }

  const hasText = Object.hasOwn(response, "body_text");
  const hasBase64 = Object.hasOwn(response, "body_base64");
  if (hasText === hasBase64) {
    fail(
      path,
      "must contain exactly one of body_text or body_base64",
    );
  }

  let bodyText: string | undefined;
  let bodyBase64: string | undefined;
  if (hasText) {
    if (typeof response.body_text !== "string") {
      fail(`${path}.body_text`, "must be a string");
    }
    if (
      utf8Length(response.body_text) >
        HTTP_TEST_FIXTURE_LIMITS.max_response_body_bytes
    ) {
      fail(`${path}.body_text`, "exceeds the 1 MiB response-body limit");
    }
    bodyText = response.body_text;
  } else {
    if (typeof response.body_base64 !== "string") {
      fail(`${path}.body_base64`, "must be a string");
    }
    decodeBase64(response.body_base64, `${path}.body_base64`);
    bodyBase64 = response.body_base64;
  }

  return {
    status,
    headers: normalizeHeaders(response.headers, `${path}.headers`),
    ...(bodyText !== undefined ? { body_text: bodyText } : {}),
    ...(bodyBase64 !== undefined ? { body_base64: bodyBase64 } : {}),
  };
}

function normalizeRequest(
  value: unknown,
  path: string,
): HttpTestFixtureRequest {
  const request = requireRecord(value, path);
  assertKnownKeys(request, REQUEST_KEYS, path);

  const normalized: HttpTestFixtureRequest = {
    method: normalizeMethod(request.method, `${path}.method`),
    url: normalizeUrl(request.url, `${path}.url`),
  };
  if (request.body_sha256 !== undefined) {
    if (
      typeof request.body_sha256 !== "string" ||
      !SHA256_HEX.test(request.body_sha256)
    ) {
      fail(
        `${path}.body_sha256`,
        "must be a lowercase SHA-256 digest",
      );
    }
    normalized.body_sha256 = request.body_sha256;
  }
  return normalized;
}

function normalizeEntry(
  value: unknown,
  index: number,
  ids: Set<string>,
): HttpTestFixture {
  const path = `http_fixtures[${index}]`;
  const entry = requireRecord(value, path);
  assertKnownKeys(entry, ENTRY_KEYS, path);

  if (
    typeof entry.id !== "string" ||
    entry.id.length > HTTP_TEST_FIXTURE_LIMITS.max_id_length ||
    !FIXTURE_ID.test(entry.id)
  ) {
    fail(
      `${path}.id`,
      "must begin with a letter and contain at most 64 letters, numbers, '.', '_', or '-'",
    );
  }
  if (ids.has(entry.id)) {
    fail(`${path}.id`, `duplicates fixture id "${entry.id}"`);
  }
  ids.add(entry.id);

  if (entry.kind !== "raw" && entry.kind !== "credential") {
    fail(`${path}.kind`, 'must be "raw" or "credential"');
  }
  const kind = entry.kind;

  let credentialKey: string | undefined;
  if (kind === "credential") {
    if (
      typeof entry.credential_key !== "string" ||
      !CREDENTIAL_KEY.test(entry.credential_key)
    ) {
      fail(
        `${path}.credential_key`,
        "is required and must be a valid uppercase environment-variable key",
      );
    }
    credentialKey = entry.credential_key;
  } else if (entry.credential_key !== undefined) {
    fail(
      `${path}.credential_key`,
      "is allowed only when kind is credential",
    );
  }

  const request = normalizeRequest(entry.request, `${path}.request`);
  if (kind === "credential" && !request.url.startsWith("https:")) {
    fail(
      `${path}.request.url`,
      "must use https for a credential fixture",
    );
  }

  return {
    id: entry.id,
    kind,
    ...(credentialKey ? { credential_key: credentialKey } : {}),
    request,
    response: normalizeResponse(entry.response, `${path}.response`),
  };
}

/**
 * Validates and normalizes an authored fixture array.
 *
 * Undefined/null means no fixtures. An explicit empty array is rejected so a
 * caller cannot mistake "configured but empty" for useful external coverage.
 */
export function resolveHttpTestFixtureConfig(
  input: unknown,
): HttpTestFixtureConfig | null {
  if (input === undefined || input === null) return null;
  if (!Array.isArray(input)) {
    fail("http_fixtures", "must be an array");
  }
  if (input.length === 0) {
    fail("http_fixtures", "must contain at least one entry");
  }
  if (input.length > HTTP_TEST_FIXTURE_LIMITS.max_entries) {
    fail("http_fixtures", "must contain at most 32 entries");
  }

  const ids = new Set<string>();
  const normalized: HttpTestFixtureConfig = [];
  // Include JSON array framing in the measured representation. The parser's
  // normalized value is the exact object that is cloned into each binding.
  let configBytes = 2;
  for (const [index, entry] of input.entries()) {
    const fixture = normalizeEntry(entry, index, ids);
    configBytes += (normalized.length === 0 ? 0 : 1) +
      utf8Length(JSON.stringify(fixture));
    if (configBytes > HTTP_TEST_FIXTURE_LIMITS.max_config_bytes) {
      fail(
        "http_fixtures",
        "exceeds the 4 MiB aggregate normalized-config limit",
      );
    }
    normalized.push(fixture);
  }
  return normalized;
}

async function readBoundedRequestBody(request: Request): Promise<Uint8Array> {
  let clone: {
    body: ReadableStream<Uint8Array> | null;
    headers: Headers;
  };
  try {
    // Workers' Request type carries Cloudflare metadata generics whose clone()
    // return type is not assignable to the default bare Request type. Only
    // these two standard Fetch properties cross this pure matcher boundary.
    clone = request.clone() as unknown as typeof clone;
  } catch {
    throw new HttpTestFixtureRequestError(
      "gx.test could not inspect the intercepted request body",
    );
  }
  if (!clone.body) return new Uint8Array();

  const declaredLength = clone.headers.get("content-length");
  if (
    declaredLength &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) >
      HTTP_TEST_FIXTURE_LIMITS.max_request_body_bytes
  ) {
    throw new HttpTestFixtureRequestError(
      "gx.test intercepted request body exceeds 256 KiB",
    );
  }

  const reader = clone.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > HTTP_TEST_FIXTURE_LIMITS.max_request_body_bytes) {
        await reader.cancel();
        throw new HttpTestFixtureRequestError(
          "gx.test intercepted request body exceeds 256 KiB",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function sha256HttpTestFixtureBody(
  body: Uint8Array | string,
): Promise<string> {
  const bytes = typeof body === "string" ? textEncoder.encode(body) : body;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    exactArrayBuffer(bytes),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeAttempt(input: HttpTestFixtureAttempt): {
  kind: HttpTestFixtureKind;
  method: string;
  url: string;
  credentialKey?: string;
} {
  if (input.kind !== "raw" && input.kind !== "credential") {
    throw new HttpTestFixtureRequestError(
      'gx.test HTTP fixture kind must be "raw" or "credential"',
    );
  }
  if (!(input.request instanceof Request)) {
    throw new HttpTestFixtureRequestError(
      "gx.test HTTP fixture matching requires a Request",
    );
  }

  let credentialKey: string | undefined;
  if (input.kind === "credential") {
    if (
      typeof input.credentialKey !== "string" ||
      !CREDENTIAL_KEY.test(input.credentialKey)
    ) {
      throw new HttpTestFixtureRequestError(
        "gx.test credential fixture matching requires a valid credential key",
      );
    }
    credentialKey = input.credentialKey;
  } else if (input.credentialKey !== undefined) {
    throw new HttpTestFixtureRequestError(
      "gx.test raw HTTP fixture matching must not receive a credential key",
    );
  }

  let url: string;
  try {
    url = normalizeUrl(input.request.url, "intercepted_request.url");
  } catch (error) {
    throw new HttpTestFixtureRequestError(
      error instanceof Error
        ? error.message
        : "gx.test intercepted an invalid HTTP URL",
    );
  }
  return {
    kind: input.kind,
    method: normalizeMethod(
      input.request.method,
      "intercepted_request.method",
    ),
    url,
    ...(credentialKey ? { credentialKey } : {}),
  };
}

/**
 * Finds the first exact fixture for an intercepted request.
 *
 * The request body is cloned and read after method/URL/kind matching so the
 * global body bound is enforced even when no fixture constrains its digest. A
 * null result is terminal for gx.test: the host binding must record/block it
 * rather than perform real network I/O.
 */
export async function findHttpTestFixtureMatch(
  fixtures: HttpTestFixtureConfig | null | undefined,
  attempt: HttpTestFixtureAttempt,
): Promise<HttpTestFixtureMatch> {
  const normalized = normalizeAttempt(attempt);
  // Enforce the per-attempt body bound even for an otherwise unmatched
  // method/URL/kind. A caught miss must not provide an unbounded request-body
  // path around the invocation's 32-attempt admission limit.
  const body = await readBoundedRequestBody(attempt.request);
  if (!fixtures || fixtures.length === 0) {
    return { fixture: null, requestBodyBytes: body.byteLength };
  }
  const candidates = fixtures.filter((fixture) =>
    fixture.kind === normalized.kind &&
    fixture.request.method === normalized.method &&
    fixture.request.url === normalized.url &&
    (fixture.kind !== "credential" ||
      fixture.credential_key === normalized.credentialKey)
  );
  if (candidates.length === 0) {
    return { fixture: null, requestBodyBytes: body.byteLength };
  }

  let bodyHash: string | undefined;
  if (candidates.some((fixture) => fixture.request.body_sha256)) {
    bodyHash = await sha256HttpTestFixtureBody(body);
  }
  const fixture = candidates.find((candidate) =>
    candidate.request.body_sha256 === undefined ||
    candidate.request.body_sha256 === bodyHash
  );
  return { fixture: fixture ?? null, requestBodyBytes: body.byteLength };
}

export async function findHttpTestFixture(
  fixtures: HttpTestFixtureConfig | null | undefined,
  attempt: HttpTestFixtureAttempt,
): Promise<HttpTestFixture | null> {
  return (await findHttpTestFixtureMatch(fixtures, attempt)).fixture;
}

/**
 * Exact bytes copied into the synthetic response, plus normalized header
 * names/values. Used by the invocation-owned exchange budget before allocating
 * a Response body.
 */
export function httpTestFixtureResponseSizeBytes(
  fixture: HttpTestFixture,
): number {
  let bytes = Object.entries(fixture.response.headers).reduce(
    (sum, [name, value]) => sum + utf8Length(name) + utf8Length(value),
    0,
  );
  if (fixture.response.body_text !== undefined) {
    return bytes + utf8Length(fixture.response.body_text);
  }
  const encoded = fixture.response.body_base64!;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  bytes += (encoded.length / 4) * 3 - padding;
  return bytes;
}

/** Creates a fresh Response for one matched fixture without any network I/O. */
export function materializeHttpTestFixtureResponse(
  fixture: HttpTestFixture,
): Response {
  const body = fixture.response.body_text !== undefined
    ? textEncoder.encode(fixture.response.body_text)
    : decodeBase64(
      fixture.response.body_base64!,
      `http_fixture.${fixture.id}.response.body_base64`,
    );
  return new Response(exactArrayBuffer(body), {
    status: fixture.response.status,
    headers: fixture.response.headers,
  });
}
