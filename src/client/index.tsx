/**
 * dsh-openjev-browser client half — settings UI.
 *
 * Renders a settings page (settings.section nav entry) plus a card on the
 * plugins page (settings.plugin.item), both backed by the host HTTP API at
 * /dsh-openjev-browser/api. Lets the user:
 *   1. see detection status (decision server / artifact / python);
 *   2. point the plugin at an already-downloaded model directory;
 *   3. pick a directory and download the OpenJev model into it (progress,
 *      cancel, auto-save modelDir on completion);
 *   4. tune server settings (url / python / auto-start) and start/stop the
 *      managed decision server.
 *
 * Built by esbuild into lib/client.js in the __ModuleLoader__ format; react
 * and @deepseek-ai/dsh-client-store are loader-provided externals.
 */

import * as React from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

export const name = 'dsh-openjev-browser'
export const inject = ['slots', 'locale']

const NS = 'dsh-openjev-browser'
const API = '/dsh-openjev-browser/api'

// ---------------------------------------------------------------------------
// Locales
// ---------------------------------------------------------------------------

const zh = {
  'nav.label': 'OpenJev 浏览器',
  'card.status': '运行状态',
  'card.modelDir': '模型目录',
  'card.download': '下载模型',
  'card.server': '决策服务',
  'field.modelDir': '模型目录',
  'field.downloadDir': '下载到目录',
  'field.repo': '模型仓库',
  'field.openjevUrl': '决策服务地址',
  'field.pythonPath': 'Python 路径',
  'field.autoStart': '自动启动决策服务',
  'action.refresh': '刷新',
  'action.save': '保存',
  'action.saving': '保存中…',
  'action.download': '开始下载',
  'action.cancelDownload': '取消下载',
  'action.startServer': '启动服务',
  'action.stopServer': '停止服务',
  'status.ready': '决策服务已就绪',
  'status.notReady': '决策服务未就绪',
  'status.model': '模型',
  'status.transport': '接入方式',
  'status.url': '地址',
  'status.artifactDir': '检测到工件',
  'status.noArtifact': '未检测到模型工件',
  'status.pythonOk': 'Python 可用',
  'status.pythonMissing': 'Python 未就绪',
  'status.notSet': '未设置',
  'hint.modelDir': '指向已下载的模型目录(OpenJev 工件或含 config.json / *.safetensors 的模型目录),保存后立即生效。',
  'hint.download': '选择目录下载 OpenJev 模型(约 8 GB,支持断点续传)。下载完成并校验通过后会自动设为模型目录。',
  'hint.server': '决策服务由插件按需自动启动;也可手动控制。修改后保存立即生效。',
  'hint.settingsFile': '设置保存在',
  'hint.restart': '保存后立即生效;重启 DSH 后自动加载。',
  'download.idle': '暂无下载任务',
  'download.running': '下载中',
  'download.done': '下载完成',
  'download.error': '下载失败',
  'download.cancelled': '已取消',
  'download.savedAs': '已自动设为模型目录',
  'message.saved': '已保存并生效',
  'message.saveFailed': '保存失败',
  'message.loadFailed': '状态加载失败',
  'setup.title': '未完成初始化',
}

const en: Record<keyof typeof zh, string> = {
  'nav.label': 'OpenJev Browser',
  'card.status': 'Status',
  'card.modelDir': 'Model Directory',
  'card.download': 'Download Model',
  'card.server': 'Decision Server',
  'field.modelDir': 'Model directory',
  'field.downloadDir': 'Download into',
  'field.repo': 'Model repo',
  'field.openjevUrl': 'Server URL',
  'field.pythonPath': 'Python path',
  'field.autoStart': 'Auto-start decision server',
  'action.refresh': 'Refresh',
  'action.save': 'Save',
  'action.saving': 'Saving…',
  'action.download': 'Start download',
  'action.cancelDownload': 'Cancel',
  'action.startServer': 'Start server',
  'action.stopServer': 'Stop server',
  'status.ready': 'Decision server ready',
  'status.notReady': 'Decision server not ready',
  'status.model': 'Model',
  'status.transport': 'Transport',
  'status.url': 'URL',
  'status.artifactDir': 'Artifact detected',
  'status.noArtifact': 'No model artifact detected',
  'status.pythonOk': 'Python ready',
  'status.pythonMissing': 'Python not ready',
  'status.notSet': 'not set',
  'hint.modelDir': 'Point at an already-downloaded model (an OpenJev artifact, or a directory with config.json / *.safetensors). Applies immediately on save.',
  'hint.download': 'Download the OpenJev model (~8 GB, resumable) into a directory of your choice. A validated download is saved as the model directory automatically.',
  'hint.server': 'The plugin starts the decision server on demand; you can also control it manually. Changes apply on save.',
  'hint.settingsFile': 'Settings stored in',
  'hint.restart': 'Changes apply immediately and are restored after a DSH restart.',
  'download.idle': 'No download job',
  'download.running': 'Downloading',
  'download.done': 'Download complete',
  'download.error': 'Download failed',
  'download.cancelled': 'Cancelled',
  'download.savedAs': 'Saved as model directory',
  'message.saved': 'Saved and applied',
  'message.saveFailed': 'Save failed',
  'message.loadFailed': 'Failed to load status',
  'setup.title': 'Setup incomplete',
}

