/**
 * One long-lived browser session behind the tools.
 *
 * The session owns a single Playwright page. All state (current URL, open
 * tabs, logged-in cookies) lives here, which is what lets tool calls stay
 * stateless from the agent's point of view: the page simply persists.
 *
 * Ported 1:1 from openjev/browser/session.py (Python asyncio -> TS async).
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core'

import { configureEnv } from './env.js'
import { buildRequest, elementForChoice, estimateTokens } from './format.js'
import { CANDIDATE_SELECTOR, elementToPublic, extractInPage, observationSummary, parseObservation, type Observation, type RawObservation } from './observe.js'
import { OpenJevClient } from './openjev.js'

export class BrowserError extends Error {}

/** Below this probability a pick is flagged as a guess. */
export const LOW_CONFIDENCE = 0.5

export interface SessionOptions {
  headless?: boolean
  browser?: string
  userDataDir?: string
  userAgent?: string
  maxCandidates?: number
  includeOffscreen?: boolean
  maxNameLength?: number
  viewport?: [number, number]
  debugDir?: string
  timeoutMs?: number
  /** Resolve the OpenJev client lazily, so model-free actions work without a model. */
  resolveClient: (signal?: AbortSignal) => Promise<OpenJevClient>
}

type LaunchArgs = { channel?: string }

const BROWSER_CHOICES: Record<string, LaunchArgs[]> = {
  // playwright-core ships no browser binary, so try installed Chrome, then
  // Edge, then a Playwright-managed Chromium cache (if the user has one).
  auto: [{ channel: 'chrome' }, { channel: 'msedge' }, {}],
  chromium: [{}],
  chrome: [{ channel: 'chrome' }],
  msedge: [{ channel: 'msedge' }],
}

/** Bundled headless Chromium announces "HeadlessChrome"; some sites reject it. */
const SPOOFED_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// Runs inside the page (see the note on extractInPage): real functions, not
// strings, because the Node client evaluates strings as expressions.
function highlightInPage(args: { selector?: string }): Record<string, number> | null {
  const clear = () => {
    const old = document.getElementById('__openjev_highlight__')
    if (old) old.remove()
  }
  clear()
  if (!args.selector) return null
  const el = document.querySelector(args.selector)
  if (!el) return null
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const r = el.getBoundingClientRect()
  const box = document.createElement('div')
  box.id = '__openjev_highlight__'
  Object.assign(box.style, {
    position: 'absolute',
    left: (r.left + window.scrollX - 3) + 'px',
    top: (r.top + window.scrollY - 3) + 'px',
    width: (r.width + 6) + 'px',
    height: (r.height + 6) + 'px',
    border: '3px solid #ff2d55',
    borderRadius: '4px',
    boxShadow: '0 0 0 3px rgba(255,45,85,0.30)',
    pointerEvents: 'none',
    zIndex: '2147483647',
  })
  document.body.appendChild(box)
  return { x: Math.round(r.left), y: Math.round(r.top),
           w: Math.round(r.width), h: Math.round(r.height) }
}

function clearHighlightInPage(): boolean {
  const old = document.getElementById('__openjev_highlight__')
  if (old) old.remove()
  return !!old
}

export class BrowserSession {
  headless: boolean
  browser: string
  userDataDir?: string
  userAgent?: string
  maxCandidates: number
  includeOffscreen: boolean
  maxNameLength: number
  viewport: [number, number]
  debugDir?: string
  timeoutMs: number

  private resolveClient: (signal?: AbortSignal) => Promise<OpenJevClient>
  private browser_: Browser | null = null
  private context: BrowserContext | null = null
  page: Page | null = null
  browserInfo: Record<string, unknown> = {}
  lastObservation: Observation | null = null

