/**
 * Runtime environment handling for the browser tool (ported from env.py).
 *
 * Two things need fixing up on a Windows box running inside a restricted
 * (DSH-style) sandbox:
 *
 * - Browsers. Playwright normally wants its own browser download. If a cache
 *   already exists (%LOCALAPPDATA%\ms-playwright) we point at it.
 * - Temp directory. The Playwright driver creates temp dirs; a restricted
 *   token often cannot write into the default %TEMP% (EPERM mkdtemp). We
 *   probe for a writable directory and fall back to <plugin>/.tmp.
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Plugin install root (lib/.. in the built bundle; src/.. under tsx). */
export const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Reuse an existing Playwright browser cache when one is present. */
export function ensureBrowsersPath(): string | null {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH
  const local = process.env.LOCALAPPDATA
  if (local) {
    const candidate = join(local, 'ms-playwright')
    try {
      if (existsSync(candidate) && readdirSync(candidate).some((n) => n.startsWith('chromium-'))) {
        process.env.PLAYWRIGHT_BROWSERS_PATH = candidate
        return candidate
      }
    } catch {
      // not readable -> nothing to reuse
    }
  }
  return null
}

function writable(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true })
    const probe = join(path, '.write-probe')
    writeFileSync(probe, 'ok', 'utf8')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/**
 * Point TEMP/TMP somewhere the browser driver can definitely create files.
 * The check is a real write probe, not an existence test. Preference order:
 * explicit override (OPENJEV_BROWSER_TMP) -> <plugin>/.tmp -> system temp.
 */
export function ensureWritableTemp(): string {
  const override = process.env.OPENJEV_BROWSER_TMP
  const candidates: string[] = []
  if (override) candidates.push(override)
  candidates.push(join(PLUGIN_ROOT, '.tmp'), tmpdir())

  for (const candidate of candidates) {
    if (writable(candidate)) {
      process.env.TEMP = candidate
      process.env.TMP = candidate
      return candidate
    }
  }
  throw new Error('no writable temporary directory found for the browser driver')
}

/** Apply both fix-ups and report what was chosen. */
export function configureEnv(): { browsersPath: string | null; temp: string } {
  return { browsersPath: ensureBrowsersPath(), temp: ensureWritableTemp() }
}
