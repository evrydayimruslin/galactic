// Pure credential-injection logic for the Phase 3 vault (no cloudflare:workers
// import, so it is unit-testable under plain Deno). CredentialBinding
// (credential-binding.ts) wraps this + guardedFetch to run it host-side.
//
// SECURITY: the decrypted secret value lives ONLY in the parent isolate. This
// module attaches it to an outbound request and returns the prepared request
// parts; it never returns the value to the caller, and it refuses to send the
// secret anywhere other than the credential's declared destination.

import type { ResolvedCredential } from "../../../shared/contracts/env.ts";
import { hostInAllowlist } from "./outbound-policy.ts";

export interface CredentialRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
}

interface PreparedCredentialRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

// Build the outbound request with the vaulted secret attached per its declared
// inject method. Throws if the key is unknown, has no credential binding, or the
// URL host is not the credential's declared destination (the secret only ever
// travels to its own host — even inside the app's broader allowlist).
export function prepareCredentialRequest(
  credentialKey: string,
  url: string,
  init: CredentialRequestInit | undefined,
  credentials: Record<string, ResolvedCredential>,
): PreparedCredentialRequest {
  const entry = credentials[credentialKey];
  if (!entry) {
    throw new Error(`Unknown credential "${credentialKey}"`);
  }
  const decl = entry.credential;
  if (!decl) {
    throw new Error(
      `Credential "${credentialKey}" has no network binding — declare env_vars["${credentialKey}"].credential in the manifest`,
    );
  }

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error("invalid URL");
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error(`scheme not allowed: ${target.protocol}`);
  }
  // The secret may ONLY be sent to its declared destination (a single host,
  // optionally wildcard/port) — reuses the Phase 2 host matcher.
  if (!hostInAllowlist(target.hostname, target.port, [decl.destination])) {
    throw new Error(
      `Credential "${credentialKey}" is only valid for ${decl.destination}, not ${target.hostname}`,
    );
  }

  const headers: Record<string, string> = { ...(init?.headers ?? {}) };
  let finalUrl = url;
  const inject = decl.inject;
  switch (inject.as) {
    case "bearer":
      headers["Authorization"] = `Bearer ${entry.value}`;
      break;
    case "header":
      headers[inject.name] = `${inject.prefix ?? ""}${entry.value}`;
      break;
    case "basic": {
      const username = inject.username_env
        ? (credentials[inject.username_env]?.value ?? "")
        : "";
      headers["Authorization"] = "Basic " +
        btoa(`${username}:${entry.value}`);
      break;
    }
    case "query":
      target.searchParams.set(inject.name, entry.value);
      finalUrl = target.toString();
      break;
  }

  return {
    url: finalUrl,
    method: (init?.method ?? "GET").toUpperCase(),
    headers,
    body: init?.body ?? null,
  };
}