// ---------------------------------------------------------------------------
// API client + controller
// ---------------------------------------------------------------------------

type Dict = keyof typeof zh

interface DownloadState {
  state: 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  repo?: string
  dir?: string
  totalBytes?: number
  bytesDone?: number
  file?: string
  fileIndex?: number
  fileCount?: number
  error?: string
  savedModelDir?: string
}

interface StatusPayload {
  settingsFile: string
  config: {
    openjevUrl: string
    modelDir?: string
    pythonPath?: string
    autoStartServer: boolean
    serverPort: number
    modelRepo: string
    downloadDir: string
    browser: string
    headed: boolean
  }
  server: { ready: boolean; transport?: string; url?: string; model?: string }
  artifact: { dir?: string; rejected: Record<string, string>; candidates: string[] }
  python: { path?: string; version?: string; hasOpenJev: boolean; error?: string } | null
  setup: string[]
  defaults: { downloadDir: string; modelRepo: string }
  download: DownloadState
}

interface FormState {
  modelDir: string
  downloadDir: string
  repo: string
  openjevUrl: string
  pythonPath: string
  autoStartServer: boolean
}

interface Snapshot {
  status: 'idle' | 'loading' | 'ready' | 'error'
  data: StatusPayload | null
  error: string | null
  notice: string | null
  busy: string | null
  form: FormState
  formTouched: boolean
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function callApi(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
  })
  let payload: any = null
  try {
    payload = await response.json()
  } catch {
    // fall through
  }
  if (!response.ok || !payload || payload.ok !== true) {
    throw new Error(payload?.message ?? `HTTP ${response.status}`)
  }
  return payload
}

class SettingsController {
  store = createSnapshotStore<Snapshot>({
    status: 'idle',
    data: null,
    error: null,
    notice: null,
    busy: null,
    form: { modelDir: '', downloadDir: '', repo: '', openjevUrl: '', pythonPath: '', autoStartServer: true },
    formTouched: false,
  })

  private timer: number | undefined

  async load(silent = false): Promise<void> {
    if (!silent || this.store.getSnapshot().status !== 'ready') {
      this.store.update((s) => {
        s.status = 'loading'
        s.error = null
      })
    }
    try {
      const data = (await callApi('/status')) as StatusPayload
      this.store.update((s) => {
        s.status = 'ready'
        s.data = data
        s.error = null
        if (!s.formTouched) {
          s.form = {
            modelDir: data.config.modelDir ?? '',
            downloadDir: data.download.dir ?? (data.config.downloadDir || data.defaults.downloadDir),
            repo: data.download.repo ?? data.config.modelRepo,
            openjevUrl: data.config.openjevUrl,
            pythonPath: data.config.pythonPath ?? '',
            autoStartServer: data.config.autoStartServer,
          }
        }
      })
      this.syncPolling(data.download)
    } catch (error) {
      this.store.update((s) => {
        s.status = 'error'
        s.error = messageOf(error)
      })
    }
  }

  private syncPolling(download: DownloadState): void {
    if (download.state === 'running') this.startPolling()
    else this.stopPolling()
  }

