/**
 * dsh-openjev-browser - native DSH (cordis) plugin port of the
 * openjev-browser MCP stdio tool.
 *
 * Registers browser_open / browser_pick / browser_click / browser_type /
 * browser_text / browser_scroll / browser_screenshot / browser_close plus a
 * new browser_status diagnostics tool.
 *
 * The plugin imports no @deepseek-ai/* packages: the loader only needs the
 * shape below (name / inject / apply), tool definitions are plain objects,
 * and config is validated by hand.
 */

import { buildTools, SessionManager, type PluginDeps } from './tools.js'
import { defaultDownloadDir, ModelManager, type ModelConfig } from './model.js'

export const name = 'dsh-openjev-browser'
export const inject = ['tools']

export interface PluginConfig extends ModelConfig {
  browser: string
  headed: boolean
  userDataDir?: string
  maxCandidates: number
  includeOffscreen: boolean
  maxNameLength: number
  viewport: [number, number]
  timeoutMs: number
  debugDir?: string
}

/** Hand-rolled validation/defaults (no @deepseek-ai/schemastery dependency). */
export function normalizeConfig(input: unknown): PluginConfig {
  const raw = (input ?? {}) as Record<string, unknown>
  const str = (key: string, fallback: string): string =>
    typeof raw[key] === 'string' && raw[key] ? (raw[key] as string) : fallback
  const optStr = (key: string): string | undefined =>
    typeof raw[key] === 'string' && raw[key] ? (raw[key] as string) : undefined
  const num = (key: string, fallback: number): number =>
    Number.isFinite(raw[key]) ? Number(raw[key]) : fallback
  const bool = (key: string, fallback: boolean): boolean =>
    typeof raw[key] === 'boolean' ? (raw[key] as boolean) : fallback
  const viewportRaw = Array.isArray(raw.viewport) && raw.viewport.length === 2
    ? [Number(raw.viewport[0]) || 1280, Number(raw.viewport[1]) || 900]
    : [1280, 900]

  return {
    openjevUrl: str('openjevUrl', 'http://127.0.0.1:8080'),
    modelDir: optStr('modelDir'),
    pythonPath: optStr('pythonPath'),
    autoStartServer: bool('autoStartServer', true),
    serverPort: num('serverPort', 8080),
    serverStartupTimeoutMs: num('serverStartupTimeoutMs', 240_000),
    modelRepo: str('modelRepo', 'shenjunhao/OpenJev-4B'),
    downloadDir: str('downloadDir', defaultDownloadDir()),
    browser: str('browser', 'auto'),
    headed: bool('headed', false),
    userDataDir: optStr('userDataDir'),
    maxCandidates: num('maxCandidates', 80),
    includeOffscreen: bool('includeOffscreen', true),
    maxNameLength: num('maxNameLength', 90),
    viewport: [viewportRaw[0], viewportRaw[1]],
    timeoutMs: num('timeoutMs', 30_000),
    debugDir: optStr('debugDir'),
  }
}

type Context = {
  get(name: string): any
  logger?: (level: string) => (message: string) => void
  on?: (event: string, listener: () => void) => void
}

export function apply(ctx: Context, rawConfig?: unknown): void {
  const config = normalizeConfig(rawConfig)
  const loggerFactory = typeof ctx.logger === 'function' ? ctx.logger : null
  const logLine = loggerFactory ? loggerFactory('dsh-openjev-browser') : null
  const log = (level: string, message: string) => {
    if (logLine) {
      try {
        logLine(`[${level}] ${message}`)
        return
      } catch {
        // fall through to console
      }
    }
    console.error(`[dsh-openjev-browser] ${message}`)
  }

  const models = new ModelManager(config, log)
  const deps: PluginDeps = { ctx, config, models, log }
  const sessions = new SessionManager(deps)

  const tools = ctx.get('tools')
  if (!tools || typeof tools.register !== 'function') {
    log('warn', 'ctx.get("tools") did not return a tool registry; no tools registered')
    return
  }
  const defs = buildTools(sessions, deps)
  for (const def of defs) {
    tools.register(def)
  }
  log('info', `registered ${defs.length} tools (openjevUrl=${config.openjevUrl})`)

  // Best-effort cleanup when the plugin scope is disposed.
  if (typeof ctx.on === 'function') {
    try {
      ctx.on('dispose', () => {
        void sessions.close().catch(() => {})
        models.dispose()
      })
    } catch {
      // dispose hook unsupported; sessions die with the process anyway
    }
  }
}