  constructor(options: SessionOptions) {
    const browser = options.browser ?? 'auto'
    if (!(browser in BROWSER_CHOICES)) {
      throw new BrowserError(`browser must be one of ${Object.keys(BROWSER_CHOICES).join(', ')}, got '${browser}'`)
    }
    this.resolveClient = options.resolveClient
    this.headless = options.headless ?? true
    this.browser = browser
    this.userDataDir = options.userDataDir
    this.userAgent = options.userAgent
    this.maxCandidates = options.maxCandidates ?? 80
    this.includeOffscreen = options.includeOffscreen ?? true
    this.maxNameLength = options.maxNameLength ?? 90
    this.viewport = options.viewport ?? [1280, 900]
    this.debugDir = options.debugDir
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  // ------------------------------------------------------------- lifecycle
  async start(): Promise<Record<string, unknown>> {
    configureEnv()
    let lastError: unknown = null
    let used: LaunchArgs | null = null

    for (const kwargs of BROWSER_CHOICES[this.browser]) {
      try {
        if (this.userDataDir) {
          await mkdir(this.userDataDir, { recursive: true })
          this.context = await chromium.launchPersistentContext(this.userDataDir, {
            headless: this.headless,
            viewport: { width: this.viewport[0], height: this.viewport[1] },
            ...kwargs,
            ...this.contextKwargs(kwargs),
          })
          this.browser_ = this.context.browser()
          this.page = this.context.pages()[0] ?? (await this.context.newPage())
        } else {
          this.browser_ = await chromium.launch({ headless: this.headless, ...kwargs })
          this.context = await this.browser_.newContext({
            viewport: { width: this.viewport[0], height: this.viewport[1] },
            ...this.contextKwargs(kwargs),
          })
          this.page = await this.context.newPage()
        }
        used = kwargs
        break
      } catch (err) {
        lastError = err
        this.browser_ = null
        this.context = null
      }
    }

    if (this.context === null) {
      throw new BrowserError(`could not launch a browser for '${this.browser}': ${(lastError as Error)?.message ?? lastError}`)
    }

    this.context.setDefaultTimeout(this.timeoutMs)

    let version: string | null = null
    try {
      const browser = this.browser_ ?? this.context.browser()
      if (browser) version = browser.version()
    } catch {
      // version is informational only
    }
    if (!version && this.page) {
      // launchPersistentContext() does not always expose a Browser object;
      // fall back to what the page itself reports.
      try {
        const ua = await this.page.evaluate('navigator.userAgent')
        const match = /(?:Chrome|Chromium|Edg)\/([\d.]+)/.exec(String(ua))
        version = match ? match[1] : null
      } catch {
        // ignore
      }
    }

    this.browserInfo = {
      requested: this.browser,
      channel: used?.channel ?? 'bundled-chromium',
      version,
      user_data_dir: this.userDataDir ?? null,
    }
    return { browser: this.browserInfo, viewport: [...this.viewport] }
  }

  /** User agent: keep the real one unless the bundled headless browser needs cover. */
  private contextKwargs(launchKwargs: LaunchArgs): Record<string, string> {
    let ua = this.userAgent
    if (ua == null && !launchKwargs.channel) ua = SPOOFED_UA
    return ua ? { userAgent: ua } : {}
  }

  async close(): Promise<void> {
    for (const closer of [this.context, this.browser_]) {
      if (closer) {
        try {
          await closer.close()
        } catch {
          // best effort teardown
        }
      }
    }
    this.browser_ = this.context = null
    this.page = null
  }

  // -------------------------------------------------------------- navigate
  async goto(url: string, waitUntil: 'load' | 'domcontentloaded' | 'networkidle' = 'domcontentloaded') {
    const page = this.requirePage()
    const response = await page.goto(url, { waitUntil })
    try {
      await page.waitForLoadState('networkidle', { timeout: 3000 })
    } catch {
      // busy pages never go idle; not fatal
    }
    return { url: page.url(), title: await page.title(), status: response?.status() ?? null }
  }

  // --------------------------------------------------------------- observe
  async observe(): Promise<Observation> {
    const page = this.requirePage()
    const raw = await page.evaluate(extractInPage, {
      selector: CANDIDATE_SELECTOR,
      maxCandidates: this.maxCandidates,
      maxNameLength: this.maxNameLength,
      includeOffscreen: this.includeOffscreen,
    })
    const observation = parseObservation(raw as RawObservation, this.maxCandidates)
    this.lastObservation = observation
    return observation
  }

  /** Write the withheld observation to disk - never into the response. */
  private async dumpDebug(tag: string, payload: unknown): Promise<string | null> {
    if (!this.debugDir) return null
    await mkdir(this.debugDir, { recursive: true })
    const path = `${this.debugDir}/${tag}-${Date.now()}.json`
    await writeFile(path, JSON.stringify(payload, null, 2), 'utf8')
    return path
  }

  // ------------------------------------------------------------------ pick
  /** Ask OpenJev which element achieves `goal`; return only that element. */
  async pick(goal: string, opts: { includeAlternatives?: boolean; debug?: boolean; signal?: AbortSignal } = {}) {
    const observation = await this.observe()
    if (observation.elements.length === 0) {
      return {
        ok: false,
        goal,
        reason: 'no interactive elements found on the page',
        page: { url: observation.url, title: observation.title },
      }
    }

    const request = buildRequest(goal, observation)
    const observationTokens = estimateTokens(request)
    if (opts.debug) {
      await this.dumpDebug('observation', { request, raw: observationSummary(observation) })
    }

    const started = performance.now()
    let answer: Record<string, unknown>
    try {
      const client = await this.resolveClient(opts.signal)
      const result = await client.decide(request, opts.signal)
      answer = result.answer
    } catch (err) {
      return {
        ok: false,
        goal,
        reason: `decision model failed: ${(err as Error).name}: ${(err as Error).message}`,
        page: { url: observation.url, title: observation.title },
      }
    }
    const elapsedMs = Math.round(performance.now() - started)

    const choice = answer.choice as string | undefined
    const probabilities = (answer.probabilities ?? {}) as Record<string, number>
    const element = elementForChoice(observation.elements, choice)
    const probability = Number(probabilities[choice ?? ''] ?? 0.0)

    const result: Record<string, unknown> = {
      ok: true,
      goal,
      abstained: element === null,
      confidence: round4(Number(answer.confidence ?? 0.0)),
      probability: round4(probability),
      decision_ms: elapsedMs,
      page: { url: observation.url, title: observation.title },
    }
    if (element === null) {
      result.selected = null
      result.reason = 'OpenJev found no element on this page that satisfies the goal'
    } else {
      result.selected = elementToPublic(element)
      if (probability < LOW_CONFIDENCE) result.low_confidence = true
    }

    if (opts.includeAlternatives) {
      const ranked = Object.entries(probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3)
      result.alternatives = ranked.map(([label, p]) => {
        const el = elementForChoice(observation.elements, label)
        return { choice: label, probability: round4(Number(p)), name: el ? el.name : 'none' }
      })
    }

    // How much page content stayed inside the tool.
    const returnedTokens = Math.max(1, Math.floor(JSON.stringify(result).length / 4))
    const context: Record<string, unknown> = {
      observation_tokens_est: observationTokens,
      returned_tokens_est: returnedTokens,
      withheld_ratio: Math.round((observationTokens / returnedTokens) * 10) / 10,
    }
    if (observation.truncatedFrom) {
      // Tell the caller the observation was pruned, so a miss is actionable
      // (scroll and retry) instead of looking like the element does not exist.
      context.pruned_from = observation.truncatedFrom
    }
    result.context = context
    return result
  }

  // ---------------------------------------------------------------- action
  /**
   * Resolve a selector, preferring a visible match.
   *
   * Repeated navigation shapes can leave a selector matching a hidden clone
   * in another menu; clicking that one just times out.
   */
  private async locator(selector: string): Promise<Locator> {
    const page = this.requirePage()
    const loc = page.locator(selector)
    try {
      const visible = loc.filter({ visible: true })
      if ((await visible.count()) > 0) return visible.first()
    } catch {
      // fall back to the raw locator
    }
    return loc.first()
  }

  /** Act on an explicit selector, or pick one from a goal first. */
  private async resolve(
    selector: string | undefined,
    goal: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ locator: Locator | null; picked: Record<string, unknown> | null }> {
    if (selector) return { locator: await this.locator(selector), picked: null }
    if (!goal) throw new BrowserError('provide either selector or goal')
    const picked = (await this.pick(goal, { signal })) as Record<string, unknown>
    if (!picked.ok || picked.abstained) return { locator: null, picked }
    const selected = picked.selected as { selector: string }
    return { locator: await this.locator(selected.selector), picked }
  }

  async click(opts: { selector?: string; goal?: string; signal?: AbortSignal }) {
    const { locator, picked } = await this.resolve(opts.selector, opts.goal, opts.signal)
    if (locator === null) return { ok: false, reason: 'no element selected', pick: picked }
    await locator.click()
    const page = this.requirePage()
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 })
    } catch {
      // client-side navigation may not fire it
    }
    return {
      ok: true,
      action: 'click',
      target: picked ? picked.selected : { selector: opts.selector },
      page: { url: page.url(), title: await page.title() },
    }
  }

  async typeText(text: string, opts: { selector?: string; goal?: string; submit?: boolean; clearFirst?: boolean; signal?: AbortSignal }) {
    const { locator, picked } = await this.resolve(opts.selector, opts.goal, opts.signal)
    if (locator === null) return { ok: false, reason: 'no element selected', pick: picked }
    if (opts.clearFirst ?? true) await locator.fill('')
    await locator.pressSequentially(text)
    const page = this.requirePage()
    if (opts.submit) {
      await locator.press('Enter')
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 8000 })
      } catch {
        // ignore
      }
    }
    return {
      ok: true,
      action: 'type',
      target: picked ? picked.selected : { selector: opts.selector },
      submitted: opts.submit ?? false,
      page: { url: page.url(), title: await page.title() },
    }
  }

  async scroll(opts: { direction?: string; amount?: number; selector?: string; goal?: string; signal?: AbortSignal }) {
    const direction = opts.direction ?? 'down'
    const amount = opts.amount ?? 800
    if (opts.selector || opts.goal) {
      const { locator, picked } = await this.resolve(opts.selector, opts.goal, opts.signal)
      if (locator === null) return { ok: false, reason: 'no element selected', pick: picked }
      await locator.scrollIntoViewIfNeeded()
      return { ok: true, action: 'scroll_into_view', target: picked ? picked.selected : { selector: opts.selector } }
    }
    let dx = 0
    let dy = 0
    if (direction === 'down') dy = amount
    else if (direction === 'up') dy = -amount
    else if (direction === 'right') dx = amount
    else if (direction === 'left') dx = -amount
    else throw new BrowserError('direction must be up, down, left or right')
    const page = this.requirePage()
    await page.mouse.wheel(dx, dy)
    return { ok: true, action: 'scroll', direction, amount }
  }

  // ------------------------------------------------------------- screenshot
  /**
   * Capture the page, optionally boxing the element a goal refers to.
   * Returns the PNG/JPEG bytes as `image` (Buffer); the tool layer turns that
   * into an image content block (or a text fallback).
   */
  async screenshot(opts: {
    path?: string
    fullPage?: boolean
    selector?: string
    goal?: string
    highlight?: boolean
    format?: string
    quality?: number
    signal?: AbortSignal
  }) {
    const imageFormat = opts.format ?? 'jpeg'
    if (imageFormat !== 'jpeg' && imageFormat !== 'png') {
      throw new BrowserError("format must be 'jpeg' or 'png'")
    }
    const page = this.requirePage()

    let highlighted: Record<string, unknown> | null = null
    let picked: Record<string, unknown> | null = null
    let selector = opts.selector
    if (opts.goal || selector) {
      if (opts.goal) {
        picked = (await this.pick(opts.goal, { signal: opts.signal })) as Record<string, unknown>
        if (!picked.ok || picked.abstained) return { ok: false, reason: 'no element selected', pick: picked }
        selector = (picked.selected as { selector: string }).selector
      }
      if ((opts.highlight ?? true) && selector) {
        try {
          highlighted = (await page.evaluate(highlightInPage, { selector })) as Record<string, unknown> | null
        } catch {
          highlighted = null // a missing box must not fail the shot
        }
      }
    }

    const shotOptions: { fullPage: boolean; type: 'jpeg' | 'png'; quality?: number } = {
      fullPage: opts.fullPage ?? false,
      type: imageFormat,
    }
    if (imageFormat === 'jpeg') shotOptions.quality = Math.max(1, Math.min(100, opts.quality ?? 60))

    let data: Buffer
    try {
      data = await page.screenshot(shotOptions)
    } finally {
      if (highlighted) {
        try {
          await page.evaluate(clearHighlightInPage)
        } catch {
          // ignore
        }
      }
    }

    let saved: string | null = null
    if (opts.path) {
      await mkdir(dirname(opts.path), { recursive: true })
      await writeFile(opts.path, data)
      saved = opts.path
    }

    const result: Record<string, unknown> = {
      ok: true,
      action: 'screenshot',
      format: imageFormat,
      bytes: data.length,
      full_page: opts.fullPage ?? false,
      viewport: { w: this.viewport[0], h: this.viewport[1] },
      page: { url: page.url(), title: await page.title() },
      image: data,
    }
    if (saved) result.path = saved
    if (highlighted) result.highlighted = { ...highlighted, selector }
    if (picked) {
      result.goal = opts.goal
      result.probability = picked.probability
    }
    return result
  }

  // ------------------------------------------------------------------ text
  /** Read a bounded slice of text from the page or from one element. */
  async extractText(opts: { selector?: string; goal?: string; limit?: number; signal?: AbortSignal }) {
    const limit = opts.limit ?? 600
    let text: string
    let target: unknown = null
    if (opts.selector || opts.goal) {
      const { locator, picked } = await this.resolve(opts.selector, opts.goal, opts.signal)
      if (locator === null) return { ok: false, reason: 'no element selected', pick: picked }
      text = await locator.innerText()
      target = picked ? picked.selected : { selector: opts.selector }
    } else {
      text = await this.requirePage().locator('body').innerText()
    }
    text = text.split(/\s+/).join(' ').trim()
    return {
      ok: true,
      action: 'extract_text',
      target,
      text: text.slice(0, limit),
      truncated: text.length > limit,
    }
  }

  private requirePage(): Page {
    if (!this.page) throw new BrowserError('browser not started - call browser_open first')
    return this.page
  }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
