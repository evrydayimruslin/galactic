// resvg-wasm loader for Cloudflare Workers.
//
// Same rationale as esbuild-wasm-loader.ts: wrangler's bundler needs a *static*
// import of the .wasm file (matching `[[rules]] type = "CompiledWasm"` in
// wrangler.toml) to bundle it into the Worker. A dynamic import with a variable
// path is not statically analyzable, so wrangler skips the wasm and the import
// fails at runtime with `No such module "@resvg/resvg-wasm/index_bg.wasm"`.
//
// Only imported by services/og-card.ts. api/deno.check.json maps this wasm
// import to a TypeScript stub so Deno's analyzer does not parse the binary as
// source; the production Worker build sees this real static wasm import.

// @ts-ignore — wrangler bundles .wasm files as WebAssembly.Module
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";

export default resvgWasm;
