// Egress interceptor for the Dynamic Worker sandbox.
//
// Network-capable apps get raw fetch() in their isolate. Without an interceptor
// the loaded isolate's globalOutbound is unrestricted, so a tenant could point
// fetch() at loopback / RFC1918 / link-local (cloud-metadata 169.254.169.254)
// / other internal addresses — an SSRF pivot. This WorkerEntrypoint runs in the
// PARENT isolate; the Worker Loader routes every outbound fetch() from the
// sandbox through its fetch() handler, where guardedFetch() applies the
// destination policy host-side (re-checking every redirect hop) before
// forwarding. No loop: globalOutbound governs only the loaded child isolate;
// this entrypoint runs in the parent, whose fetch() is not subject to it.

import { WorkerEntrypoint } from "cloudflare:workers";
import { guardedFetch } from "./outbound-policy.ts";

interface OutboundBindingProps {
  appId: string;
  userId: string;
  // Default-deny destination allowlist (the app's manifest network
  // allowed_destinations). [] = no outbound reachable.
  allowedDestinations: string[];
}

export class OutboundBinding
  extends WorkerEntrypoint<unknown, OutboundBindingProps> {
  override fetch(request: Request): Promise<Response> {
    return guardedFetch(request, fetch, {
      allowlist: this.ctx.props.allowedDestinations ?? [],
      // Only the host + reason are logged — never the full URL, which can carry
      // tenant data in the path/query.
      onBlock: (reason, host) => {
        console.warn("[EGRESS] blocked outbound fetch", {
          appId: this.ctx.props.appId,
          userId: this.ctx.props.userId,
          host,
          reason,
        });
      },
    });
  }
}
