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
  'float.title': '浏览器预览',
  'float.show': '显示浏览器预览',
  'float.expand': '放大预览',
  'float.shrink': '缩小预览',
  'float.close': '收起预览',
  'float.refresh': '刷新画面',
  'float.waiting': '正在获取页面…',
  'float.idle': '等待操作',
  'float.running': '执行中',
  'float.done': '完成',
  'float.failed': '失败',
  'float.untitled': '无标题页面',
  'float.previewUnavailable': '暂时无法获取画面',
  'float.captureHint': '画面在浏览器工具执行后自动更新',
  'float.headed': '有头',
  'float.headless': '无头',
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
  'float.title': 'Browser preview',
  'float.show': 'Show browser preview',
  'float.expand': 'Enlarge preview',
  'float.shrink': 'Shrink preview',
  'float.close': 'Hide preview',
  'float.refresh': 'Refresh frame',
  'float.waiting': 'Loading page…',
  'float.idle': 'waiting for a tool call',
  'float.running': 'running',
  'float.done': 'done',
  'float.failed': 'failed',
  'float.untitled': 'Untitled page',
  'float.previewUnavailable': 'Preview unavailable',
  'float.captureHint': 'The frame refreshes after each browser tool call',
  'float.headed': 'headed',
  'float.headless': 'headless',
}

// ---------------------------------------------------------------------------
// API client + controller
// ---------------------------------------------------------------------------

type Dict = keyof typeof zh

interface DownloadState {
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  dir?: string
  repo?: string
  file?: string
  fileIndex?: number
  fileCount?: number
  bytesDone?: number
  bytesTotal?: number
  error?: string
}

interface StatusPayload {
  settingsFile: string
  saved?: { onboarded?: boolean; modelDir?: string }
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
  python: {
    path?: string
    version?: string
    hasOpenJev: boolean
    usable?: boolean
    missing?: string[]
    bundled?: boolean
    error?: string
  } | null
  setup: string[]
  download: DownloadState
  bundledPython: string
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

