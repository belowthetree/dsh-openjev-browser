/**
 * dsh-openjev-browser client half — settings UI.
 *
 * Renders a settings page (settings.section nav entry) plus a card on the
 * plugins page (settings.plugin.item), both backed by the host HTTP API at
 * /dsh-openjev-browser/api. Lets the user:
 *   1. see detection status (decision server / artifact / python);
 *   2. deploy the python environment + model by handing a copy-paste agent
 *      prompt to any DSH agent (the plugin ships no runtime / weights);
 *   3. point the plugin at the deployed model directory;
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
// Deployment agent prompt (mirrors docs/DEPLOYMENT.md)
// ---------------------------------------------------------------------------

const PROMPT_ZH = `请帮我部署 dsh-openjev-browser 插件所需的 OpenJev 决策模型运行环境,并严格按以下要求执行:

1. Python 环境
   - 不要把环境建在当前会话工作区内:DSH 沙箱会限制工作区内可执行文件的写权限,工作区内的 python 无法写用户目录。
   - 推荐位置:%USERPROFILE%\\.dsh\\openjev\\runtime(Windows)或 ~/.dsh/openjev/runtime(macOS/Linux)。
   - 用 uv 创建独立环境(没有 uv 就先装 uv):uv venv --python 3.12 <runtime-dir>
   - 安装 PyTorch(按硬件二选一):
     * CPU(稳妥默认):uv pip install --python <python> torch --index-url https://download.pytorch.org/whl/cpu
     * NVIDIA 显卡(CUDA 12.8):索引换成 https://download.pytorch.org/whl/cu128
   - 安装 openjev 服务端:uv pip install --python <python> "openjev[serve] @ git+https://github.com/ejhshen/OpenJev.git"
     注意:PyPI 上的 openjev 包名被无关项目占用,必须走 git 安装。
   - 验证:<python> -c "import openjev, fastapi, uvicorn; print('ok')"

2. 模型工件(约 8 GB)
   - 从 Hugging Face 下载 shenjunhao/OpenJev-4B 的全部文件到 %USERPROFILE%\\.dsh\\openjev\\models\\OpenJev-4B:
     uv pip install --python <python> huggingface_hub 后用 hf download shenjunhao/OpenJev-4B --local-dir <model-dir>
   - 下载后校验:目录内必须有 manifest.json 与 COMPLETE;COMPLETE 的内容 == manifest.json 的 sha256(十六进制小写);manifest 列出的每个文件都存在且字节数一致。

3. 自检
   - 启动服务:<python> -m openjev.runtime.server --artifact <model-dir> --host 127.0.0.1 --port 8080
   - 轮询 GET http://127.0.0.1:8080/health,返回 {"status":"ready"} 即成功;随后停掉该进程(插件会按需自动拉起)。

4. 收尾
   - 打开 DSH 设置 → OpenJev 浏览器,填入:Python 路径 = <python 完整路径>,模型目录 = <model-dir>,保存。
   - 告诉我这两个路径,并说明每一步的结果;任何一步失败请给出原始报错。`

const PROMPT_EN = `Deploy the OpenJev decision-model runtime required by the dsh-openjev-browser plugin, strictly following:

1. Python environment
   - Do NOT create it inside the current session workspace: the DSH sandbox confines executables living in the workspace to workspace-only writes.
   - Recommended location: %USERPROFILE%\\.dsh\\openjev\\runtime (Windows) or ~/.dsh/openjev/runtime (macOS/Linux).
   - Create an isolated env with uv (install uv first if missing): uv venv --python 3.12 <runtime-dir>
   - Install PyTorch (pick one):
     * CPU (safe default): uv pip install --python <python> torch --index-url https://download.pytorch.org/whl/cpu
     * NVIDIA GPU (CUDA 12.8): use index https://download.pytorch.org/whl/cu128
   - Install the openjev server: uv pip install --python <python> "openjev[serve] @ git+https://github.com/ejhshen/OpenJev.git"
     Note: the PyPI name "openjev" is squatted by an unrelated project — the git spec is mandatory.
   - Verify: <python> -c "import openjev, fastapi, uvicorn; print('ok')"

2. Model artifact (~8 GB)
   - Download all files of HF repo shenjunhao/OpenJev-4B into %USERPROFILE%\\.dsh\\openjev\\models\\OpenJev-4B:
     install huggingface_hub into the env, then hf download shenjunhao/OpenJev-4B --local-dir <model-dir>
   - Verify: the dir must contain manifest.json and COMPLETE; COMPLETE == lowercase hex sha256 of manifest.json; every file listed in the manifest exists with the exact byte size.

3. Smoke test
   - Start: <python> -m openjev.runtime.server --artifact <model-dir> --host 127.0.0.1 --port 8080
   - Poll GET http://127.0.0.1:8080/health until {"status":"ready"}; then stop the process (the plugin auto-starts it on demand).

4. Finish
   - Open DSH Settings → OpenJev Browser, fill in Python path = <python> and Model directory = <model-dir>, save.
   - Report both paths and the outcome of each step; on any failure include the raw error output.`

// ---------------------------------------------------------------------------
// Locales
// ---------------------------------------------------------------------------

const zh = {
  'nav.label': 'OpenJev 浏览器',
  'card.status': '运行状态',
  'card.deploy': '部署指引(Python 环境 + 模型)',
  'card.modelDir': '模型目录',
  'card.server': '决策服务',
  'field.modelDir': '模型目录',
  'field.openjevUrl': '决策服务地址',
  'field.pythonPath': 'Python 路径(可选覆盖)',
  'field.autoStart': '自动启动决策服务',
  'action.refresh': '刷新',
  'action.save': '保存',
  'action.saving': '保存中…',
  'action.copyPrompt': '复制部署提示词',
  'action.copied': '已复制',
  'action.startServer': '启动服务',
  'action.stopServer': '停止服务',
  'status.ready': '决策服务已就绪',
  'status.notReady': '决策服务未就绪',
  'status.model': '模型',
  'status.transport': '接入方式',
  'status.artifactDir': '检测到工件',
  'status.noArtifact': '未检测到模型工件',
  'status.pythonOk': 'Python 可用',
  'status.pythonMissing': 'Python 未就绪',
  'status.notSet': '未设置',
  'hint.deploy': 'Python 环境与模型由用户自行部署(插件不含运行时与权重)。把下面的提示词粘贴给任意一个 DSH agent 即可自动完成部署;规范细节见仓库 docs/DEPLOYMENT.md。',
  'hint.modelDir': '指向已部署的模型目录(OpenJev 工件或含 config.json / *.safetensors 的模型目录),保存后立即生效。',
  'hint.server': '决策服务由插件按需自动启动;也可手动控制。修改后保存立即生效。',
  'hint.settingsFile': '设置保存在',
  'hint.restart': '保存后立即生效;重启 DSH 后自动加载。',
  'message.saved': '已保存并生效',
  'message.loadFailed': '状态加载失败',
}

const en: Record<keyof typeof zh, string> = {
  'nav.label': 'OpenJev Browser',
  'card.status': 'Status',
  'card.deploy': 'Deployment (Python env + model)',
  'card.modelDir': 'Model Directory',
  'card.server': 'Decision Server',
  'field.modelDir': 'Model directory',
  'field.openjevUrl': 'Server URL',
  'field.pythonPath': 'Python path (optional override)',
  'field.autoStart': 'Auto-start decision server',
  'action.refresh': 'Refresh',
  'action.save': 'Save',
  'action.saving': 'Saving…',
  'action.copyPrompt': 'Copy deployment prompt',
  'action.copied': 'Copied',
  'action.startServer': 'Start server',
  'action.stopServer': 'Stop server',
  'status.ready': 'Decision server ready',
  'status.notReady': 'Decision server not ready',
  'status.model': 'Model',
  'status.transport': 'Transport',
  'status.artifactDir': 'Artifact detected',
  'status.noArtifact': 'No model artifact detected',
  'status.pythonOk': 'Python ready',
  'status.pythonMissing': 'Python not ready',
  'status.notSet': 'not set',
  'hint.deploy': 'The python environment and model are user-deployed (the plugin ships neither). Paste the prompt below into any DSH agent to perform the whole deployment; the full spec lives in docs/DEPLOYMENT.md of the plugin repo.',
  'hint.modelDir': 'Point at an already-deployed model (an OpenJev artifact, or a directory with config.json / *.safetensors). Applies immediately on save.',
  'hint.server': 'The plugin starts the decision server on demand; you can also control it manually. Changes apply on save.',
  'hint.settingsFile': 'Settings stored in',
  'hint.restart': 'Changes apply immediately and are restored after a DSH restart.',
  'message.saved': 'Saved and applied',
  'message.loadFailed': 'Failed to load status',
}

// ---------------------------------------------------------------------------
// API client + controller
// ---------------------------------------------------------------------------

type Dict = keyof typeof zh

interface StatusPayload {
  settingsFile: string
  config: {
    openjevUrl: string
    modelDir?: string
    pythonPath?: string
    autoStartServer: boolean
    serverPort: number
    modelRepo: string
    browser: string
    headed: boolean
  }
  server: { ready: boolean; transport?: string; url?: string; model?: string }
  artifact: { dir?: string; rejected: Record<string, string>; candidates: string[] }
  python: { path?: string; version?: string; hasOpenJev: boolean; error?: string } | null
  setup: string[]
  defaults: { modelDir: string; modelRepo: string }
}

interface FormState {
  modelDir: string
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
  copied: boolean
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
    copied: false,
    form: { modelDir: '', openjevUrl: '', pythonPath: '', autoStartServer: true },
    formTouched: false,
  })

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
            openjevUrl: data.config.openjevUrl,
            pythonPath: data.config.pythonPath ?? '',
            autoStartServer: data.config.autoStartServer,
          }
        }
      })
    } catch (error) {
      this.store.update((s) => {
        s.status = 'error'
        s.error = messageOf(error)
      })
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

  async copyPrompt(prompt: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(prompt)
      this.store.update((s) => {
        s.copied = true
      })
      setTimeout(() => {
        this.store.update((s) => {
          s.copied = false
        })
      }, 2000)
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
    // no timers to stop
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
.ojb-hint { font-size: 12px; color: var(--dsw-alias-label-secondary, #888); margin: 4px 0 0; }
.ojb-pre { margin: 8px 0 0; padding: 10px; border: 1px solid var(--dsw-border, rgba(127,127,127,.3)); border-radius: 6px; background: var(--dsw-specific-input-major, rgba(127,127,127,.06)); font-family: ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; max-height: 260px; overflow: auto; }
`

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type TFunction = (key: Dict) => string

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
  const isZh = t('nav.label') === zh['nav.label']
  const prompt = isZh ? PROMPT_ZH : PROMPT_EN

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

      {/* deployment guide card */}
      <div className="ojb-card">
        <h3>{t('card.deploy')}</h3>
        <p className="ojb-hint" style={{ marginTop: 0 }}>{t('hint.deploy')}</p>
        <div className="ojb-row">
          <button className="ojb-btn ojb-btn-primary" onClick={() => void controllerRef.copyPrompt(prompt)}>
            {snapshot.copied ? `✓ ${t('action.copied')}` : t('action.copyPrompt')}
          </button>
        </div>
        <pre className="ojb-pre">{prompt}</pre>
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
