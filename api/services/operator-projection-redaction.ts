/**
 * Deterministic, best-effort credential redaction for owner-visible operator
 * projections. This is intentionally conservative: losing a credential-shaped
 * word is preferable to persisting a usable secret in search or embedding text.
 *
 * The helper never logs or returns the original value through side channels.
 * Callers should still avoid passing raw secret stores into projections.
 */

export const OPERATOR_PROJECTION_REDACTION = "[redacted]";
export const MAX_OPERATOR_PROJECTION_REDACTION_INPUT_CHARS = 16_384;

const TRUNCATION_MARKER = " …[truncated]";

const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----|$)/giu;
const PGP_PRIVATE_KEY_BLOCK =
  /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?(?:-----END PGP PRIVATE KEY BLOCK-----|$)/giu;

// Covers ordinary and JDBC-style URLs, including empty usernames such as
// redis://:password@example.com. The destination remains readable.
const URL_USERINFO = /\b((?:jdbc:)?[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu;

const SENSITIVE_QUERY_KEY = [
  "access(?:_|-|%5f)?token",
  "api(?:_|-|%5f)?key",
  "apikey",
  "auth",
  "authorization",
  "client(?:_|-|%5f)?secret",
  "code",
  "credential",
  "database(?:_|-|%5f)?url",
  "key",
  "password",
  "passwd",
  "private(?:_|-|%5f)?key",
  "refresh(?:_|-|%5f)?token",
  "secret",
  "session(?:_|-|%5f)?token",
  "sig",
  "signature",
  "token",
  "x(?:_|-|%5f)?api(?:_|-|%5f)?key",
].join("|");

const SENSITIVE_QUERY_PARAMETER = new RegExp(
  `([?&](?:${SENSITIVE_QUERY_KEY})=)[^&#\\s]+`,
  "giu",
);

const SENSITIVE_ASSIGNMENT_KEY = [
  "access[_-]?key",
  "access[_-]?token",
  "account[_-]?key",
  "api[_-]?key",
  "apikey",
  "auth[_-]?token",
  "client[_-]?secret",
  "connection[_-]?string",
  "credential",
  "database[_-]?url",
  "db[_-]?(?:pass|password|url)",
  "encryption[_-]?key",
  "password",
  "passwd",
  "private[_-]?key",
  "pwd",
  "refresh[_-]?token",
  "secret",
  "secret[_-]?access[_-]?key",
  "session[_-]?(?:secret|token)",
  "shared[_-]?access[_-]?(?:key|signature)",
  "signing[_-]?key",
  "smtp[_-]?(?:pass|password)",
  "token",
  "webhook[_-]?secret",
  "x[_-]?api[_-]?key",
].join("|");

const SENSITIVE_ASSIGNMENT = new RegExp(
  `((?:"|')?(?:${SENSITIVE_ASSIGNMENT_KEY})(?:"|')?\\s*(?:=|:)\\s*)` +
    `("[^"\\r\\n]{0,8192}"|'[^'\\r\\n]{0,8192}'|[^\\s,;}&\\r\\n]{1,8192})`,
  "giu",
);

const AUTHORIZATION_ASSIGNMENT =
  /((?:"|')?(?:proxy[-_ ]?)?authorization(?:"|')?\s*(?:=|:)\s*)(?:(bearer|basic)\s+)?("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/giu;
const STANDALONE_AUTHORIZATION =
  /(\b(?:bearer|basic)\s+)(?!\[redacted\])[a-z0-9._~+/=-]{8,}/giu;

const TOKEN_PATTERNS: readonly RegExp[] = [
  // Galactic connection and runtime credentials.
  /\bgx(?:[a-z0-9]*_)+[a-z0-9_-]{8,}\b/giu,
  // OpenAI, Stripe, and similarly prefixed secret keys.
  /\bsk[-_][a-z0-9_-]{8,}\b/giu,
  // JWT/JWS compact serialization.
  /\b[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\b/giu,
  // Common hosted-provider credentials.
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\bgithub_pat_[a-z0-9_]{16,}\b/giu,
  /\bgh[pousr]_[a-z0-9]{20,}\b/giu,
  /\bxox[baprs]-[a-z0-9-]{10,}\b/giu,
  /\bAIza[a-z0-9_-]{20,}\b/giu,
];

function redactAssignment(
  _match: string,
  prefix: string,
  rawValue: string,
): string {
  const quote = rawValue[0];
  const quoted = (quote === '"' || quote === "'") &&
    rawValue[rawValue.length - 1] === quote;
  return quoted
    ? `${prefix}${quote}${OPERATOR_PROJECTION_REDACTION}${quote}`
    : `${prefix}${OPERATOR_PROJECTION_REDACTION}`;
}

/**
 * Redacts credential-shaped material while retaining surrounding operator
 * context such as labels, destinations, and recommended navigation.
 */
export function redactOperatorProjectionText(value: string): string {
  let redacted = value.length > MAX_OPERATOR_PROJECTION_REDACTION_INPUT_CHARS
    ? value.slice(0, MAX_OPERATOR_PROJECTION_REDACTION_INPUT_CHARS) +
      TRUNCATION_MARKER
    : value;

  redacted = redacted
    .replace(PRIVATE_KEY_BLOCK, "[redacted private key]")
    .replace(PGP_PRIVATE_KEY_BLOCK, "[redacted private key]")
    .replace(
      AUTHORIZATION_ASSIGNMENT,
      (
        _match: string,
        prefix: string,
        scheme: string | undefined,
      ) =>
        `${prefix}${
          scheme ? `${scheme} ` : ""
        }${OPERATOR_PROJECTION_REDACTION}`,
    )
    .replace(
      STANDALONE_AUTHORIZATION,
      `$1${OPERATOR_PROJECTION_REDACTION}`,
    )
    .replace(URL_USERINFO, `$1${OPERATOR_PROJECTION_REDACTION}@`)
    .replace(
      SENSITIVE_QUERY_PARAMETER,
      `$1${OPERATOR_PROJECTION_REDACTION}`,
    )
    .replace(SENSITIVE_ASSIGNMENT, redactAssignment);

  for (const pattern of TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, OPERATOR_PROJECTION_REDACTION);
  }

  return redacted;
}

/**
 * Returns true only when an identifier contains no credential-shaped material.
 * Persisted action parameters are navigation metadata, so replacing a secret
 * with a redaction marker would create a misleading destination; callers must
 * instead omit the identifier entirely.
 */
export function isOperatorProjectionIdentifierSecretFree(
  value: string,
): boolean {
  return redactOperatorProjectionText(value) === value;
}