  private downloadTimer: ReturnType<typeof setInterval> | null = null

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
    this.stopPolling()
  }

  // --- model download (plugins page setup panel) ---------------------------

  async startDownload(dir: string, repo: string): Promise<void> {
    this.store.update((s) => {
      s.busy = 'download'
      s.notice = null
    })
    try {
      const payload = await callApi('/download', { method: 'POST', body: JSON.stringify({ dir, repo }) })
      this.store.update((s) => {
        s.busy = null
        if (s.data) s.data = { ...s.data, download: payload.download as DownloadState }
      })
      this.pollDownload()
    } catch (error) {
      this.store.update((s) => {
        s.busy = null
        s.notice = `✗ ${messageOf(error)}`
      })
    }
  }

  async cancelDownload(): Promise<void> {
    try {
      const payload = await callApi('/download/cancel', { method: 'POST' })
      this.store.update((s) => {
        if (s.data) s.data = { ...s.data, download: payload.download as DownloadState }
      })
      this.stopPolling()
    } catch (error) {
      this.store.update((s) => {
        s.notice = `✗ ${messageOf(error)}`
      })
    }
  }

  /** Persist a model directory as modelDir and re-run detection. */
  async adoptModelDir(dir: string): Promise<boolean> {
    this.store.update((s) => {
      s.busy = 'adopt'
      s.notice = null
    })
    try {
      await callApi('/download/adopt', { method: 'POST', body: JSON.stringify({ dir }) })
      this.store.update((s) => {
        s.busy = null
        s.notice = 'ok'
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

  pollDownload(): void {
    if (this.downloadTimer !== null) return
    this.downloadTimer = setInterval(() => {
      void this.refreshDownload()
    }, 1500)
  }

  stopPolling(): void {
    if (this.downloadTimer === null) return
    clearInterval(this.downloadTimer)
    this.downloadTimer = null
  }

  private async refreshDownload(): Promise<void> {
    try {
      const payload = await callApi('/download')
      const download = payload.download as DownloadState
      this.store.update((s) => {
        if (s.data) s.data = { ...s.data, download }
      })
      if (download.status !== 'running') {
        this.stopPolling()
        await this.load(true)
      }
    } catch {
      this.stopPolling()
    }
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
.ojb-choice { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0 2px; }
.ojb-choice > button[data-active="true"] { border-color: var(--dsw-accent, #5b8def); }
.ojb-bar { height: 9px; border-radius: 6px; background: rgba(127,127,127,.22); overflow: hidden; margin: 8px 0 4px; }
.ojb-bar-fill { height: 100%; background: var(--dsw-accent, #5b8def); transition: width .3s ease; }
.ojb-stack { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.ojb-float { position: fixed; z-index: 2150; display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35)); border-radius: 12px; background: var(--dsw-alias-bg-overlay, #1f1f1f); color: var(--dsw-alias-label-primary, #e6e6e6); box-shadow: 0 14px 36px rgba(0,0,0,.36); font-size: 12px; overflow: hidden; }
.ojb-float-pop { animation: ojb-float-pop .24s cubic-bezier(.2,.9,.3,1.18); }
@keyframes ojb-float-pop { from { opacity: 0; transform: translateY(8px) scale(.965); } to { opacity: 1; transform: none; } }
.ojb-float-head { display: flex; align-items: center; gap: 6px; padding: 7px 8px; cursor: grab; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.08)); border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2)); user-select: none; touch-action: none; }
.ojb-float-head:active { cursor: grabbing; }
.ojb-float-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-success-primary, #3fb950); flex: none; }
.ojb-float-dot-busy { background: var(--dsw-alias-state-warn-primary, #d29922); animation: ojb-pulse 1s ease-in-out infinite; }
.ojb-float-dot-bad { background: var(--dsw-alias-state-error-primary, #f85149); }
@keyframes ojb-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.ojb-float-title { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ojb-float-btn { flex: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary, #999); font: inherit; font-size: 14px; line-height: 1; cursor: pointer; padding: 3px 5px; border-radius: 5px; }
.ojb-float-btn:hover { color: var(--dsw-alias-label-primary, #eee); background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14)); }
.ojb-float-body { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px 10px; }
.ojb-float-shot { position: relative; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25)); border-radius: 8px; overflow: hidden; background: var(--dsw-alias-bg-base, #111); cursor: zoom-in; }
.ojb-float-shot img { display: block; width: 100%; height: auto; max-height: 190px; object-fit: contain; }
.ojb-float-shot-large img { max-height: 58vh; }
.ojb-float-shot-empty { display: flex; align-items: center; justify-content: center; gap: 8px; height: 150px; color: var(--dsw-alias-label-secondary, #999); cursor: default; }
.ojb-float-shot-large .ojb-float-shot-empty { height: 260px; }
.ojb-float-spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4)); border-top-color: var(--dsw-alias-brand-primary, #5b8def); animation: ojb-spin .8s linear infinite; }
@keyframes ojb-spin { to { transform: rotate(360deg); } }
.ojb-float-badge { position: absolute; top: 6px; left: 6px; right: 6px; display: flex; align-items: center; gap: 5px; min-width: 0; padding: 2px 7px; border-radius: 999px; background: rgba(0,0,0,.62); color: #fff; font-size: 11px; line-height: 1.5; }
.ojb-float-badge.is-bad { background: rgba(150,30,30,.78); }
.ojb-float-badge-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ojb-float-badge-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-warn-primary, #d29922); animation: ojb-pulse 1s ease-in-out infinite; }
.ojb-float-line { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.ojb-float-page-title { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ojb-float-url { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary, #999); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ojb-float-error { color: var(--dsw-alias-state-error-primary, #f85149); font-size: 11px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ojb-float-meta { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary, #999); font-size: 11px; }
.ojb-float-meta > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ojb-float-spacer { flex: 1; }
.ojb-float-tab { position: fixed; right: 0; top: 38%; z-index: 2150; display: flex; flex-direction: column; align-items: center; gap: 4px; width: 40px; padding: 6px 5px; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35)); border-right: 0; border-radius: 10px 0 0 10px; background: var(--dsw-alias-bg-overlay, #1f1f1f); color: var(--dsw-alias-label-secondary, #999); cursor: pointer; box-shadow: -2px 0 10px rgba(0,0,0,.22); }
.ojb-float-tab:hover { color: var(--dsw-alias-label-primary, #eee); }
.ojb-float-tab img { display: block; width: 100%; border-radius: 5px; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25)); }
.ojb-float-tab-glyph { font-size: 14px; }
@media (prefers-reduced-motion: reduce) { .ojb-float-pop, .ojb-float-dot-busy, .ojb-float-badge-dot, .ojb-float-spinner { animation: none; } }
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

// ---------------------------------------------------------------------------
// Plugin-page setup panel.
//
// Registered on `plugins.bundle.config` / `plugins.bundle.activation`: those are
// the slots the Plugins page renders inside a plugin's own page (the contract
// the official voice-input plugin uses), not the generic settings page.
// ---------------------------------------------------------------------------

function formatBytes(value?: number): string {
  if (!value || value <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = value
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 || v >= 10 ? 0 : 1)} ${units[i]}`
}

function PluginSetupPanel(props: SectionProps) {
  const useOpenjev = props.useOpenjev
  const t = props.t ?? (((key: Dict) => zh[key] ?? key) as TFunction)
  const isZh = t('nav.label') === zh['nav.label']
  const L = (a: string, b: string): string => (isZh ? a : b)

  const [choice, setChoice] = React.useState<'download' | 'custom' | 'url'>('download')
  const [dir, setDir] = React.useState('')
  const [repo, setRepo] = React.useState('')
  const [customDir, setCustomDir] = React.useState('')
  const [url, setUrl] = React.useState('')
  const [cuda, setCuda] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  const snapshot = useOpenjev ? useOpenjev((s) => s) : null
  const data = snapshot?.data ?? null
  const download = data?.download
  const busy = snapshot ? snapshot.busy !== null : false

  React.useEffect(() => {
    void controllerRef.load(true)
  }, [])

  React.useEffect(() => {
    if (!data) return
    setDir((v) => v || data.defaults.modelDir)
    setRepo((v) => v || data.defaults.modelRepo)
    setCustomDir((v) => v || data.config.modelDir || '')
    setUrl((v) => v || data.config.openjevUrl)
  }, [data?.defaults.modelDir, data?.defaults.modelRepo, data?.config.modelDir, data?.config.openjevUrl])

  if (!useOpenjev) return null

  const controller = controllerRef
  const running = download?.status === 'running'
  const done = download?.status === 'done'
  const pct = download?.bytesTotal ? Math.min(100, Math.round(((download.bytesDone ?? 0) / download.bytesTotal) * 100)) : 0
  const interpreter = data?.python?.path ?? 'python'
  const commands = [
    `"${interpreter}" -m pip install torch --index-url ${cuda ? 'https://download.pytorch.org/whl/cu128' : 'https://download.pytorch.org/whl/cpu'}`,
    `"${interpreter}" -m pip install "transformers==5.12.1" safetensors numpy huggingface-hub fastapi uvicorn`,
  ].join('\n')

  return (
    <div className="ojb-root">
      <div className="ojb-card">
        <h3>{L('决策服务', 'Decision service')}</h3>
        <div className="ojb-row">
          <span className={data?.server.ready ? 'ojb-ok' : 'ojb-dim'}>
            {data?.server.ready
              ? `● ${L('已就绪', 'ready')}`
              : data?.artifact?.dir && data?.python?.usable
                ? `○ ${L('模型已就绪，服务未启动', 'model ready, service not started')}`
                : `○ ${L('未就绪', 'not ready')}`}
          </span>
          {data?.server.model && <span className="ojb-dim">{data.server.model}</span>}
          {data?.artifact?.dir && <span className="ojb-mono ojb-dim">{data.artifact.dir}</span>}
          {!data?.server.ready && data?.artifact?.dir && data?.python?.usable && (
            <button className="ojb-btn ojb-btn-primary" disabled={busy} onClick={() => void controller.server('start')}>
              {L('启动服务', 'Start service')}
            </button>
          )}
          {data?.server.ready && (
            <button className="ojb-btn" disabled={busy} onClick={() => void controller.server('stop')}>
              {L('停止服务', 'Stop service')}
            </button>
          )}
        </div>
      </div>

      <div className="ojb-card">
        <h3>{L('模型来源', 'Model source')}</h3>
        <div className="ojb-choice">
          <button className="ojb-btn" data-active={choice === 'download'} disabled={running} onClick={() => setChoice('download')}>
            {L('HuggingFace 下载', 'Download from HF')}
          </button>
          <button className="ojb-btn" data-active={choice === 'custom'} disabled={running} onClick={() => setChoice('custom')}>
            {L('已有模型目录', 'Existing model dir')}
          </button>
          <button className="ojb-btn" data-active={choice === 'url'} disabled={running} onClick={() => setChoice('url')}>
            {L('已有服务', 'Existing service')}
          </button>
        </div>
        {choice === 'download' && (
          <div className="ojb-stack">
            <div className="ojb-row">
              <span className="ojb-label">{L('仓库', 'Repo')}</span>
              <input className="ojb-input" value={repo} disabled={running} onChange={(e) => setRepo(e.target.value)} />
            </div>
            <div className="ojb-row">
              <span className="ojb-label">{L('保存到', 'Save to')}</span>
              <input className="ojb-input" value={dir} disabled={running} onChange={(e) => setDir(e.target.value)} />
            </div>
            {running && (
              <>
                <div className="ojb-bar">
                  <div className="ojb-bar-fill" style={{ width: `${pct}%` }} />
                </div>
                <p className="ojb-hint">
                  {`${pct}% · ${formatBytes(download?.bytesDone)} / ${formatBytes(download?.bytesTotal)} · ${download?.fileIndex ?? 0}/${download?.fileCount ?? 0}`}
                </p>
              </>
            )}
            {download?.status === 'error' && <p className="ojb-bad">{`✗ ${download.error ?? ''}`}</p>}
            {done && <p className="ojb-ok">{L('下载完成并通过工件校验', 'Download finished and validated')}</p>}
            <div className="ojb-row">
              {!running && !done && (
                <button className="ojb-btn ojb-btn-primary" disabled={busy} onClick={() => void controller.startDownload(dir, repo)}>
                  {L('开始下载', 'Start download')}
                </button>
              )}
              {running && (
                <button className="ojb-btn" onClick={() => void controller.cancelDownload()}>
                  {L('取消下载', 'Cancel')}
                </button>
              )}
              {done && (
                <button className="ojb-btn ojb-btn-primary" disabled={busy} onClick={() => void controller.adoptModelDir(dir)}>
                  {L('使用这个模型', 'Use this model')}
                </button>
              )}
            </div>
          </div>
        )}
        {choice === 'custom' && (
          <div className="ojb-stack">
            <div className="ojb-row">
              <span className="ojb-label">{L('模型目录', 'Model dir')}</span>
              <input className="ojb-input" value={customDir} onChange={(e) => setCustomDir(e.target.value)} />
            </div>
            <div className="ojb-row">
              <button className="ojb-btn ojb-btn-primary" disabled={busy} onClick={() => void controller.adoptModelDir(customDir)}>
                {L('校验并保存', 'Validate and save')}
              </button>
            </div>
          </div>
        )}
        {choice === 'url' && (
          <div className="ojb-stack">
            <div className="ojb-row">
              <span className="ojb-label">{L('服务地址', 'Service URL')}</span>
              <input className="ojb-input" value={url} onChange={(e) => setUrl(e.target.value)} />
            </div>
            <div className="ojb-row">
              <button className="ojb-btn ojb-btn-primary" disabled={busy} onClick={() => void controller.save({ openjevUrl: url })}>
                {L('连接并保存', 'Connect and save')}
              </button>
            </div>
          </div>
        )}
      </div>

      {(!data?.python || !data.python.usable) && (
        <div className="ojb-card">
          <h3>{L('Python 运行环境（torch 等）', 'Python runtime (torch etc.)')}</h3>
          <p className="ojb-hint">
            {data?.python?.path
              ? `${L('解释器', 'Interpreter')}: ${data.python.path}`
              : L('未检测到解释器：把下面命令里的 python 换成你的解释器路径', 'No interpreter detected: replace python below with your path')}
          </p>
          {data?.python && (data.python.missing ?? []).length > 0 && (
            <p className="ojb-hint">
              {L('缺少模块：', 'Missing: ')}
              <span className="ojb-mono">{(data.python.missing ?? []).join(', ')}</span>
            </p>
          )}
          <div className="ojb-row">
            <button className="ojb-btn" data-active={!cuda} onClick={() => setCuda(false)}>
              CPU
            </button>
            <button className="ojb-btn" data-active={cuda} onClick={() => setCuda(true)}>
              CUDA 12.8
            </button>
          </div>
          <pre className="ojb-pre">{commands}</pre>
          <div className="ojb-row">
            <button
              className="ojb-btn"
              onClick={() => {
                void navigator.clipboard
                  .writeText(commands)
                  .then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  })
                  .catch(() => {})
              }}
            >
              {copied ? L('已复制', 'Copied') : L('复制命令', 'Copy commands')}
            </button>
          </div>
          <p className="ojb-hint">
            {L(
              '服务端代码已随插件内置，不要 pip 安装 openjev；模型用上面的来源选择处理。',
              'The server code ships with the plugin — do not pip install openjev.',
            )}
          </p>
        </div>
      )}

      {snapshot?.notice && (
        <p className={snapshot.notice.startsWith('✗') ? 'ojb-bad' : 'ojb-ok'}>
          {snapshot.notice === 'ok' ? `✓ ${L('已保存并通过校验', 'Saved and validated')}` : snapshot.notice}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Floating browser preview (`shell.overlay`).
//
// Pops up when a browser tool is called and shows what the plugin's browser is
// displaying right now: the latest page frame, title, URL and the tool that
// just ran. The frame is captured host-side and never enters the model
// context. Drag the header to move it (position is remembered), double-click
// the header or the frame to switch compact/large, × hides it behind a slim
// thumbnail tab until the next browser tool call.
// ---------------------------------------------------------------------------

interface BrowserPreviewInfo {
  seq: number
  at: number
  width: number
  height: number
  bytes: number
  format?: 'jpeg' | 'png'
}

interface BrowserActivity {
  tool: string
  phase: 'running' | 'done'
  ok?: boolean
  summary?: string
  detail?: string
  at: number
  rev: number
}

interface BrowserSnapshot {
  open: boolean
  browser?: { requested?: string; channel?: string; version?: string | null; user_data_dir?: string | null }
  page?: { url?: string; title?: string }
  headed?: boolean
  viewport?: [number, number]
  busy?: boolean
  running?: boolean
  activity?: BrowserActivity | null
  preview?: BrowserPreviewInfo | null
}

const FLOAT_POS_KEY = 'dsh.openjev.browserFloat.pos'
const FLOAT_SIZE_KEY = 'dsh.openjev.browserFloat.size'
const FLOAT_WIDTH = 320
const FLOAT_WIDTH_LARGE = 560
const POLL_OPEN_MS = 1500
const POLL_IDLE_MS = 3000
const POLL_BACKGROUND_MS = 5000

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function readFloatPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(FLOAT_POS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { x?: number; y?: number }
    if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') return { x: parsed.x, y: parsed.y }
  } catch {
    // private mode / quota — fall back to the default corner
  }
  return null
}

function readFloatLarge(): boolean {
  try {
    return localStorage.getItem(FLOAT_SIZE_KEY) === 'large'
  } catch {
    return false
  }
}

function persistFloat(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

async function fetchBrowser(): Promise<BrowserSnapshot> {
  const response = await fetch(`${API}/browser`, { headers: { accept: 'application/json' } })
  const payload = (await response.json()) as { ok?: boolean; browser?: BrowserSnapshot }
  if (!response.ok || !payload?.ok || !payload.browser) throw new Error(`HTTP ${response.status}`)
  return payload.browser
}

async function captureBrowser(): Promise<BrowserSnapshot | null> {
  const response = await fetch(`${API}/browser/capture`, { method: 'POST', headers: { accept: 'application/json' } })
  const payload = (await response.json()) as { ok?: boolean; browser?: BrowserSnapshot }
  return response.ok && payload?.ok && payload.browser ? payload.browser : null
}

function BrowserFloat(props: SectionProps) {
  const t = props.t ?? (((key: Dict) => zh[key] ?? key) as TFunction)

  const [snap, setSnap] = React.useState<BrowserSnapshot | null>(null)
  const [hidden, setHidden] = React.useState(false)
  const [large, setLarge] = React.useState(() => readFloatLarge())
  const [pos, setPos] = React.useState<{ x: number; y: number } | null>(() => readFloatPos())
  const [flash, setFlash] = React.useState(0)
  const [imgUrl, setImgUrl] = React.useState<string | null>(null)
  const [imgFailed, setImgFailed] = React.useState(false)
  const [waitExpired, setWaitExpired] = React.useState(false)
  const [win, setWin] = React.useState(() => ({
    width: typeof window === 'undefined' ? 1280 : window.innerWidth,
    height: typeof window === 'undefined' ? 800 : window.innerHeight,
  }))

  const box = React.useRef<HTMLDivElement | null>(null)
  const drag = React.useRef<{ dx: number; dy: number } | null>(null)
  const hiddenRef = React.useRef(false)
  const frameUrlRef = React.useRef<string | null>(null)
  const loadedSeqRef = React.useRef(-1)

  // Fetch a frame with `fetch` and hand React an object URL, so preview bytes
  // ride the same authenticated request path as the JSON API instead of an
  // <img> request that cannot carry request headers.
  const loadFrame = React.useCallback(async (seq: number): Promise<void> => {
    if (seq <= 0 || seq === loadedSeqRef.current) return
    loadedSeqRef.current = seq
    try {
      const response = await fetch(`${API}/browser/preview?seq=${seq}`, { headers: { accept: 'image/*' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const blob = await response.blob()
      // A newer frame may have been requested while this one was in flight;
      // the newest sequence always wins.
      if (loadedSeqRef.current !== seq) return
      const url = URL.createObjectURL(blob)
      const previous = frameUrlRef.current
      frameUrlRef.current = url
      setImgUrl(url)
      setImgFailed(false)
      if (previous) URL.revokeObjectURL(previous)
    } catch {
      if (loadedSeqRef.current === seq) {
        loadedSeqRef.current = -1
        setImgFailed(true)
      }
    }
  }, [])

  React.useEffect(
    () => () => {
      if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current)
      frameUrlRef.current = null
    },
    [],
  )

  const syncFrame = (next: BrowserSnapshot | null): void => {
    if (!next?.preview) return
    void loadFrame(next.preview.seq)
  }

  const captureNow = React.useCallback(async (): Promise<void> => {
    const captured = await captureBrowser().catch(() => null)
    if (!captured) return
    setSnap(captured)
    if (captured.preview) void loadFrame(captured.preview.seq)
  }, [loadFrame])

  React.useEffect(() => {
    hiddenRef.current = hidden
  }, [hidden])

  React.useEffect(() => {
    const onResize = (): void => setWin({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Surface a stuck loading state instead of spinning forever when the host
  // cannot produce a frame for this page.
  React.useEffect(() => {
    if (!snap?.open || snap.preview || imgUrl) {
      setWaitExpired(false)
      return
    }
    const timer = setTimeout(() => setWaitExpired(true), 8000)
    return () => clearTimeout(timer)
  }, [snap?.open, snap?.preview?.seq, imgUrl])

  // Keep the window inside the viewport after a size toggle, a window resize
  // or a frame that changes the panel's height.
  React.useEffect(() => {
    if (!snap?.open || hidden) return
    const rect = box.current?.getBoundingClientRect()
    if (!rect) return
    setPos((current) => {
      if (!current) return current
      const x = clamp(current.x, 4, win.width - rect.width - 4)
      const y = clamp(current.y, 4, win.height - rect.height - 4)
      return x === current.x && y === current.y ? current : { x, y }
    })
  }, [large, win.width, win.height, snap?.open, hidden, imgUrl])

  // Status polling + live frame capture in one loop: read the session state,
  // pop the panel when a browser tool revision appears, then (only while the
  // panel is visible) ask the host for a fresh frame. A hidden panel or a
  // background tab captures less often and never on a closed session.
  React.useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let busy = false
    let initialized = false
    let wasOpen = false
    let lastRev = 0
    let lastCapture = 0
    let failures = 0
    let refreshOnce = false

    const schedule = (ms: number): void => {
      if (alive) timer = setTimeout(() => void run(), ms)
    }

    const run = async (): Promise<void> => {
      if (busy) {
        schedule(600)
        return
      }
      busy = true
      let next: BrowserSnapshot | null = null
      try {
        next = await fetchBrowser()
      } catch {
        failures += 1
        busy = false
        schedule(Math.min(2500 * failures, 15_000))
        return
      }
      failures = 0
      if (!alive) {
        busy = false
        return
      }

      const rev = next.activity?.rev ?? 0
      const age = next.activity ? Date.now() - next.activity.at : Number.POSITIVE_INFINITY
      const recent = age < 12_000
      const followUp = age < 6_000
      const opened = initialized && next.open && !wasOpen
      const triggered = initialized
        ? opened || (next.open && recent && rev !== lastRev)
        : next.open && recent
      if (triggered) {
        const wasHidden = hiddenRef.current
        setHidden(false)
        // Pop only when the window appears or comes back; while it is already
        // open, the activity badge and frame update carry the feedback. This
        // keeps the animation from replaying on every tool of a long run.
        if (wasHidden || !wasOpen || !initialized) setFlash((value) => value + 1)
        lastCapture = 0 // fresh frame for the new page state
      }
      if (!next.open) {
        // A closed session invalidates the frame; a later open starts a new
        // sequence and must always load.
        loadedSeqRef.current = -1
        const stale = frameUrlRef.current
        frameUrlRef.current = null
        setImgUrl(null)
        if (stale) URL.revokeObjectURL(stale)
      }
      if (next.open) lastRev = rev
      wasOpen = next.open
      initialized = true
      setSnap(next)
      syncFrame(next)

      const background = document.visibilityState === 'hidden'
      // A trigger already unhid the panel in this tick; hiddenRef only flips
      // after the next render, so account for the trigger explicitly.
      const visible = next.open && (!hiddenRef.current || triggered) && !background
      // Capture on tool activity, for a few seconds afterwards (async
      // navigations often finish after the tool returns), when the panel
      // appears, or when the tab came back to the front. An idle page is not
      // re-captured for nothing; the refresh button still forces a frame.
      const wantsFrame = triggered || followUp || refreshOnce
      if (visible && wantsFrame && Date.now() - lastCapture >= (triggered ? 300 : 1500)) {
        const captured = await captureBrowser().catch(() => null)
        if (!alive) {
          busy = false
          return
        }
        if (captured) {
          lastCapture = Date.now()
          refreshOnce = false
          setSnap(captured)
          syncFrame(captured)
        }
      }
      busy = false
      schedule(background ? POLL_BACKGROUND_MS : visible ? POLL_OPEN_MS : POLL_IDLE_MS)
    }

    schedule(0)
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') return
      refreshOnce = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (!busy) void run()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVisibility)
      if (timer !== null) clearTimeout(timer)
    }
  }, [])

  React.useEffect(() => {
    const move = (event: PointerEvent): void => {
      const current = drag.current
      if (!current) return
      const rect = box.current?.getBoundingClientRect()
      const panelWidth = rect?.width ?? FLOAT_WIDTH
      const panelHeight = rect?.height ?? 120
      setPos({
        x: clamp(event.clientX - current.dx, 4, window.innerWidth - panelWidth - 4),
        y: clamp(event.clientY - current.dy, 4, window.innerHeight - panelHeight - 4),
      })
    }
    const up = (): void => {
      if (!drag.current) return
      drag.current = null
      setPos((current) => {
        if (current) persistFloat(FLOAT_POS_KEY, JSON.stringify(current))
        return current
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [])

  if (!snap?.open) return null

  const page = snap.page ?? {}
  const browser = snap.browser ?? {}
  const activity = snap.activity ?? null
  const running = snap.running === true || snap.busy === true || activity?.phase === 'running'
  const failed = !running && activity?.phase === 'done' && activity.ok === false
  const preview = snap.preview ?? null
  const widthPx = large ? Math.max(280, Math.min(FLOAT_WIDTH_LARGE, win.width - 24)) : FLOAT_WIDTH
  const fallback = { x: Math.max(8, win.width - widthPx - 18), y: 96 }
  const at = pos
    ? { x: clamp(pos.x, 4, win.width - widthPx - 4), y: clamp(pos.y, 4, win.height - 92) }
    : fallback
  const imageSrc = imgUrl && !imgFailed ? imgUrl : null
  const thumbSrc = imageSrc
  const noFrame = imgFailed || waitExpired

  const describe = (value: BrowserActivity): string => {
    const tool = value.tool.replace(/^browser_/, '')
    const state =
      value.phase === 'running' ? t('float.running') : value.ok === false ? t('float.failed') : t('float.done')
    return `${tool}${value.summary ? ` · ${value.summary}` : ''} · ${state}`
  }

  const toggleLarge = (): void => {
    setLarge((current) => {
      const next = !current
      persistFloat(FLOAT_SIZE_KEY, next ? 'large' : 'compact')
      return next
    })
  }

  if (hidden) {
    return (
      <button
        className="ojb-float-tab"
        title={t('float.show')}
        aria-label={t('float.show')}
        onClick={() => {
          setHidden(false)
          setFlash((value) => value + 1)
          void captureNow()
        }}
      >
        {thumbSrc ? <img src={thumbSrc} alt="" /> : <span className="ojb-float-tab-glyph">◧</span>}
      </button>
    )
  }

  return (
    <div
      key={`ojb-float-${flash}`}
      ref={box}
      className="ojb-float ojb-float-pop"
      style={{ left: at.x, top: at.y, width: widthPx }}
      role="region"
      aria-label={t('float.title')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setHidden(true)
      }}
    >
      <div
        className="ojb-float-head"
        title={t('float.captureHint')}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          const rect = box.current?.getBoundingClientRect()
          drag.current = { dx: event.clientX - (rect?.left ?? at.x), dy: event.clientY - (rect?.top ?? at.y) }
        }}
        onDoubleClick={toggleLarge}
      >
        <span className={`ojb-float-dot${running ? ' ojb-float-dot-busy' : failed ? ' ojb-float-dot-bad' : ''}`} />
        <span className="ojb-float-title">{t('float.title')}</span>
        <button
          className="ojb-float-btn"
          title={large ? t('float.shrink') : t('float.expand')}
          aria-label={large ? t('float.shrink') : t('float.expand')}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={toggleLarge}
        >
          {large ? '⤡' : '⤢'}
        </button>
        <button
          className="ojb-float-btn"
          title={t('float.close')}
          aria-label={t('float.close')}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setHidden(true)}
        >
          ×
        </button>
      </div>
      <div className="ojb-float-body">
        <div
          className={`ojb-float-shot${large ? ' ojb-float-shot-large' : ''}`}
          title={large ? t('float.shrink') : t('float.expand')}
          onClick={toggleLarge}
        >
          {imageSrc ? (
            <img src={imageSrc} alt={page.title || t('float.untitled')} onError={() => setImgFailed(true)} />
          ) : (
            <div className="ojb-float-shot-empty">
              {noFrame ? null : <span className="ojb-float-spinner" />}
              <span>{noFrame ? t('float.previewUnavailable') : t('float.waiting')}</span>
            </div>
          )}
          <span className={`ojb-float-badge${failed ? ' is-bad' : ''}`} title={activity?.detail ?? ''}>
            {running ? <span className="ojb-float-badge-dot" /> : null}
            <span className="ojb-float-badge-text" aria-live="polite">
              {activity ? describe(activity) : t('float.idle')}
            </span>
          </span>
        </div>
        <div className="ojb-float-line">
          <span className="ojb-float-page-title" title={page.title || ''}>
            {page.title || t('float.untitled')}
          </span>
        </div>
        <div className="ojb-float-url" title={page.url || ''}>
          {page.url || '-'}
        </div>
        {failed && activity?.detail ? (
          <div className="ojb-float-error" title={activity.detail}>
            {activity.detail}
          </div>
        ) : null}
        <div className="ojb-float-meta">
          <span>
            {String(browser.channel ?? '-')}
            {browser.version ? ` · ${browser.version}` : ''}
          </span>
          <span>
            {snap.headed ? t('float.headed') : t('float.headless')}
            {snap.viewport ? ` · ${snap.viewport[0]}×${snap.viewport[1]}` : ''}
          </span>
          <span className="ojb-float-spacer" />
          <span>{preview ? new Date(preview.at).toLocaleTimeString() : '—'}</span>
          <button
            className="ojb-float-btn"
            title={t('float.refresh')}
            aria-label={t('float.refresh')}
            onClick={(event) => {
              event.stopPropagation()
              void captureNow()
            }}
          >
            ⟳
          </button>
        </div>
      </div>
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
  // Styles live in <head> for the frame's lifetime; own them with an effect so
  // a plugin reload replaces them instead of leaving stale rules behind.
  const mountStyles = (): (() => void) => {
    if (typeof document === 'undefined') return () => {}
    // The replace-then-create order keeps the newest tag when a hot reload
    // mounts the new instance before disposing the old one.
    const previous = document.getElementById('ojb-style')
    if (previous) previous.remove()
    const tag = document.createElement('style')
    tag.id = 'ojb-style'
    tag.textContent = CSS
    document.head.appendChild(tag)
    return () => {
      tag.remove()
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(mountStyles, 'dsh-openjev-browser: styles')
  else mountStyles()
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

  // The plugin's own page (插件 → dsh-openjev-browser) renders this panel.
  // `plugins.bundle.config` is the settings area of that page, `activation`
  // sits next to the enable toggle — the same contract the official
  // voice-input plugin uses.
  const setupRender = (p: SectionProps) => <PluginSetupPanel {...p} t={t} />
  for (const slot of ['plugins.bundle.config', 'plugins.bundle.activation'] as const) {
    ctx.slots.inject(slot, () =>
      ctx.slots.register({ name: slot, key: NS, locale: NS, inject: face }, setupRender),
    )
  }

  // Floating page preview: pops up when a browser tool is called, shows the
  // current page frame, draggable and collapsible. Mounted frame-wide so it
  // is never clipped by a column's overflow.
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: `${NS}-browser-float`, order: 25 }, (p: SectionProps) => (
      <BrowserFloat {...p} t={t} />
    )),
  )
}
