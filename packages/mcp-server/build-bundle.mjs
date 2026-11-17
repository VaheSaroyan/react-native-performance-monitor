/**
 * Bundles the MCP server, the daemon it embeds, and their dependencies into a
 * single file.
 *
 * Without this a teammate needs the whole monorepo checked out and installed
 * before Claude can talk to it. Bundled, the only requirement is Node.
 */
import { readFileSync } from 'node:fs';

import { build } from 'esbuild';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['dist/index.js'],
  outfile: 'bundle/rnperf-mcp.mjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // ws's optional native accelerators are genuinely optional.
  external: ['bufferutil', 'utf-8-validate'],
  // So the server reports the version it was actually built from, wherever it
  // is run from — an npm install, or the bare .mjs attached to a release.
  define: { __RNPERF_VERSION__: JSON.stringify(version) },
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});

console.log('MCP server bundled to bundle/rnperf-mcp.mjs');
