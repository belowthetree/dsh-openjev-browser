/** Build: type-check + emit via the TypeScript compiler (no esbuild service
 * spawn, so this also works in restricted sandboxes). */

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
