#!/usr/bin/env node
/**
 * Setup CLI for dsh-openjev-browser.
 *
 * The plugin ships no model weights and no python runtime — both are
 * user-deployed (see docs/DEPLOYMENT.md; the settings page carries a
 * copy-paste agent prompt that performs the whole setup). This CLI only
 * detects and verifies what is already there:
 *
 *   node lib/setup.js detect                     # probe service/artifact/python
 *   node lib/setup.js print-config               # show a cordis.patch.yml snippet
 *
 * Exit codes: 0 ok / ready, 1 failure.
 */

import {
  DEFAULT_REPO,
  detectStatus,
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
  }
}

const USAGE = `dsh-openjev-browser setup

Commands:
  detect                      Probe the decision service, local artifact and python.
  print-config                Print a cordis.patch.yml snippet with detected settings.

Flags:
  --url <http://host:port>    Decision service URL (default http://127.0.0.1:8080)
  --model-dir <dir>           Existing artifact directory to validate/use
  --python <path>             Python interpreter with the openjev package
  --repo <org/name>           HF repo (default ${DEFAULT_REPO})

Deploying the python environment + model is covered by docs/DEPLOYMENT.md
(the settings page ships the same instructions as a copy-paste agent prompt).
`

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
