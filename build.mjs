/** Build: type-check + emit host sources via the TypeScript compiler (no
 * esbuild service spawn for the host half), then bundle the client half
 * (settings page) with esbuild into the __ModuleLoader__ format. */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
  cwd: root,
  stdio: 'inherit',
})
if (result.status !== 0) process.exit(result.status ?? 1)

// tsc does not carry shebangs; add one to the CLI entry.
const setupJs = join(root, 'lib', 'setup.js')
const source = readFileSync(setupJs, 'utf8')
if (!source.startsWith('#!')) {
  writeFileSync(setupJs, `#!/usr/bin/env node\n${source}`)
}
console.log('built lib/ (tsc)')

// Client half: esbuild bundles src/client/ into lib/client.js. Externals
// (react, dsh client packages) are provided by the DSH __ModuleLoader__.
const esbuild = await import('esbuild')
await esbuild.build({
  entryPoints: [join(root, 'src', 'client', 'index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  outfile: join(root, 'lib', 'client.js'),
  logLevel: 'warning',
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    'react-dom/client',
    '@deepseek-ai/*',
  ],
  banner: {
    js: 'window.__ModuleLoader__.load({id:"dsh-openjev-browser",factory:(require)=>{var module={exports:{}};var exports=module.exports;',
  },
  footer: {
    js: 'return module.exports;}});',
  },
})
console.log('built lib/client.js (esbuild)')

