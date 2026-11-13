/**
 * Bundles the MCP server, the daemon it embeds, and their dependencies into a
 * single file.
 *
 * Without this a teammate needs the whole monorepo checked out and installed
 * before Claude can talk to it. Bundled, the only requirement is Node.
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['dist/index.js'],
  outfile: 'bundle/rnperf-mcp.mjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // ws's optional native accelerators are genuinely optional.
  external: ['bufferutil', 'utf-8-validate'],
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});

console.log('MCP server bundled to bundle/rnperf-mcp.mjs');
