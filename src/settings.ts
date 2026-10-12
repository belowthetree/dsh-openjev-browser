/**
 * Plugin-owned settings file: `$DSH_HOME/dsh-openjev-browser.settings.json`.
 *
 * Why not the cordis patch files? The settings page writes user choices at
 * runtime; hand-editing the loader's patch YAML from inside the plugin risks
 * breaking the whole harness on a malformed write. A small JSON file owned by
 * this plugin is atomic to replace, safe to hand-edit, and merges over the
 * loader-provided config with a clear precedence:
 *
 *   built-in defaults  <  loader patch config  <  settings file (UI)
 *
 * The file is read once at apply() time (so a restart always picks it up) and
 * re-read/written by the HTTP API (see api.ts). Writes go through a .tmp
 * rename so a crash mid-write cannot corrupt the previous settings.
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const SETTINGS_FILENAME = 'dsh-openjev-browser.settings.json'

/** Resolve the harness home directory ($DSH_HOME, default ~/.dsh). */
export function resolveDshHome(configured?: string): string {
  if (configured) return configured
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return join(homedir(), '.dsh')
}

export function settingsFilePath(dshHome?: string): string {
  return join(resolveDshHome(dshHome), SETTINGS_FILENAME)
}

/** Subset of PluginConfig the settings page is allowed to persist. */
export interface SavedSettings {
  openjevUrl?: string
  modelDir?: string
  pythonPath?: string
  autoStartServer?: boolean
  serverPort?: number
  modelRepo?: string
  browser?: string
  headed?: boolean
}

const SAVED_KEYS: (keyof SavedSettings)[] = [
  'openjevUrl',
  'modelDir',
  'pythonPath',
  'autoStartServer',
  'serverPort',
  'modelRepo',
  'browser',
  'headed',
]

/** Read the settings file; missing/corrupt files yield {} (fail soft). */
export function loadSettings(dshHome?: string): SavedSettings {
  const file = settingsFilePath(dshHome)
  try {
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: SavedSettings = {}
    for (const key of SAVED_KEYS) {
      const value = (parsed as Record<string, unknown>)[key]
      if (typeof value === 'string' && value) (out as Record<string, unknown>)[key] = value
      else if (typeof value === 'boolean' || typeof value === 'number') {
        ;(out as Record<string, unknown>)[key] = value
      }
    }
    return out
  } catch {
    return {}
  }
}

/** Persist settings atomically (write .tmp then rename). */
export function saveSettings(settings: SavedSettings, dshHome?: string): string {
  const file = settingsFilePath(dshHome)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return file
}

/** Merge loader-provided raw config with the settings file (file wins). */
export function mergeWithSettings(loaderConfig: unknown, dshHome?: string): Record<string, unknown> {
  const base =
    typeof loaderConfig === 'object' && loaderConfig !== null && !Array.isArray(loaderConfig)
      ? { ...(loaderConfig as Record<string, unknown>) }
      : {}
  const saved = loadSettings(dshHome)
  for (const key of SAVED_KEYS) {
    const value = (saved as Record<string, unknown>)[key]
    if (value === undefined || value === '') delete base[key]
    if (value !== undefined) base[key] = value
  }
  return base
}
