import type { ResolvedCredential } from "../../../shared/contracts/env.ts";
import { hostInAllowlist } from "./outbound-policy.ts";

type ManagedEmailProtocol = "imap" | "smtp";

interface ManagedEmailCredentialInput {
  protocol: ManagedEmailProtocol;
  hostKey: unknown;
  userKey: unknown;
  passKey: unknown;
  port: unknown;
  credentials: Record<string, ResolvedCredential>;
  allowedDestinations?: readonly string[];
  /**
   * galactic.yaml releases opt into the strict contract. Legacy manifests keep
   * accepting their historical key names while still receiving the existing
   * SSRF checks in NetworkBinding.
   */
  strict: boolean;
}

interface ManagedEmailCredentials {
  host: string;
  user: string;
  pass: string;
  port: number;
}

type CredentialRole = "host" | "username" | "password";

function resolveEntry(
  credentials: Record<string, ResolvedCredential>,
  key: unknown,
  protocol: ManagedEmailProtocol,
  role: CredentialRole,
): ResolvedCredential {
  if (typeof key !== "string" || !key) {
    throw new Error(
      `${protocol.toUpperCase()} ${role} must reference a declared setup variable`,
    );
  }
  const entry = credentials[key];
  if (!entry || typeof entry.value !== "string" || !entry.value) {
    throw new Error(
      `${protocol.toUpperCase()} ${role} setup variable is missing or empty`,
    );
  }
  return entry;
}

function conventionalPrefix(
  key: unknown,
  protocol: ManagedEmailProtocol,
  role: CredentialRole,
): string | null {
  if (typeof key !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(key)) {
    return null;
  }
  const suffix = role === "host"
    ? /_HOST$/
    : role === "username"
    ? /_(?:USER|USERNAME)$/
    : /_(?:PASS|PASSWORD)$/;
  const match = key.match(suffix);
  if (!match || match.index === undefined) return null;
  const prefix = key.slice(0, match.index);
  const protocolName = protocol.toUpperCase();
  return prefix === protocolName || prefix.endsWith(`_${protocolName}`)
    ? prefix
    : null;
}

/**
 * Resolve one managed IMAP/SMTP connection without exposing any value to the
 * tenant isolate.
 *
 * For galactic.yaml releases, all three keys must use one explicit protocol
 * prefix (IMAP_HOST/IMAP_USER/IMAP_PASS or e.g.
 * SUPPORT_IMAP_HOST/SUPPORT_IMAP_USERNAME/SUPPORT_IMAP_PASSWORD), none may be
 * an HTTP credential binding, and the resolved host/port must be in the
 * release's destination allowlist. This prevents code from repurposing an
 * unrelated vaulted secret as an email password or redirecting it to another
 * server.
 */
export function resolveManagedEmailCredentials(
  input: ManagedEmailCredentialInput,
): ManagedEmailCredentials {
  const { protocol, credentials } = input;
  const hostEntry = resolveEntry(
    credentials,
    input.hostKey,
    protocol,
    "host",
  );
  const userEntry = resolveEntry(
    credentials,
    input.userKey,
    protocol,
    "username",
  );
  const passEntry = resolveEntry(
    credentials,
    input.passKey,
    protocol,
    "password",
  );
  const port = typeof input.port === "number" ? input.port : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `${protocol.toUpperCase()} port must be an integer from 1 to 65535`,
    );
  }

  if (input.strict) {
    const prefixes = [
      conventionalPrefix(input.hostKey, protocol, "host"),
      conventionalPrefix(input.userKey, protocol, "username"),
      conventionalPrefix(input.passKey, protocol, "password"),
    ];
    if (!prefixes[0] || prefixes.some((prefix) => prefix !== prefixes[0])) {
      throw new Error(
        `${protocol.toUpperCase()} variables must use one protocol-specific HOST/USER/PASS prefix`,
      );
    }
    if (hostEntry.credential || userEntry.credential || passEntry.credential) {
      throw new Error(
        `${protocol.toUpperCase()} variables cannot reuse an HTTP credential binding`,
      );
    }
    if (passEntry.vaulted !== true) {
      throw new Error(
        `${protocol.toUpperCase()} password must be declared as a vaulted password setup variable`,
      );
    }
    if (
      !hostInAllowlist(
        hostEntry.value,
        String(port),
        input.allowedDestinations ?? [],
      )
    ) {
      throw new Error(
        `${protocol.toUpperCase()} destination is not declared by this release`,
      );
    }
  }

  return {
    host: hostEntry.value,
    user: userEntry.value,
    pass: passEntry.value,
    port,
  };
}
