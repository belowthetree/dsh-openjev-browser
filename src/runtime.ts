/**
 * Spawn-environment helpers for the python decision server.
 *
 * Two sandbox quirks this module works around (both verified empirically on
 * the DSH Windows host):
 *
 * 1. Spawned children may inherit a restricted token that cannot write the
 *    system temp dir; torch inductor then dies with "No usable temporary
 *    directory found". childEnv() therefore redirects TMP/TEMP/TMPDIR and
 *    TORCHINDUCTOR_CACHE_DIR into a plugin-owned dir under $DSH_HOME.
 *
 * 2. The sandbox confines any executable that lives INSIDE the session
 *    workspace to writes under that workspace (same python.exe: denied under
 *    C:\Users\... when launched from the workspace, unrestricted when copied
 *    outside it). resolveChildTmpDir() probes each interpreter once and, when
 *    the shared tmp dir is not writable from it, falls back to a tmp dir next
 *    to the interpreter (inside the workspace by definition).
 *
 * The python environment itself is user-deployed — see docs/DEPLOYMENT.md;
 * the settings page ships a copy-paste agent prompt that performs the whole
 * setup.
 */

import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { resolveDshHome } from './settings.js'

type Logger = (level: string, message: string) => void

/** Plugin-owned writable temp dir for spawned children (default location). */
export function pluginTmpDir(dshHome?: string): string {
  const dir = join(resolveDshHome(dshHome), 'openjev', 'tmp')
  mkdirSync(dir, { recursive: true })
  return dir
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
    ...extra,
  }
}

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
 * to `.openjev-tmp/` beside the interpreter, which lands inside the same
 * workspace for workspace-resident interpreters.
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