  private startPolling(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => void this.pollDownload(), 1000) as unknown as number
  }

  private stopPolling(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private async pollDownload(): Promise<void> {
    try {
      const payload = await callApi('/download')
      const download = payload.download as DownloadState
      this.store.update((s) => {
        if (s.data) s.data.download = download
      })
      if (download.state !== 'running') {
        this.stopPolling()
        await this.load(true)
        if (download.state === 'done') {
          this.store.update((s) => {
            s.notice = null
            s.formTouched = false
          })
          await this.load(true)
        }
      }
    } catch {
      this.stopPolling()
    }
  }

  setForm(patch: Partial<FormState>): void {
    this.store.update((s) => {
      Object.assign(s.form, patch)
      s.formTouched = true
    })
  }

  /** Persist a subset of fields; returns true on success. */
  async save(fields: Partial<Record<keyof FormState, string | boolean>>): Promise<boolean> {
    this.store.update((s) => {
      s.busy = 'save'
      s.notice = null
    })
    try {
      const payload = await callApi('/config', { method: 'PUT', body: JSON.stringify(fields) })
      const warning = payload.warning as string | undefined
      this.store.update((s) => {
        s.busy = null
        s.notice = warning ? `⚠ ${warning}` : 'ok'
        s.formTouched = false
      })
      await this.load(true)
      return true
    } catch (error) {
      this.store.update((s) => {
        s.busy = null
        s.notice = `✗ ${messageOf(error)}`
      })
      return false
    }
  }

  async startDownload(): Promise<void> {
    const { downloadDir, repo } = this.store.getSnapshot().form
    this.store.update((s) => {
      s.busy = 'download'
      s.notice = null
    })
    try {
      await callApi('/download', { method: 'POST', body: JSON.stringify({ dir: downloadDir, repo }) })
      await this.load(true)
    } catch (error) {
      this.store.update((s) => {
        s.notice = `✗ ${messageOf(error)}`
      })
    } finally {
      this.store.update((s) => {
        s.busy = null
      })
    }
  }

  async cancelDownload(): Promise<void> {
    try {
      await callApi('/download/cancel', { method: 'POST' })
    } catch (error) {
      this.store.update((s) => {
        s.notice = `✗ ${messageOf(error)}`
      })
    }
  }

  async server(action: 'start' | 'stop'): Promise<void> {
    this.store.update((s) => {
      s.busy = `server-${action}`
      s.notice = null
    })
    try {
      const payload = await callApi(`/server/${action}`, { method: 'POST' })
      this.store.update((s) => {
        s.data = payload.status as StatusPayload
        s.busy = null
      })
    } catch (error) {
      this.store.update((s) => {
        s.busy = null
        s.notice = `✗ ${messageOf(error)}`
      })
      await this.load(true)
    }
  }

  dispose(): void {
    this.stopPolling()
  }
}

// ---------------------------------------------------------------------------
// Styles (injected once; plain prefixed classes, theme vars with fallbacks)
// ---------------------------------------------------------------------------

const CSS = `
.ojb-root { display: flex; flex-direction: column; gap: 14px; font-size: 13px; line-height: 1.55; }
.ojb-card { border: 1px solid var(--dsw-border, rgba(127,127,127,.3)); border-radius: 8px; padding: 12px 14px; }
.ojb-card h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
.ojb-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; flex-wrap: wrap; }
.ojb-label { min-width: 96px; color: var(--dsw-alias-label-secondary, #888); }
.ojb-input { flex: 1; min-width: 220px; padding: 5px 8px; border: 1px solid var(--dsw-border, rgba(127,127,127,.4)); border-radius: 6px; background: var(--dsw-specific-input-major, transparent); color: inherit; font: inherit; }
.ojb-btn { padding: 5px 12px; border: 1px solid var(--dsw-border, rgba(127,127,127,.4)); border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.ojb-btn:hover { border-color: var(--dsw-accent, #5b8def); }
.ojb-btn:disabled { opacity: .5; cursor: default; }
.ojb-btn-primary { border-color: var(--dsw-accent, #5b8def); color: var(--dsw-accent, #5b8def); }
.ojb-ok { color: var(--dsw-ok, #3fb950); }
.ojb-bad { color: var(--dsw-danger, #f85149); }
.ojb-dim { color: var(--dsw-alias-label-secondary, #888); }
.ojb-mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-all; }
.ojb-progress { height: 6px; border-radius: 3px; background: var(--dsw-border, rgba(127,127,127,.3)); overflow: hidden; margin: 8px 0 4px; }
.ojb-progress > div { height: 100%; background: var(--dsw-accent, #5b8def); transition: width .4s; }
.ojb-hint { font-size: 12px; color: var(--dsw-alias-label-secondary, #888); margin: 4px 0 0; }
`

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type TFunction = (key: Dict) => string

