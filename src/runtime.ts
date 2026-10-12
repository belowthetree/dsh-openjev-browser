/**
 * Managed python runtime: so users do not need to deploy python themselves.
 *
 * The plugin can bootstrap a fully self-contained interpreter under
 * `$DSH_HOME/openjev/`:
 *
 *   bin/uv.exe      single-file env manager (astral-sh/uv, ~15 MB download)
 *   runtime/        venv created by uv with a managed CPython 3.12
 *   tmp/            TMP/TEMP/TORCHINDUCTOR_CACHE_DIR for spawned processes —
 *                   the DSH host sandbox can make the system temp dir
 *                   unusable for plugin-spawned children (torch inductor
 *                   crashes with "No usable temporary directory found").
 *
 * Install pipeline (background job, cancellable, polled by the client):
 *   1. download uv (GitHub release zip, extracted with system tar.exe)
 *   2. `uv venv --python 3.12 <runtimeDir>` (uv fetches a standalone python)
 *   3. `uv pip install torch --index-url <torchIndex>` (CPU build by default
 *      — the CUDA wheels are ~2.5 GB heavier; selectable via torchIndex)
 *   4. `uv pip install "<runtimeSpec>"` (default: openjev[serve] from git)
 *   5. validate `import openjev`, write install.json marker
 *
 * Detection order for the decision server python (model.ts): explicit
 * config `pythonPath` > this managed runtime > $OPENJEV_PYTHON > PATH.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

import { resolveDshHome } from './settings.js'

export const DEFAULT_RUNTIME_SPEC = 'openjev[serve] @ git+https://github.com/ejhshen/OpenJev.git'
export const DEFAULT_TORCH_INDEX = 'https://download.pytorch.org/whl/cpu'

export const TORCH_INDEXES: Record<string, string> = {
  cpu: 'https://download.pytorch.org/whl/cpu',
  cu126: 'https://download.pytorch.org/whl/cu126',
  cu128: 'https://download.pytorch.org/whl/cu128',
}

type Logger = (level: string, message: string) => void

// ---------------------------------------------------------------------------
// Paths.
// ---------------------------------------------------------------------------

export function defaultRuntimeDir(dshHome?: string): string {
  return join(resolveDshHome(dshHome), 'openjev', 'runtime')
}

export function uvBinaryPath(dshHome?: string): string {
  const name = process.platform === 'win32' ? 'uv.exe' : 'uv'
  return join(resolveDshHome(dshHome), 'openjev', 'bin', name)
}

/** Plugin-owned writable temp dir for spawned children (default location). */
export function pluginTmpDir(dshHome?: string): string {
  const dir = join(resolveDshHome(dshHome), 'openjev', 'tmp')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function managedPythonPath(runtimeDir?: string): string {
  const dir = runtimeDir ?? defaultRuntimeDir()
  return process.platform === 'win32'
    ? join(dir, 'Scripts', 'python.exe')
    : join(dir, 'bin', 'python')
}

/** Managed runtime python, but only when the venv actually exists. */
export function managedPythonIfExists(runtimeDir?: string): string | undefined {
  const python = managedPythonPath(runtimeDir)
  return existsSync(python) ? python : undefined
}

/**
 * Env for spawned children: redirect temp dirs into a plugin-owned dir.
 * `tmpDir` defaults to pluginTmpDir(); pass resolveChildTmpDir(python) when
 * spawning a python that may live inside the DSH session workspace.
 */
export function childEnv(extra?: Record<string, string>, tmpDir?: string): NodeJS.ProcessEnv {
  const tmp = tmpDir ?? pluginTmpDir()
  mkdirSync(tmp, { recursive: true })
  return {
    ...process.env,
    TMP: tmp,
    TEMP: tmp,
    TMPDIR: tmp,
    TORCHINDUCTOR_CACHE_DIR: join(tmp, 'torchinductor'),
    UV_CACHE_DIR: join(resolveDshHome(), 'openjev', 'uv-cache'),
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// Workspace-confined python workaround.
//
// The DSH Windows sandbox confines any executable that lives INSIDE the
// session workspace to writes under that workspace (verified empirically:
// the same python.exe is denied under C:\Users\... when launched from the
// workspace, and unrestricted when copied outside it). A user-configured
// pythonPath pointing at a workspace venv therefore cannot use the default
// temp dir under $DSH_HOME. Detect this per interpreter with a tiny probe
// and fall back to a temp dir next to the interpreter (which is inside the
// workspace by definition). The managed runtime lives under $DSH_HOME and
// is never confined, so the probe passes and the default tmp is used.
// ---------------------------------------------------------------------------

const TMP_PROBE = [
  'import os',
  "d = os.environ['TMP']",
  'try:',
  '    os.makedirs(d, exist_ok=True)',
  "    p = os.path.join(d, '.ojb-probe')",
  "    open(p, 'w').close()",
  '    os.remove(p)',
  "    print('OJB_TMP_OK')",
  'except Exception:',
  '    pass',
].join('\n')

const tmpDirCache = new Map<string, string>()

/**
 * Temp dir the given python can actually write to. Probes the default
 * pluginTmpDir() once per interpreter path (cached); on failure falls back
 * to `<python>/../../.openjev-tmp`, which lands inside the same workspace
 * for workspace-resident interpreters.
 */
export function resolveChildTmpDir(pythonExe: string, log?: Logger): string {
  const key = resolve(pythonExe)
  const hit = tmpDirCache.get(key)
  if (hit) return hit
  let dir = pluginTmpDir()
  try {
    const probe = spawnSync(pythonExe, ['-c', TMP_PROBE], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, TMP: dir, TEMP: dir, TMPDIR: dir },
    })
    if (!(probe.status === 0 && probe.stdout.includes('OJB_TMP_OK'))) {
      dir = resolve(join(pythonExe, '..', '..', '.openjev-tmp'))
      log?.('info', `dsh-openjev-browser: ${pythonExe} cannot write the shared tmp dir (workspace-confined); using ${dir}`)
    }
  } catch {
    dir = resolve(join(pythonExe, '..', '..', '.openjev-tmp'))
  }
  mkdirSync(dir, { recursive: true })
  tmpDirCache.set(key, dir)
  return dir
}

// ---------------------------------------------------------------------------
// uv bootstrap.
// ---------------------------------------------------------------------------

function uvAssetName(): string {
  if (process.platform === 'win32') return 'uv-x86_64-pc-windows-msvc.zip'
  if (process.platform === 'darwin') return 'uv-aarch64-apple-darwin.tar.gz'
  return 'uv-x86_64-unknown-linux-gnu.tar.gz'
}

async function downloadToFile(url: string, dest: string, signal: AbortSignal): Promise<number> {
  const res = await fetch(url, { signal, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`下载失败 ${url}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  mkdirSync(join(dest, '..'), { recursive: true })
  writeFileSync(dest, buf)
  return buf.length
}

/** Download uv into $DSH_HOME/openjev/bin when missing; returns its path. */
async function ensureUv(log: Logger, signal: AbortSignal, onLine: (line: string) => void): Promise<string> {
  const existing = uvBinaryPath()
  if (existsSync(existing)) return existing
  const url = `https://github.com/astral-sh/uv/releases/latest/download/${uvAssetName()}`
  onLine(`下载 uv: ${url}`)
  const binDir = join(uvBinaryPath(), '..')
  mkdirSync(binDir, { recursive: true })
  const archive = join(binDir, uvAssetName())
  const bytes = await downloadToFile(url, archive, signal)
  onLine(`uv 压缩包 ${(bytes / 1024 / 1024).toFixed(1)} MB,解压中`)
  // Windows 10+ ships bsdtar as C:\Windows\System32\tar.exe, which handles
  // both .zip and .tar.gz — no extra dependency needed.
  const untar = spawnSync('tar', ['-xf', archive, '-C', binDir], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: childEnv(),
  })
  if (untar.error || untar.status !== 0) {
    throw new Error(`解压 uv 失败: ${untar.error?.message ?? untar.stderr ?? `exit ${untar.status}`}`)
  }
  if (!existsSync(existing)) throw new Error('解压后未找到 uv 可执行文件')
  log('info', `dsh-openjev-browser: uv ready at ${existing}`)
  return existing
}

// ---------------------------------------------------------------------------
// Runtime manager (single background install job).
// ---------------------------------------------------------------------------

export type RuntimePhase = 'uv' | 'python' | 'torch' | 'openjev' | 'validate'

export interface RuntimeSnapshot {
  state: 'missing' | 'installing' | 'ready' | 'error'
  dir: string
  python?: string
  version?: string
  phase?: RuntimePhase
  /** Last output line of the running installer (rolling progress display). */
  log?: string
  error?: string
  spec?: string
  torchIndex?: string
  startedAt?: string
  finishedAt?: string
}

interface InstallMarker {
  spec: string
  torchIndex: string
  installedAt: string
}

const MARKER = 'install.json'

export class RuntimeManager {
  private state: RuntimeSnapshot
  private abort: AbortController | null = null
  private child: ChildProcess | null = null
  private probeCache: { ok: boolean; version?: string } | null = null

  constructor(
    private readonly dirFn: () => string,
    private readonly log: Logger,
  ) {
    this.state = { state: 'missing', dir: this.dir }
  }

  private get dir(): string {
    return this.dirFn()
  }

  snapshot(): RuntimeSnapshot {
    if (this.state.state === 'installing') return { ...this.state }
    const python = managedPythonPath(this.dir)
    if (!existsSync(python)) {
      this.probeCache = null
      return { state: 'missing', dir: this.dir }
    }
    if (!this.probeCache) {
      // Cheap readiness check, done once per process (import probe ~1-3 s).
      const probe = spawnSync(
        python,
        ['-c', 'import sys, openjev; print(sys.version.split()[0])'],
        { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: childEnv() },
      )
      this.probeCache =
        !probe.error && probe.status === 0
          ? { ok: true, version: probe.stdout.trim().split('\n')[0] }
          : { ok: false }
    }
    if (this.probeCache.ok) {
      const marker = this.readMarker()
      return {
        state: 'ready',
        dir: this.dir,
        python,
        version: this.probeCache.version,
        spec: marker?.spec,
        torchIndex: marker?.torchIndex,
      }
    }
    return { state: 'error', dir: this.dir, python, error: '运行时存在但 import openjev 失败,请重新安装' }
  }

  private readMarker(): InstallMarker | undefined {
    try {
      const file = join(this.dir, MARKER)
      if (!existsSync(file)) return undefined
      return JSON.parse(readFileSync(file, 'utf8')) as InstallMarker
    } catch {
      return undefined
    }
  }

  cancel(): RuntimeSnapshot {
    if (this.abort) {
      this.abort.abort()
      try {
        this.child?.kill()
      } catch {
        // already gone
      }
      this.log('info', 'dsh-openjev-browser: runtime install cancel requested')
    }
    return this.snapshot()
  }

  /** True while an install is running (for API 409s). */
  get installing(): boolean {
    return this.state.state === 'installing'
  }

  async install(spec: string, torchIndex: string): Promise<RuntimeSnapshot> {
    if (this.installing) throw new Error('已有运行时安装任务正在进行')
    this.abort = new AbortController()
    this.probeCache = null
    this.state = {
      state: 'installing',
      dir: this.dir,
      phase: 'uv',
      spec,
      torchIndex,
      startedAt: new Date().toISOString(),
    }
    void this.run(spec, torchIndex, this.abort.signal)
    return this.snapshot()
  }

  private setPhase(phase: RuntimePhase, line?: string): void {
    this.state = { ...this.state, phase, ...(line ? { log: line } : {}) }
  }

  private async run(spec: string, torchIndex: string, signal: AbortSignal): Promise<void> {
    const onLine = (line: string) => {
      this.state = { ...this.state, log: line }
    }
    try {
      this.setPhase('uv')
      const uv = await ensureUv(this.log, signal, onLine)

      this.setPhase('python', '创建 Python 3.12 虚拟环境(uv 会自动下载独立解释器)')
      if (!existsSync(managedPythonPath(this.dir))) {
        await this.exec(uv, ['venv', '--python', '3.12', this.dir], signal, onLine)
      }

      const python = managedPythonPath(this.dir)
      this.setPhase('torch', `安装 torch(索引 ${torchIndex},CPU 版约 200 MB)`)
      await this.exec(
        uv,
        ['pip', 'install', '--python', python, 'torch', '--index-url', torchIndex],
        signal,
        onLine,
      )

      this.setPhase('openjev', `安装 ${spec}`)
      await this.exec(uv, ['pip', 'install', '--python', python, spec], signal, onLine)

      this.setPhase('validate', '验证 import openjev')
      await this.exec(python, ['-c', 'import openjev; print(openjev.__file__)'], signal, onLine)

      const marker: InstallMarker = { spec, torchIndex, installedAt: new Date().toISOString() }
      writeFileSync(join(this.dir, MARKER), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
      this.probeCache = null
      this.state = {
        ...this.snapshot(),
        state: 'ready',
        finishedAt: new Date().toISOString(),
      }
      this.log('info', `dsh-openjev-browser: managed runtime ready at ${this.dir}`)
    } catch (err) {
      const message = (err as Error).message
      const cancelled = signal.aborted || /abort/i.test(message)
      this.probeCache = null
      this.state = {
        state: cancelled ? 'missing' : 'error',
        dir: this.dir,
        error: cancelled ? undefined : message,
        finishedAt: new Date().toISOString(),
      }
      if (!cancelled) this.log('warn', `dsh-openjev-browser: runtime install failed: ${message}`)
    } finally {
      this.abort = null
      this.child = null
    }
  }

  /** Run one installer step, streaming stderr's last line into the snapshot. */
  private exec(
    cmd: string,
    args: string[],
    signal: AbortSignal,
    onLine: (line: string) => void,
  ): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      if (signal.aborted) {
        rejectPromise(new Error('aborted'))
        return
      }
      const child = spawn(cmd, args, { windowsHide: true, env: childEnv() })
      this.child = child
      let tail = ''
      const collect = (buf: Buffer) => {
        tail = (tail + buf.toString('utf8')).slice(-4000)
        const lines = tail.trim().split(/\r?\n/)
        const last = lines[lines.length - 1]?.trim()
        if (last) onLine(last.slice(0, 200))
      }
      child.stderr?.on('data', collect)
      child.stdout?.on('data', collect)
      child.on('error', (err) => rejectPromise(new Error(`${cmd}: ${err.message}`)))
      child.on('exit', (code) => {
        this.child = null
        if (signal.aborted) rejectPromise(new Error('aborted'))
        else if (code === 0) resolvePromise()
        else rejectPromise(new Error(`${cmd} ${args[0] ?? ''} 失败(exit ${code}): ${tail.trim().split(/\r?\n/).pop() ?? ''}`))
      })
      signal.addEventListener('abort', () => {
        try {
          child.kill()
        } catch {
          // already gone
        }
      }, { once: true })
    })
  }
}
