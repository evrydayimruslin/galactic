// Cloudflare Pages Function for /agents/:slug.
//
// Injects per-agent Open Graph / Twitter meta into the SPA shell so social
// crawlers (iMessage, Slack, X, Discord, ...) render a per-agent share card.
// Human visitors still get the full SPA shell and hydrate normally — only the
// <head> meta differs. Non-public agents, or any resolution failure, get the
// unmodified shell (no per-agent card, no leak).
//
// Not typechecked by the build (tsconfig include is ["src"]); wrangler bundles
// functions/ at pages deploy. Kept dependency-free (no @cloudflare/workers-types).

interface AssetsEnv {
  ASSETS: { fetch(req: Request): Promise<Response> };
}

interface PagesContext {
  request: Request;
  params: Record<string, string | string[]>;
  env: AssetsEnv;
}

interface AgentSummary {
  id: string;
  name?: string | null;
  description?: string | null;
  visibility?: string | null;
}

// The API worker host differs by environment and Vite build-time vars aren't
// available to a Pages Function, so derive it from the request host.
function apiBaseFor(url: URL): string {
  const h = url.hostname;
  if (h === "connectgalactic.com" || h === "www.connectgalactic.com") {
    return "https://api.connectgalactic.com";
  }
  // staging Pages preview -> staging API worker
  return "https://ultralight-api-staging.rgn4jz429m.workers.dev";
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clamp(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const { request, params, env } = context;
  const url = new URL(request.url);
  const slug = Array.isArray(params.slug)
    ? params.slug[0]
    : params.slug || "";

  // Always serve the SPA shell so the client app hydrates for human visitors.
  // With no top-level 404.html, the Pages asset server applies its native SPA
  // fallback and returns index.html at 200. (Fetching "/index.html" directly
  // would 308 to "/" via Pages' canonicalization.) A nested assets/404.html
  // independently keeps missing hashed assets out of that fallback.
  const shell = await env.ASSETS.fetch(request);

  let agent: AgentSummary | null = null;
  if (slug) {
    try {
      const resp = await fetch(
        `${apiBaseFor(url)}/api/launch/agents/${encodeURIComponent(slug)}`,
        { headers: { accept: "application/json" } },
      );
      if (resp.ok) {
        const data = (await resp.json()) as { agent?: AgentSummary };
        agent = data?.agent ?? null;
      }
    } catch {
      // fall through to the unmodified shell
    }
  }

  // Only public agents get a per-agent crawlable card.
  if (!agent || agent.visibility !== "public") {
    return shell;
  }

  const name = (agent.name || "Agent").trim();
  const title = `${name}: Galactic Agent`;
  const desc = clamp(agent.description || `${name} on Galactic`, 200);
  const t = escapeAttr(title);
  const d = escapeAttr(desc);
  const img = escapeAttr(`${apiBaseFor(url)}/og/${agent.id}.png`);
  const u = escapeAttr(url.toString());

  const ogBlock = [
    "<!-- og:start -->",
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="Galactic" />',
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta property="og:url" content="${u}" />`,
    `<meta property="og:image" content="${img}" />`,
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${t}" />`,
    `<meta name="twitter:description" content="${d}" />`,
    `<meta name="twitter:image" content="${img}" />`,
    "<!-- og:end -->",
  ].join("\n    ");

  let html = await shell.text();
  html = html.replace(/<!-- og:start -->[\s\S]*?<!-- og:end -->/, ogBlock);
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`);

  const headers = new Headers(shell.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "public, max-age=60");
  return new Response(html, { status: 200, headers });
}
