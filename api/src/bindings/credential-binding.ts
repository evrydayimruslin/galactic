// Phase 3 credential vault — host-side "use-don't-return" binding.
//
// Runs in the PARENT isolate. The sandbox names a vaulted per-user credential by
// KEY (never the value); this binding looks up the decrypted value from its
// props, attaches it to the outbound request per the manifest inject method, and
// forwards through guardedFetch (Phase 2 allowlist + SSRF). The sandbox receives
// only the Response — the secret value never crosses into app code.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { ResolvedCredential } from "../../../shared/contracts/env.ts";
import { guardedFetch } from "./outbound-policy.ts";
import {
  type CredentialRequestInit,
  prepareCredentialRequest,
} from "./credential-inject.ts";

interface CredentialBindingProps {
  appId: string;
  userId: string;
  // Default-deny egress allowlist (manifest network.allowed_destinations).
  allowedDestinations: string[];
  // Decrypted per-user credentials keyed by env var name. PARENT-SIDE ONLY.
  credentials: Record<string, ResolvedCredential>;
}

export class CredentialBinding
  extends WorkerEntrypoint<unknown, CredentialBindingProps> {
  // Named authenticatedFetch (not fetch) to avoid overriding WorkerEntrypoint's
  // reserved fetch(request) HTTP handler.
  async authenticatedFetch(
    credentialKey: string,
    url: string,
    init?: CredentialRequestInit,
  ): Promise<Response> {
    const prepared = prepareCredentialRequest(
      credentialKey,
      url,
      init,
      this.ctx.props.credentials,
    );
    const request = new Request(prepared.url, {
      method: prepared.method,
      headers: prepared.headers,
      body: prepared.method === "GET" || prepared.method === "HEAD"
        ? null
        : prepared.body,
      // Single hop: never follow a redirect while carrying the secret. A custom
      // inject header (e.g. X-Api-Key) is not stripped cross-origin, so a
      // redirect off the declared destination could otherwise leak it. The app
      // can follow a 3xx itself (to an allowlisted host) if it needs to.
      redirect: "manual",
    });
    return await guardedFetch(request, fetch, {
      allowlist: this.ctx.props.allowedDestinations,
      onBlock: (reason, host) => {
        // Host + reason only — never the URL (path/query can carry tenant data).
        console.warn("[CRED] blocked credential fetch", {
          appId: this.ctx.props.appId,
          userId: this.ctx.props.userId,
          host,
          reason,
        });
      },
    });
  }
}
