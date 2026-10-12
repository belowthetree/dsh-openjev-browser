/**
 * HTTP API for the settings page (client half) — mounted on the DSH web
 * server under `/dsh-openjev-browser/api` when the `webServer` service is
 * available (desktop / web profiles). Loopback-only.
 *
 * Endpoints:
 *   GET  /status            detection snapshot: server / artifact / python /
 *                           effective config / settings file
 *   PUT  /config            persist settings (JSON file) + hot-apply in-process
 *   POST /server/start      start the managed decision server (or attach HTTP)
 *   POST /server/stop       stop the managed decision server
 *
 * The python environment and model artifact are user-deployed; the settings
 * page carries a copy-paste agent prompt for that (docs/DEPLOYMENT.md).
 */

import { existsSync, readdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  artifactCandidates,
  defaultModelDir,
  validateArtifact,
  type ModelManager,
} from './model.js'
import {
  loadSettings,
  saveSettings,
  settingsFilePath,
  type SavedSettings,
} from './settings.js'
import type { PluginConfig } from './index.js'

export const API_PREFIX = '/dsh-openjev-browser/api'

type Logger = (level: string, message: string) => void

// ---------------------------------------------------------------------------
// Minimal req/res plumbing (mirrors the dsh-mcp-setting route helpers).
// ---------------------------------------------------------------------------

class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'RouteError'
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

