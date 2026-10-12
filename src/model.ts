/**
 * OpenJev model management: artifact validation, environment detection and a
 * managed decision-server subprocess.
 *
 * The plugin repository ships no model weights. After install, the plugin
 * detects (in order):
 *   1. an already-running decision service at `openjevUrl` (GET /health);
 *   2. a local model artifact (config `modelDir`, env vars, conventional
 *      directories) validated against its manifest + COMPLETE marker;
 *   3. a python interpreter with the `openjev` package to serve that artifact.
 *
 * With (2)+(3) the plugin spawns `python -m openjev.runtime.server` itself and
 * waits for readiness. With neither, model-dependent tools fail soft with
 * structured setup guidance (see setupGuidance()).
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

import { OpenJevClient } from './openjev.js'

export const DEFAULT_REPO = 'shenjunhao/OpenJev-4B'

// ---------------------------------------------------------------------------
// Artifact validation (ported from openjev/artifacts.py load_manifest).
// ---------------------------------------------------------------------------

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export interface ArtifactCheck {
  ok: boolean
  error?: string
  files?: number
  totalBytes?: number
}

/**
 * Validate an OpenJev artifact directory: manifest.json must parse with
 * artifact_format_version 1, COMPLETE must equal sha256(manifest.json), and
 * every listed file must exist with the exact recorded byte size.
 */
