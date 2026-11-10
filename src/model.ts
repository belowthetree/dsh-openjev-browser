/**
 * OpenJev model management: artifact validation, environment detection and a
 * managed decision-server subprocess.
 *
 * The plugin ships no model weights and no python runtime — both are
 * user-deployed (the settings page carries a copy-paste agent prompt that
 * performs the whole setup, see docs/DEPLOYMENT.md). After install the
 * plugin detects (in order):
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
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

import { OpenJevClient } from './openjev.js'
import { childEnv, bundledPythonDir, hasBundledPython, pythonPathEnv, resolveChildTmpDir } from './runtime.js'

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
}

/** Conventional artifact location for user-deployed models. */
export function defaultModelDir(): string {
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
  out.push(defaultModelDir())
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
  /** `openjev` resolves (bundled with the plugin or pip-installed). */
  hasOpenJev: boolean
  /** Import names still missing (torch / fastapi / ...). Empty when usable. */
  missing: string[]
  /** True when the interpreter can actually host the decision server. */
  usable: boolean
  /** Whether `openjev` came from the tree bundled inside the plugin. */
  bundled: boolean
  error?: string
}

/** Modules the decision server imports at runtime (serve extras included). */
const REQUIRED_MODULES = ['openjev', 'torch', 'transformers', 'safetensors', 'numpy', 'huggingface_hub', 'fastapi', 'uvicorn']

const PYTHON_PROBE = [
  'import json, sys',
  'missing = []',
  `for m in ${JSON.stringify(REQUIRED_MODULES)}:`,
  '    try:',
  '        mod = __import__(m)',
  '    except Exception:',
  '        missing.append(m)',
  'print(sys.version.split()[0])',
  'print(json.dumps(missing))',
  'try:',
  '    import openjev',
  '    print(getattr(openjev, "__file__", "") or "")',
  'except Exception:',
  '    print("")',
].join('\n')

/**
 * Probe a python interpreter for the `openjev` package and the third-party
 * modules the server needs. Synchronous and cheap enough to run lazily (not at
 * plugin load). The bundled package is put on PYTHONPATH, so a bare
 * interpreter with the pip dependencies is enough.
 */
