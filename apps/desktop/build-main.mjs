/**
 * Bundles the Electron main process, the preload script, and everything the
 * daemon needs into standalone files.
 *
 * The daemon is a workspace package that npm hoists to the repo root as a
 * symlink, which electron-builder cannot follow into an app bundle. Bundling
 * sidesteps packaging the dependency tree altogether: the shipped app resolves
 * nothing at runtime.
 */
import { build } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  // Electron supplies its own; ws's optional native speedups are not needed.
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  logLevel: 'info',
};

await build({
  ...shared,
  entryPoints: ['electron/main.mjs'],
  outfile: 'out/main.mjs',
  format: 'esm',
  banner: {
    // Inlined CommonJS dependencies (ws) call `require`, which does not exist
    // in an ES module. Only `require` is shimmed here: the entry point declares
    // its own __dirname from import.meta.url, and redeclaring it here is a
    // syntax error that stops the app loading.
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
});

await build({
  ...shared,
  entryPoints: ['electron/preload.cjs'],
  outfile: 'out/preload.cjs',
  format: 'cjs',
});

console.log('main process bundled to out/');