export function validateArtifact(dir: string): ArtifactCheck {
  try {
    const manifestPath = join(dir, 'manifest.json')
    if (!existsSync(manifestPath)) return { ok: false, error: 'manifest.json missing' }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.artifact_format_version !== 1) {
      return { ok: false, error: `unsupported artifact_format_version: ${manifest.artifact_format_version}` }
    }
    const completePath = join(dir, 'COMPLETE')
    if (!existsSync(completePath)) {
      return { ok: false, error: 'incomplete artifact: COMPLETE marker missing (download unfinished?)' }
    }
    if (readFileSync(completePath, 'utf8').trim() !== sha256File(manifestPath)) {
      return { ok: false, error: 'COMPLETE marker does not match manifest.json' }
    }
    const files = manifest.files as Record<string, { bytes: number }>
    let total = 0
    for (const [name, info] of Object.entries(files)) {
      const entry = join(dir, name)
      if (!existsSync(entry) || statSync(entry).size !== info.bytes) {
        return { ok: false, error: `artifact file missing or wrong size: ${name}` }
      }
      total += info.bytes
    }
    return { ok: true, files: Object.keys(files).length, totalBytes: total }
  } catch (err) {
    return { ok: false, error: `invalid artifact: ${(err as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// Environment detection.
// ---------------------------------------------------------------------------

export interface ModelConfig {
  openjevUrl: string
  modelDir?: string
  pythonPath?: string
  autoStartServer: boolean
  serverPort: number
  serverStartupTimeoutMs: number
  modelRepo: string
  downloadDir: string
}

export function defaultDownloadDir(): string {
  return join(homedir(), '.dsh', 'openjev', 'models', 'OpenJev-4B')
}

/** Candidate artifact directories, highest priority first. */
export function artifactCandidates(configured?: string): string[] {
  const out: string[] = []
  if (configured) out.push(configured)
  for (const env of ['OPENJEV_ARTIFACT', 'OPENJEV_MODEL']) {
    const value = process.env[env]
    if (value) out.push(value)
  }
  out.push(join(homedir(), '.openjev', 'models', 'OpenJev-4B'))
  out.push(defaultDownloadDir())
  return [...new Set(out.map((p) => resolve(p)))]
}

/** Find the first valid artifact directory, reporting why others failed. */
export function findArtifact(configured?: string): { dir?: string; rejected: Record<string, string> } {
  const rejected: Record<string, string> = {}
  for (const dir of artifactCandidates(configured)) {
    if (!existsSync(dir)) continue
    const check = validateArtifact(dir)
    if (check.ok) return { dir, rejected }
    rejected[dir] = check.error ?? 'invalid'
  }
  return { rejected }
}

export interface PythonProbe {
  path?: string
  version?: string
  hasOpenJev: boolean
  error?: string
}

/**
 * Probe a python interpreter for the `openjev` package. Synchronous and cheap
 * enough to run lazily (not at plugin load).
 */
export function probePython(configured?: string): PythonProbe {
  const candidates = configured
    ? [configured]
    : [process.env.OPENJEV_PYTHON, 'python', 'python3', 'py'].filter(Boolean) as string[]
  let lastError = 'no python interpreter found on PATH'
  for (const exe of candidates) {
    try {
      const probe = spawnSync(
        exe,
        ['-c', 'import sys, openjev; print(sys.version.split()[0]); print(openjev.__file__)'],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true },
      )
      if (probe.error) {
        lastError = `${exe}: ${probe.error.message}`
        continue
      }
      if (probe.status === 0) {
        return { path: exe, version: probe.stdout.trim().split('\n')[0], hasOpenJev: true }
      }
      const stderr = (probe.stderr ?? '').trim().split('\n').pop() ?? ''
      lastError = `${exe}: ${stderr || `exit ${probe.status}`}`
    } catch (err) {
      lastError = `${exe}: ${(err as Error).message}`
    }
  }
  return { hasOpenJev: false, error: lastError }
}

// ---------------------------------------------------------------------------
// Managed server subprocess.
// ---------------------------------------------------------------------------

export interface ServerHandle {
  url: string
  artifact: string
  python: string
  pid?: number
}

type Logger = (level: string, message: string) => void

/**
 * Spawn `python -m openjev.runtime.server --artifact <dir>` and wait for
 * /health. The child is killed when the returned handle is disposed.
 */
export async function startServer(
  artifact: string,
  python: string,
  port: number,
  timeoutMs: number,
  log: Logger,
  signal?: AbortSignal,
): Promise<{ handle: ServerHandle; dispose: () => void }> {
  const url = `http://127.0.0.1:${port}`
  const args = [
    '-m', 'openjev.runtime.server',
    '--artifact', artifact,
    '--host', '127.0.0.1',
    '--port', String(port),
  ]
  log('info', `dsh-openjev-browser: starting decision server: ${python} ${args.join(' ')}`)
  const child: ChildProcess = spawn(python, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim()) log('info', `openjev-server: ${line}`)
    }
  })
  child.stdout?.on('data', () => {})
  child.on('exit', (code) => log('warn', `openjev-server: exited with code ${code}`))

  const client = new OpenJevClient(url)
  const deadline = Date.now() + timeoutMs
  let childExited = false
  child.on('exit', () => { childExited = true })
  while (Date.now() < deadline) {
    if (signal?.aborted) break
    if (childExited) throw new Error('decision server exited before becoming ready')
    const health = await client.health(2_500)
    if (health.ok) {
      log('info', `dsh-openjev-browser: decision server ready at ${url} (model=${health.model})`)
      return {
        handle: { url, artifact, python, pid: child.pid },
        dispose: () => { try { child.kill() } catch { /* already gone */ } },
      }
    }
    await new Promise((r) => setTimeout(r, 2_000))
  }
  try { child.kill() } catch { /* already gone */ }
  throw new Error(`decision server did not become ready within ${Math.round(timeoutMs / 1000)}s`)
}

// ---------------------------------------------------------------------------
// Top-level resolution used by the plugin.
// ---------------------------------------------------------------------------

export interface ModelStatus {
  /** Where decisions will actually come from, once resolved. */
  ready: boolean
  transport?: 'http' | 'managed'
  url?: string
  model?: string
  artifact?: { dir?: string; rejected: Record<string, string> }
  python?: PythonProbe
  setup: string[]
}

