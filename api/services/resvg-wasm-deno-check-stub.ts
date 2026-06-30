// Deno check only: api/deno.check.json maps @resvg/resvg-wasm/index_bg.wasm
// here so Deno's analyzer does not try to parse the binary wasm asset as source.
const wasmModule = {} as WebAssembly.Module;

export default wasmModule;