function sendFailure(res: ServerResponse, error: unknown): void {
  if (error instanceof RouteError) {
    sendJson(res, error.status, { ok: false, code: error.code, message: error.message })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  sendJson(res, 500, { ok: false, code: 'INTERNAL', message })
}

const MAX_BODY_BYTES = 256 * 1024

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new RouteError(413, 'BODY_TOO_LARGE', '请求体过大')
    chunks.push(buf)
  }
  if (size === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RouteError(400, 'INVALID_JSON', '请求体不是合法 JSON 对象')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RouteError(400, 'INVALID_JSON', '请求体必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

// ---------------------------------------------------------------------------
// Model directory validation for "point at an already-deployed model".
// ---------------------------------------------------------------------------

export interface ModelDirCheck {
  ok: boolean
  warning?: string
  error?: string
  artifact?: boolean
  files?: number
  totalBytes?: number
}

/**
 * Accept a directory as `modelDir` when it either is a complete OpenJev
 * artifact (manifest + COMPLETE + sizes) or at least looks like a raw model
 * checkout (config.json / *.safetensors) that `openjev serve` can try.
 */
export function checkModelDir(dir: string): ModelDirCheck {
  if (!existsSync(dir)) return { ok: false, error: `目录不存在: ${dir}` }
  const artifact = validateArtifact(dir)
  if (artifact.ok) {
    return { ok: true, artifact: true, files: artifact.files, totalBytes: artifact.totalBytes }
  }
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch (err) {
    return { ok: false, error: `目录不可读: ${(err as Error).message}` }
  }
  const looksLikeModel =
    entries.includes('config.json') || entries.some((name) => name.endsWith('.safetensors'))
  if (looksLikeModel) {
    return {
      ok: true,
      artifact: false,
      warning: `不是完整的 OpenJev 工件(${artifact.error});按原始模型目录保存,服务将尝试直接加载`,
    }
  }
  return {
    ok: false,
    error: `既不是完整的 OpenJev 工件(${artifact.error}),也不像模型目录(缺 config.json / *.safetensors)`,
  }
}

// ---------------------------------------------------------------------------
// Route surface.
// ---------------------------------------------------------------------------

export interface ApiDeps {
  /** Live config object — mutated in place by applySavedSettings(). */
  config: PluginConfig
  /** Raw loader config (before the settings file overlay). */
  loaderConfig: unknown
  models: ModelManager
  log: Logger
  /** Re-normalize loader config + settings file into the live config object. */
  applySavedSettings: () => void
}

function sanitizeSettings(body: Record<string, unknown>, base: SavedSettings): SavedSettings {
  const out: SavedSettings = { ...base }
  const str = (key: keyof SavedSettings) => {
    if (!(key in body)) return
    const value = body[key]
    if (value === null || value === '') delete (out as Record<string, unknown>)[key]
    else if (typeof value === 'string') (out as Record<string, unknown>)[key] = value
    else throw new RouteError(400, 'INVALID_FIELD', `字段 ${key} 必须是字符串`)
  }
  const bool = (key: keyof SavedSettings) => {
    if (!(key in body)) return
    const value = body[key]
    if (typeof value !== 'boolean') throw new RouteError(400, 'INVALID_FIELD', `字段 ${key} 必须是布尔值`)
    ;(out as Record<string, unknown>)[key] = value
  }
  const num = (key: keyof SavedSettings) => {
    if (!(key in body)) return
    const value = Number(body[key])
    if (!Number.isFinite(value) || value <= 0) {
      throw new RouteError(400, 'INVALID_FIELD', `字段 ${key} 必须是正数`)
    }
    ;(out as Record<string, unknown>)[key] = value
  }
  str('openjevUrl')
  str('modelDir')
  str('pythonPath')
  str('modelRepo')
  str('browser')
  bool('autoStartServer')
  bool('headed')
  num('serverPort')
  return out
}

export function createApiHandler(deps: ApiDeps) {
  const { config, models, log } = deps

  async function statusPayload() {
    const status = await models.status()
    return {
      ok: true as const,
      settingsFile: settingsFilePath(),
      saved: loadSettings(),
      config: {
        openjevUrl: config.openjevUrl,
        modelDir: config.modelDir,
        pythonPath: config.pythonPath,
        autoStartServer: config.autoStartServer,
        serverPort: config.serverPort,
        modelRepo: config.modelRepo,
        browser: config.browser,
        headed: config.headed,
      },
      server: {
        ready: status.ready,
        transport: status.transport,
        url: status.url,
        model: status.model,
      },
      artifact: {
        dir: status.artifact?.dir,
        rejected: status.artifact?.rejected ?? {},
        candidates: artifactCandidates(config.modelDir),
      },
      python: status.python ?? null,
      setup: status.setup,
      defaults: {
        modelDir: defaultModelDir(),
        modelRepo: config.modelRepo,
      },
    }
  }

  return async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!isLoopbackRequest(req)) {
        sendJson(res, 403, { ok: false, code: 'FORBIDDEN', message: '配置接口仅允许本机访问' })
        return
      }
      const pathname = new URL(req.url ?? API_PREFIX, 'http://localhost').pathname
      if (!pathname.startsWith(API_PREFIX)) {
        sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: '未知接口' })
        return
      }
      const rest = pathname.slice(API_PREFIX.length) || '/'

      if (req.method === 'GET' && rest === '/status') {
        sendJson(res, 200, await statusPayload())
        return
      }

      if (req.method === 'PUT' && rest === '/config') {
        const body = await readJsonBody(req)
        const modelDir = body['modelDir']
        let check: ModelDirCheck | undefined
        if (typeof modelDir === 'string' && modelDir) {
          check = checkModelDir(modelDir)
          if (!check.ok) throw new RouteError(400, 'INVALID_MODEL_DIR', check.error ?? '模型目录无效')
        }
        const saved = sanitizeSettings(body, loadSettings())
        const file = saveSettings(saved)
        deps.applySavedSettings()
        models.dispose() // next tool call re-resolves with the new config
        sendJson(res, 200, {
          ok: true,
          settingsFile: file,
          saved,
          warning: check?.warning,
          status: await statusPayload(),
        })
        return
      }

      if (rest === '/server/start' && req.method === 'POST') {
        try {
          await models.ensureClient()
        } catch (err) {
          throw new RouteError(400, 'SERVER_START_FAILED', (err as Error).message)
        }
        sendJson(res, 200, { ok: true, status: await statusPayload() })
        return
      }
      if (rest === '/server/stop' && req.method === 'POST') {
        models.dispose()
        sendJson(res, 200, { ok: true, status: await statusPayload() })
        return
      }

      sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '不支持的请求方法或路径' })
    } catch (error) {
      log('warn', `dsh-openjev-browser api: ${error instanceof Error ? error.message : String(error)}`)
      sendFailure(res, error)
    }
  }
}
