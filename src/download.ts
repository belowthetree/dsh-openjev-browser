/**
 * Minimal Hugging Face repo downloader for the OpenJev model artifact.
 *
 * Used by the setup CLI (`node lib/setup.js download --dir <target>`). The
 * plugin repository ships no model weights; this fetches them on demand into a
 * user-specified directory, resuming partial files, then the caller validates
 * the result with validateArtifact() (manifest + COMPLETE + sizes).
 */

import { createWriteStream } from 'node:fs'
import { mkdir, stat, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface DownloadProgress {
  file: string
  fileIndex: number
  fileCount: number
  bytesDone: number
}

export interface DownloadOptions {
  repo: string
  dir: string
  revision?: string
  concurrency?: number
  onProgress?: (p: DownloadProgress) => void
  signal?: AbortSignal
}

interface ModelInfo {
  siblings?: { rfilename: string }[]
}

/** List repo files via the HF API. */
export async function listRepoFiles(repo: string, signal?: AbortSignal): Promise<string[]> {
  const url = `https://huggingface.co/api/models/${repo}`
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`HF API ${response.status} for ${url}`)
  const info = (await response.json()) as ModelInfo
  const files = (info.siblings ?? []).map((s) => s.rfilename)
  if (files.length === 0) throw new Error(`HF repo ${repo} listed no files`)
  return files
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/** Download one file with resume support (<file>.part staging). */
async function downloadFile(
  repo: string,
  revision: string,
  name: string,
  dir: string,
  onBytes: (n: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = `https://huggingface.co/${repo}/resolve/${revision}/${name}`
  const target = join(dir, ...name.split('/'))
  const part = `${target}.part`
  await mkdir(dirname(target), { recursive: true })

  const existing = await fileSize(part)
  const headers: Record<string, string> = {}
  if (existing > 0) headers.Range = `bytes=${existing}-`

  const response = await fetch(url, { headers, redirect: 'follow', signal })
  if (!response.ok && response.status !== 206) {
    throw new Error(`HTTP ${response.status} downloading ${name}`)
  }
  if (!response.body) throw new Error(`empty response body for ${name}`)
  let resumed = existing
  if (existing > 0 && response.status === 200) {
    // Server ignored the Range header: restart the file from scratch.
    onBytes(-existing)
    resumed = 0
  }
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      onBytes(chunk.length)
      cb(null, chunk)
    },
  })
  const stream = createWriteStream(part, { flags: resumed > 0 ? 'a' : 'w' })
  await pipeline(Readable.fromWeb(response.body as never), counter, stream)
  await rename(part, target)
}

/**
 * Download every repo file into `dir`. Concurrency-limited, resumable.
 * Returns the list of downloaded files.
 */
export async function downloadRepo(options: DownloadOptions): Promise<string[]> {
  const { repo, dir, revision = 'main', concurrency = 4, onProgress, signal } = options
  const files = await listRepoFiles(repo, signal)
  await mkdir(dir, { recursive: true })

  let bytesDone = 0
  let cursor = 0
  const failures: Error[] = []

  async function worker(): Promise<void> {
    while (cursor < files.length) {
      const index = cursor++
      const name = files[index]
      if (signal?.aborted) return
      try {
        await downloadFile(repo, revision, name, dir, (n) => {
          bytesDone += n
          onProgress?.({ file: name, fileIndex: index + 1, fileCount: files.length, bytesDone })
        }, signal)
      } catch (err) {
        failures.push(new Error(`${name}: ${(err as Error).message}`))
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()))
  if (failures.length > 0) {
    throw new Error(`download failed for ${failures.length} file(s): ${failures.map((e) => e.message).join('; ')}`)
  }
  return files
}
