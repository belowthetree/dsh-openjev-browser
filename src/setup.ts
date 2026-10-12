#!/usr/bin/env node
/**
 * Setup CLI for dsh-openjev-browser.
 *
 * The plugin ships no model weights. This CLI detects, downloads and verifies
 * the OpenJev artifact:
 *
 *   node lib/setup.js detect                     # probe service/artifact/python
 *   node lib/setup.js download [--dir <target>]  # fetch from Hugging Face
 *   node lib/setup.js print-config               # show a cordis.patch.yml snippet
 *
 * Exit codes: 0 ok / ready, 1 failure.
 */

import { downloadRepo } from './download.js'
import {
  defaultDownloadDir,
  DEFAULT_REPO,
  detectStatus,
  validateArtifact,
  type ModelConfig,
} from './model.js'

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const [command = 'help', ...rest] = argv
  const flags: Record<string, string> = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = rest[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = 'true'
      }
    }
  }
  return { command, flags }
}

function configFromFlags(flags: Record<string, string>): ModelConfig {
  return {
    openjevUrl: flags.url ?? process.env.OPENJEV_URL ?? 'http://127.0.0.1:8080',
    modelDir: flags['model-dir'] ?? process.env.OPENJEV_ARTIFACT,
    pythonPath: flags.python ?? process.env.OPENJEV_PYTHON,
    autoStartServer: true,
    serverPort: Number(flags.port ?? 8080),
    serverStartupTimeoutMs: 240_000,
    modelRepo: flags.repo ?? DEFAULT_REPO,
    downloadDir: flags.dir ?? defaultDownloadDir(),
  }
}

const USAGE = `dsh-openjev-browser setup

Commands:
  detect                      Probe the decision service, local artifact and python.
  download [--dir <target>]   Download the OpenJev model artifact (~8 GB) from Hugging Face.
  print-config                Print a cordis.patch.yml snippet with detected settings.

Flags:
  --url <http://host:port>    Decision service URL (default http://127.0.0.1:8080)
  --model-dir <dir>           Existing artifact directory to validate/use
  --python <path>             Python interpreter with the openjev package
  --repo <org/name>           HF repo (default ${DEFAULT_REPO})
`

function formatBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GiB`
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MiB`
  return `${n} B`
}

async function cmdDetect(config: ModelConfig): Promise<number> {
  const status = await detectStatus(config)
  console.log(JSON.stringify(status, null, 2))
  if (status.ready) {
    console.log(`\nREADY: decision service reachable at ${status.url} (model=${status.model ?? 'unknown'})`)
    return 0
  }
  if (status.artifact?.dir) {
    console.log(`\nARTIFACT OK: ${status.artifact.dir}`)
    if (status.python?.hasOpenJev) {
      console.log('PYTHON OK: server will auto-start on first use.')
      return 0
    }
  }
  console.log('\nNOT READY. Next steps:')
  for (const line of status.setup) console.log(`  ${line}`)
  return 1
}

async function cmdDownload(config: ModelConfig): Promise<number> {
  const dir = config.downloadDir
  console.log(`Downloading ${config.modelRepo} -> ${dir}`)
  let lastPrint = 0
  await downloadRepo({
    repo: config.modelRepo,
    dir,
    onProgress: (p) => {
      const now = Date.now()
      if (now - lastPrint > 1000) {
        lastPrint = now
        process.stdout.write(`\r[${p.fileIndex}/${p.fileCount}] ${p.file}  total ${formatBytes(p.bytesDone)}   `)
      }
    },
  })
  process.stdout.write('\n')
  const check = validateArtifact(dir)
  if (!check.ok) {
    console.error(`Download finished but validation failed: ${check.error}`)
    console.error('Re-run the command to resume and complete missing files.')
    return 1
  }
  console.log(`OK: artifact verified (${check.files} files, ${formatBytes(check.totalBytes ?? 0)})`)
  console.log(`\nSet this in your plugin config:\n  modelDir: ${JSON.stringify(dir)}`)
  return 0
}

async function cmdPrintConfig(config: ModelConfig): Promise<number> {
  const status = await detectStatus(config)
  console.log('# ~/.dsh/cordis.patch.yml (or your profile patch)')
  console.log('- insert:')
  console.log('  - id: openjev-browser')
  console.log('    name: dsh-openjev-browser')
  console.log('    config:')
  console.log(`      openjevUrl: ${JSON.stringify(config.openjevUrl)}`)
  if (status.artifact?.dir) console.log(`      modelDir: ${JSON.stringify(status.artifact.dir)}`)
  if (status.python?.path) console.log(`      pythonPath: ${JSON.stringify(status.python.path)}`)
  console.log('      browser: auto')
  console.log('      headed: false')
  return 0
}

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2))
  const config = configFromFlags(flags)
  switch (command) {
    case 'detect':
      return cmdDetect(config)
    case 'download':
      return cmdDownload(config)
    case 'print-config':
      return cmdPrintConfig(config)
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE)
      return 0
    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`)
      return 1
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  },
)