export function probePython(configured?: string): PythonProbe {
  const candidates = configured
    ? [configured]
    : ([process.env.OPENJEV_PYTHON, 'python', 'python3', 'py'].filter(Boolean) as string[])
  const env = { ...process.env, ...pythonPathEnv() }
  let lastError = 'no python interpreter found on PATH'
  for (const exe of candidates) {
    try {
      const probe = spawnSync(exe, ['-c', PYTHON_PROBE], {
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
        env,
      })
      if (probe.error) {
        lastError = `${exe}: ${probe.error.message}`
        continue
      }
      if (probe.status === 0) {
        const lines = probe.stdout.trim().split('\n')
        let missing: string[] = []
        try {
          missing = JSON.parse(lines[1] ?? '[]')
        } catch {
          missing = []
        }
        const openjevFile = lines[2] ?? ''
        return {
          path: exe,
          version: lines[0],
          hasOpenJev: !missing.includes('openjev'),
          missing,
          usable: missing.length === 0,
          bundled: openjevFile !== '' && normalize(openjevFile).startsWith(normalize(bundledPythonDir())),
        }
      }
      const stderr = (probe.stderr ?? '').trim().split('\n').pop() ?? ''
      lastError = `${exe}: ${stderr || `exit ${probe.status}`}`
    } catch (err) {
      lastError = `${exe}: ${(err as Error).message}`
    }
  }
  return { hasOpenJev: false, missing: [], usable: false, bundled: false, error: lastError }
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
  // Redirect TMP/TEMP/TORCHINDUCTOR_CACHE_DIR into a dir the child can
  // actually write: the host sandbox makes the system temp dir unusable for
  // spawned children (torch inductor dies with "No usable temporary
  // directory"), and a python living inside the session workspace is
  // confined to workspace writes — resolveChildTmpDir probes for that and
  // falls back to a dir beside the interpreter.
  const child: ChildProcess = spawn(python, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: childEnv(pythonPathEnv(), resolveChildTmpDir(python, log)),
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

/** Quick TCP probe: is anything already listening on host:port? */
function isPortListening(port: number, host = '127.0.0.1', timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ port, host })
    const settle = (result: boolean) => {
      socket.destroy()
      resolvePromise(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

/** Poll /health until it reports ready, the deadline passes or we abort. */
async function waitForReady(
  client: OpenJevClient,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  log: Logger,
): Promise<{ ok: boolean; last?: string }> {
  const deadline = Date.now() + timeoutMs
  let last: string | undefined
  while (Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, last: 'aborted' }
    const health = await client.health(2_500)
    if (health.ok) {
      log('info', `dsh-openjev-browser: decision service ready (model=${health.model})`)
      return { ok: true }
    }
    last = health.error ?? health.status
    await new Promise((r) => setTimeout(r, 2_000))
  }
  return { ok: false, last }
}

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
  const bundled = hasBundledPython() ? ` (bundled at ${bundledPythonDir()})` : ''
  return [
    `No OpenJev decision service is available. The python SERVER CODE ships with this plugin${bundled}; only the third-party runtime and the ~8 GB model weights are user-provided.`,
    `1) Open the plugin setup pane ("OpenJev 设置向导", shown on first use) and pick a model source: download the default HF repo ${config.modelRepo} (resumable, ~8 GB) or point at an existing model directory. It writes "modelDir" for you.`,
    '2) Python runtime: create a python 3.11/3.12 env OUTSIDE the DSH session workspace, then pip install ONLY the dependencies: torch (CPU or CUDA index), transformers==5.12.1, safetensors, numpy, huggingface-hub, plus fastapi + uvicorn for serving. Do NOT pip install openjev from git/pypi — the plugin puts its bundled package on PYTHONPATH. The setup pane reports which modules are missing.',
    `3) Already running a service? Set "openjevUrl" (current: ${config.openjevUrl}), or start one with: python -m openjev.runtime.server --artifact <model-dir> --port ${config.serverPort}`,
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
    if (status.python.usable) {
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
        if (python.usable && python.path) {
          const url = `http://127.0.0.1:${this.config.serverPort}`
          // Someone else — the user, or a previous plugin instance that outlived
          // a reload — may already be starting a server on our port: /health is
          // not ready yet, but the port is bound. Wait for that instance rather
          // than spawning a second one, which would only die on EADDRINUSE.
          if (await isPortListening(this.config.serverPort)) {
            this.log('info', `dsh-openjev-browser: port ${this.config.serverPort} is already bound — waiting for it to become ready`)
            const waited = await waitForReady(new OpenJevClient(url), this.config.serverStartupTimeoutMs, signal, this.log)
            if (waited.ok) {
              this.client = new OpenJevClient(url)
              return this.client
            }
            throw new Error(
              `port ${this.config.serverPort} is in use but no OpenJev service became ready (${waited.last ?? 'unknown'}); ` +
                `free the port, change "serverPort", or stop the other process`,
            )
          }
          try {
            const { dispose } = await startServer(
              artifact.dir,
              python.path,
              this.config.serverPort,
              this.config.serverStartupTimeoutMs,
              this.log,
              signal,
            )
            this.managedDispose = dispose
          } catch (error) {
            // Lost the port race to an instance that started meanwhile: attach
            // to it instead of reporting a spawn failure.
            if (await isPortListening(this.config.serverPort)) {
              const waited = await waitForReady(new OpenJevClient(url), this.config.serverStartupTimeoutMs, signal, this.log)
              if (!waited.ok) throw error
            } else {
              throw error
            }
          }
          this.client = new OpenJevClient(url)
          return this.client
        }
        this.log(
          'warn',
          `dsh-openjev-browser: artifact at ${artifact.dir} but no usable python (${python.error ?? `missing modules: ${python.missing.join(', ')}`})`,
        )
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
