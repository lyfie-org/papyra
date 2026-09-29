// Bundle the collab server into one self-contained ESM file. The runtime
// image ships only Node + dist/server.mjs — no node_modules — so every
// dependency (Hocuspocus, Yjs, Lexical, luthor) is inlined here. All of them
// are pure JS, so the bundle is architecture-independent (amd64 + arm64).
import { build } from 'esbuild'

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  sourcemap: 'linked',
  legalComments: 'none',
  // luthor presets pull React for node definitions; production build strips
  // dev-only warnings and keeps a single copy.
  define: { 'process.env.NODE_ENV': '"production"' },
  // Some bundled deps are CJS and call require(); give ESM output one.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
})
