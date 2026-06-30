// Per-agent OG share card renderer (Worker side).
//
// Rasterizes the layout SVG (services/og-card-layout.ts) to a 1200x630 PNG with
// @resvg/resvg-wasm and writes it to R2 at apps/<appId>/og.png. Called from the
// edit/publish hooks via scheduleCaptureTask (waitUntil). Public agents only.

import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { createR2Service } from "./storage.ts";
import { newsreaderDisplay, newsreaderText } from "./og-assets.ts";
import { buildOgSvg } from "./og-card-layout.ts";

interface OgCardApp {
  id: string;
  slug?: string | null;
  name?: string | null;
  description?: string | null;
  visibility?: string | null;
}

/** R2 object key for an agent's rendered card. Co-located with the icon under
 * apps/<appId>/ so per-app cleanup sweeps it too. */
export function ogCardKey(appId: string): string {
  return `apps/${appId}/og.png`;
}

// ── resvg-wasm init (mirrors ensureEsbuild in services/bundler.ts) ──
let resvgInitialized = false;

async function ensureResvg(): Promise<void> {
  if (resvgInitialized) return;
  try {
    if (typeof globalThis.performance === "undefined") {
      (globalThis as { performance?: { now(): number } }).performance = {
        now: () => Date.now(),
      };
    }
    // Static-import the wrangler-bundled .wasm via a separate loader file so the
    // CompiledWasm rule attaches it. deno.check.json maps the wasm to a stub.
    const loaderMod = await import("./resvg-wasm-loader.ts");
    await initWasm(loaderMod.default);
    resvgInitialized = true;
  } catch (err) {
    // initWasm throws if already initialized in this isolate — treat as success.
    if (/already|initiali[sz]ed/i.test(String(err))) {
      resvgInitialized = true;
    } else {
      throw err;
    }
  }
}

/** Render an agent's card and write it to R2. Public agents only — the serve
 * route is public-only, so a private card would never be served. Idempotent
 * (always overwrites the same key). Never throws into the caller (waitUntil). */
export async function renderAgentOgCard(
  app: OgCardApp,
  opts?: { reason?: string },
): Promise<void> {
  // Rendering needs workerd's bundled wasm; under Deno (tests/local) there is no
  // bundled module, so skip — never importing the loader/wasm there. Mirrors the
  // Deno/CF split in services/bundler.ts ensureEsbuild.
  if (typeof (globalThis as { Deno?: unknown }).Deno !== "undefined") return;
  try {
    if (app.visibility !== "public") return;

    const svg = buildOgSvg(
      app.name || app.slug || "Agent",
      app.description || "",
    );

    await ensureResvg();
    const resvg = new Resvg(svg, {
      fitTo: { mode: "width", value: 1200 },
      font: {
        fontBuffers: [newsreaderText, newsreaderDisplay],
        loadSystemFonts: false,
        defaultFontFamily: "Newsreader",
      },
    });
    const png = resvg.render().asPng();

    await createR2Service().uploadFile(ogCardKey(app.id), {
      name: `${app.id}.png`,
      content: png,
      contentType: "image/png",
    });
  } catch (err) {
    console.error(
      `[og-card] render failed for app ${app.id} (${opts?.reason ?? "unknown"}): ${String(err)}`,
    );
  }
}