/** Human/agent-readable setup instructions for the "no model" state. */
export function setupGuidance(config: ModelConfig): string[] {
  return [
    'No OpenJev decision service is available. Pick ONE of:',
    `1) Point the plugin at a running service: set config "openjevUrl" (current: ${config.openjevUrl}) - or start one with: python -m openjev.runtime.server --artifact <model-dir> --port ${config.serverPort}`,
    `2) Already have the model files? Set config "modelDir" to the artifact directory (must contain manifest.json + COMPLETE). The plugin auto-starts a server when a python with the openjev package is available ("pythonPath").`,
    `3) Download the model: node <plugin>/lib/setup.js download --dir <target-dir> (HF repo ${config.modelRepo}, ~8 GB). Default target: ${config.downloadDir}`,
    'Then call browser_status to re-run detection.',
  ]
}

/**
 * Resolve where decisions come from. Cheap: one HTTP probe + filesystem stat
 * calls. Never spawns anything; see ensureClient() for the auto-start path.
 */
export async function detectStatus(config: ModelConfig): Promise<ModelStatus> {
  const client = new OpenJevClient(config.openjevUrl)
  const health = await client.health(2_500)
  const artifact = findArtifact(config.modelDir)
  const status: ModelStatus = {
    ready: health.ok,
    setup: [],
    artifact,
  }
  if (health.ok) {
    status.transport = 'http'
    status.url = config.openjevUrl
    status.model = health.model
    return status
  }
  if (artifact.dir && config.autoStartServer) {
    status.python = probePython(config.pythonPath)
    if (status.python.hasOpenJev) {
      status.setup = [
        `Model artifact OK at ${artifact.dir} and python is available; the server will auto-start on the first model-dependent call.`,
      ]
      return status
    }
  }
  status.setup = setupGuidance(config)
  return status
}

/**
 * Resolve a usable OpenJevClient: probe the configured URL first; if down and
 * a valid artifact + python exist, spawn a managed server (once) and use it.
 * Throws Error with setup guidance when nothing works.
 */
export class ModelManager {
  private client: OpenJevClient | null = null
  private managedDispose: (() => void) | null = null
  private starting: Promise<OpenJevClient> | null = null

  constructor(
    private readonly config: ModelConfig,
    private readonly log: Logger,
  ) {}

  /** Non-throwing status for the browser_status tool. */
  async status(): Promise<ModelStatus> {
    const status = await detectStatus(this.config)
    if (this.managedDispose && status.transport !== 'managed') {
      status.transport = 'managed'
      status.url = `http://127.0.0.1:${this.config.serverPort}`
      status.ready = true
    }
    return status
  }

  async ensureClient(signal?: AbortSignal): Promise<OpenJevClient> {
    if (this.client) {
      const health = await this.client.health(2_500)
      if (health.ok) return this.client
      this.client = null
    }
    if (!this.starting) {
      this.starting = this.resolveClient(signal).finally(() => { this.starting = null })
    }
    return this.starting
  }

  private async resolveClient(signal?: AbortSignal): Promise<OpenJevClient> {
    const direct = new OpenJevClient(this.config.openjevUrl)
    const health = await direct.health(2_500)
    if (health.ok) {
      this.client = direct
      return direct
    }
    if (this.config.autoStartServer) {
      const artifact = findArtifact(this.config.modelDir)
      if (artifact.dir) {
        const python = probePython(this.config.pythonPath)
        if (python.hasOpenJev && python.path) {
          const { dispose } = await startServer(
            artifact.dir,
            python.path,
            this.config.serverPort,
            this.config.serverStartupTimeoutMs,
            this.log,
            signal,
          )
          this.managedDispose = dispose
          this.client = new OpenJevClient(`http://127.0.0.1:${this.config.serverPort}`)
          return this.client
        }
        this.log('warn', `dsh-openjev-browser: artifact at ${artifact.dir} but no usable python (${python.error})`)
      }
    }
    throw new Error(setupGuidance(this.config).join('\n'))
  }

  dispose(): void {
    this.managedDispose?.()
    this.managedDispose = null
    this.client = null
  }
}