function formatBytes(n?: number): string {
  if (!n || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

interface SectionProps {
  useOpenjev?: <R>(selector: (s: Snapshot) => R) => R
  t?: TFunction
}

function SettingsSection(props: SectionProps) {
  const useOpenjev = props.useOpenjev
  if (!useOpenjev) return null
  const snapshot = useOpenjev((s) => s)
  const t = props.t ?? (((key: Dict) => zh[key] ?? key) as TFunction)
  const { data, form } = snapshot
  const busy = snapshot.busy !== null

  const download = data?.download
  const pct =
    download?.totalBytes && download.bytesDone
      ? Math.min(100, (download.bytesDone / download.totalBytes) * 100)
      : undefined

  return (
    <div className="ojb-root">
      {/* status card */}
      <div className="ojb-card">
        <h3>{t('card.status')}</h3>
        {snapshot.status === 'error' && <div className="ojb-bad">{`${t('message.loadFailed')}: ${snapshot.error}`}</div>}
        {data && (
          <>
            <div className="ojb-row">
              <span className={data.server.ready ? 'ojb-ok' : 'ojb-bad'}>
                {data.server.ready ? `● ${t('status.ready')}` : `○ ${t('status.notReady')}`}
              </span>
              {data.server.model && <span className="ojb-dim">{`${t('status.model')}: ${data.server.model}`}</span>}
              {data.server.transport && (
                <span className="ojb-dim">{`${t('status.transport')}: ${data.server.transport}`}</span>
              )}
            </div>
            <div className="ojb-row">
              {data.artifact.dir ? (
                <span className="ojb-ok ojb-mono">{`${t('status.artifactDir')}: ${data.artifact.dir}`}</span>
              ) : (
                <span className="ojb-bad">{t('status.noArtifact')}</span>
              )}
            </div>
            {data.python && (
              <div className="ojb-row">
                {data.python.hasOpenJev ? (
                  <span className="ojb-ok ojb-mono">{`${t('status.pythonOk')}: ${data.python.path}`}</span>
                ) : (
                  <span className="ojb-bad">{`${t('status.pythonMissing')}${data.python.error ? ` (${data.python.error})` : ''}`}</span>
                )}
              </div>
            )}
          </>
        )}
        <div className="ojb-row">
          <button className="ojb-btn" disabled={busy} onClick={() => void controllerRef.load()}>
            {t('action.refresh')}
          </button>
        </div>
      </div>

      {/* model dir card */}
      <div className="ojb-card">
        <h3>{t('card.modelDir')}</h3>
        <div className="ojb-row">
          <span className="ojb-label">{t('field.modelDir')}</span>
          <input
            className="ojb-input"
            value={form.modelDir}
            placeholder={data?.artifact.dir ?? t('status.notSet')}
            onChange={(e) => controllerRef.setForm({ modelDir: e.target.value })}
          />
          <button
            className="ojb-btn ojb-btn-primary"
            disabled={busy}
            onClick={() => void controllerRef.save({ modelDir: form.modelDir })}
          >
            {snapshot.busy === 'save' ? t('action.saving') : t('action.save')}
          </button>
        </div>
        <p className="ojb-hint">{t('hint.modelDir')}</p>
      </div>

      {/* download card */}
      <div className="ojb-card">
        <h3>{t('card.download')}</h3>
        <div className="ojb-row">
          <span className="ojb-label">{t('field.downloadDir')}</span>
          <input
            className="ojb-input"
            value={form.downloadDir}
            placeholder={data?.defaults.downloadDir}
            disabled={download?.state === 'running'}
            onChange={(e) => controllerRef.setForm({ downloadDir: e.target.value })}
          />
        </div>
        <div className="ojb-row">
          <span className="ojb-label">{t('field.repo')}</span>
          <input
            className="ojb-input"
            value={form.repo}
            disabled={download?.state === 'running'}
            onChange={(e) => controllerRef.setForm({ repo: e.target.value })}
          />
          {download?.state === 'running' ? (
            <button className="ojb-btn" onClick={() => void controllerRef.cancelDownload()}>
              {t('action.cancelDownload')}
            </button>
          ) : (
            <button
              className="ojb-btn ojb-btn-primary"
              disabled={busy || !form.downloadDir}
              onClick={() => void controllerRef.startDownload()}
            >
              {t('action.download')}
            </button>
          )}
        </div>
        {download && download.state !== 'idle' && (
          <>
            <div className="ojb-row">
              <span className={download.state === 'error' ? 'ojb-bad' : download.state === 'done' ? 'ojb-ok' : ''}>
                {t(`download.${download.state}` as Dict)}
              </span>
              {download.dir && <span className="ojb-dim ojb-mono">{download.dir}</span>}
            </div>
            {download.state === 'running' && (
              <>
                <div className="ojb-progress">
                  <div style={{ width: pct === undefined ? '100%' : `${pct}%`, opacity: pct === undefined ? 0.4 : 1 }} />
                </div>
                <div className="ojb-hint">
                  {`${formatBytes(download.bytesDone)}${download.totalBytes ? ` / ${formatBytes(download.totalBytes)}` : ''}`}
                  {download.file ? ` · ${download.file} (${download.fileIndex}/${download.fileCount})` : ''}
                </div>
              </>
            )}
            {download.state === 'error' && download.error && <div className="ojb-bad">{download.error}</div>}
            {download.state === 'done' && download.savedModelDir && (
              <div className="ojb-ok">{`${t('download.savedAs')}: ${download.savedModelDir}`}</div>
            )}
          </>
        )}
        <p className="ojb-hint">{t('hint.download')}</p>
      </div>

      {/* server card */}
      <div className="ojb-card">
        <h3>{t('card.server')}</h3>
        <div className="ojb-row">
          <span className="ojb-label">{t('field.openjevUrl')}</span>
          <input
            className="ojb-input"
            value={form.openjevUrl}
            onChange={(e) => controllerRef.setForm({ openjevUrl: e.target.value })}
          />
        </div>
        <div className="ojb-row">
          <span className="ojb-label">{t('field.pythonPath')}</span>
          <input
            className="ojb-input"
            value={form.pythonPath}
            placeholder={t('status.notSet')}
            onChange={(e) => controllerRef.setForm({ pythonPath: e.target.value })}
          />
        </div>
        <div className="ojb-row">
          <label className="ojb-row" style={{ margin: 0 }}>
            <input
              type="checkbox"
              checked={form.autoStartServer}
              onChange={(e) => controllerRef.setForm({ autoStartServer: e.target.checked })}
            />
            {t('field.autoStart')}
          </label>
          <button
            className="ojb-btn ojb-btn-primary"
            disabled={busy}
            onClick={() =>
              void controllerRef.save({
                openjevUrl: form.openjevUrl,
                pythonPath: form.pythonPath,
                autoStartServer: form.autoStartServer,
              })
            }
          >
            {snapshot.busy === 'save' ? t('action.saving') : t('action.save')}
          </button>
          <button className="ojb-btn" disabled={busy || data?.server.ready} onClick={() => void controllerRef.server('start')}>
            {t('action.startServer')}
          </button>
          <button className="ojb-btn" disabled={busy || !data?.server.ready} onClick={() => void controllerRef.server('stop')}>
            {t('action.stopServer')}
          </button>
        </div>
        <p className="ojb-hint">{t('hint.server')}</p>
      </div>

      {snapshot.notice && (
        <div className={snapshot.notice.startsWith('✗') || snapshot.notice.startsWith('⚠') ? 'ojb-bad' : 'ojb-ok'}>
          {snapshot.notice === 'ok' ? `✓ ${t('message.saved')}` : snapshot.notice}
        </div>
      )}
      {data && (
        <p className="ojb-hint">
          {`${t('hint.settingsFile')} `}
          <span className="ojb-mono">{data.settingsFile}</span>
          {` ${t('hint.restart')}`}
        </p>
      )}
    </div>
  )
}

// The controller is a module-level singleton so both slots (section page and
// plugin card) share one state source.
let controllerRef!: SettingsController

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function apply(ctx: any): void {
  if (typeof document !== 'undefined' && !document.getElementById('ojb-style')) {
    const tag = document.createElement('style')
    tag.id = 'ojb-style'
    tag.textContent = CSS
    document.head.appendChild(tag)
  }
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-openjev-browser: dictionaries')
  const controller = new SettingsController()
  controllerRef = controller
  ctx.effect(
    () => {
      void controller.load()
      return () => controller.dispose()
    },
    'dsh-openjev-browser: initial load',
  )
  const t: TFunction = (key) => {
    try {
      return ctx.locale.bind(NS)(key)
    } catch {
      return zh[key] ?? key
    }
  }
  const render = (props: SectionProps) => <SettingsSection {...props} t={t} />
  const face = () => ({ hooks: { openjev: controller.store } })

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: NS,
        order: 23,
        label: () => t('nav.label'),
        locale: NS,
        inject: face,
      },
      render,
    ),
  )
  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register({ name: 'settings.plugin.item', key: NS, locale: NS, inject: face }, render),
  )
}
