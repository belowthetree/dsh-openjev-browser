/**
 * Thin async client for the OpenJev decision service (HTTP transport).
 *
 * Ported from openjev/browser/decide.py - HTTP mode only. The local
 * in-process engine fallback of the Python version is replaced by the
 * plugin's managed server subprocess (see model.ts), which is then still
 * reached over HTTP.
 */

export class OpenJevError extends Error {}

export interface DecideResult {
  answer: Record<string, unknown>
  usage: Record<string, unknown>
  runtime: Record<string, unknown>
}

export interface HealthResult {
  ok: boolean
  model?: string
  status?: string
  error?: string
}

export class OpenJevClient {
  constructor(
    public readonly baseUrl: string,
    private readonly timeoutMs = 300_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  /** POST one decision request; return the answer plus usage/runtime info. */
  async decide(request: unknown, signal?: AbortSignal): Promise<DecideResult> {
    const url = `${this.baseUrl}/v1/systemone`
    let response: Response
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: combined,
      })
    } catch (err) {
      throw new OpenJevError(`OpenJev service unreachable at ${url}: ${(err as Error).message}`)
    }
    const text = await response.text()
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(text)
    } catch {
      throw new OpenJevError(`OpenJev HTTP ${response.status}: non-JSON response: ${text.slice(0, 300)}`)
    }
    if (!response.ok) {
      const detail =
        typeof payload.detail === 'string'
          ? payload.detail
          : JSON.stringify(payload.detail ?? payload)
      throw new OpenJevError(`OpenJev HTTP ${response.status}: ${detail.slice(0, 300)}`)
    }
    const answers = (payload.answers ?? {}) as Record<string, Record<string, unknown>>
    return {
      answer: answers.target ?? {},
      usage: (payload.usage ?? {}) as Record<string, unknown>,
      runtime: (payload.runtime ?? {}) as Record<string, unknown>,
    }
  }

  /** GET /health; never throws. */
  async health(timeoutMs = 10_000): Promise<HealthResult> {
    const url = `${this.baseUrl}/health`
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok) {
        return { ok: false, status: `http-${response.status}`, error: `HTTP ${response.status}` }
      }
      const payload = (await response.json()) as Record<string, unknown>
      if (payload.status !== 'ready') {
        return { ok: false, status: String(payload.status ?? 'unknown'), error: `status=${payload.status}` }
      }
      return { ok: true, model: String(payload.model ?? ''), status: 'ready' }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
}
