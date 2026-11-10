/**
 * Background model download job (single instance per plugin).
 *
 * The setup pane starts a job for a target directory; the downloader streams
 * HF files with resume support and keeps a snapshot the HTTP API can poll.
 * When the transfer finishes the artifact is validated (manifest.json +
 * COMPLETE + byte sizes) so the UI never claims success on a partial tree.
 */

import { mkdir } from 'node:fs/promises'

import { downloadRepo, listRepoFilesWithSizes } from './download.js'
import { validateArtifact } from './model.js'

export type DownloadStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled'

export interface DownloadState {
  status: DownloadStatus
  dir?: string
  repo?: string
  file?: string
  fileIndex?: number
  fileCount?: number
  bytesDone?: number
  bytesTotal?: number
  error?: string
  startedAt?: number
  finishedAt?: number
}

type Logger = (level: string, message: string) => void

export class ModelDownloader {
  private controller: AbortController | null = null
  private state: DownloadState = { status: 'idle' }

  constructor(private readonly log: Logger) {}

  snapshot(): DownloadState {
    return { ...this.state }
  }

  get running(): boolean {
    return this.state.status === 'running'
  }

  async start(options: { dir: string; repo: string }): Promise<DownloadState> {
    if (this.state.status === 'running') throw new Error('已有模型下载任务在进行中')
    const { dir, repo } = options
    await mkdir(dir, { recursive: true })
    const controller = new AbortController()
    this.controller = controller
    this.state = {
      status: 'running',
      dir,
      repo,
      bytesDone: 0,
      bytesTotal: 0,
      fileCount: 0,
      fileIndex: 0,
      startedAt: Date.now(),
    }
    void this.run(dir, repo, controller.signal)
    return this.snapshot()
  }

  cancel(): DownloadState {
    this.controller?.abort()
    return this.snapshot()
  }

  private async run(dir: string, repo: string, signal: AbortSignal): Promise<void> {
    try {
      const files = await listRepoFilesWithSizes(repo, signal)
      const bytesTotal = files.reduce((sum, f) => sum + f.size, 0)
      this.state = { ...this.state, fileCount: files.length, bytesTotal }
      this.log(
        'info',
        `dsh-openjev-browser: downloading ${repo} → ${dir} (${files.length} files, ${(bytesTotal / 1e9).toFixed(2)} GB)`,
      )
      await downloadRepo({
        repo,
        dir,
        files,
        signal,
        onProgress: (p) => {
          this.state = {
            ...this.state,
            file: p.file,
            fileIndex: p.fileIndex,
            fileCount: p.fileCount,
            bytesDone: p.bytesDone,
            bytesTotal: Math.max(bytesTotal, p.bytesDone),
          }
        },
      })
      const check = validateArtifact(dir)
      if (!check.ok) {
        this.state = {
          ...this.state,
          status: 'error',
          error: `下载完成但工件校验失败：${check.error ?? 'unknown'}`,
          finishedAt: Date.now(),
        }
        return
      }
      this.state = { ...this.state, status: 'done', finishedAt: Date.now() }
      this.log('info', `dsh-openjev-browser: model artifact ready at ${dir}`)
    } catch (error) {
      const aborted = signal.aborted
      this.state = {
        ...this.state,
        status: aborted ? 'cancelled' : 'error',
        error: aborted ? undefined : (error as Error).message,
        finishedAt: Date.now(),
      }
      if (!aborted) this.log('warn', `dsh-openjev-browser: model download failed: ${(error as Error).message}`)
    } finally {
      this.controller = null
    }
  }
}
