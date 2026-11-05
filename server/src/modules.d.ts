// Ambient declarations for the Worker bundle (wrangler / esbuild).

/** A `.wasm` import is a compiled WebAssembly.Module in workerd (rule CompiledWasm in wrangler.jsonc). */
declare module '*.wasm' {
  const mod: WebAssembly.Module;
  export default mod;
}

/** A `.md` import is its text in workerd (rule Text in wrangler.jsonc): docs/legal/*.md and docs/about/*.md, legalPages.ts. */
declare module '*.md' {
  const text: string;
  export default text;
}
