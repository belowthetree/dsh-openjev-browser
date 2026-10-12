/**
 * Tool definitions registered into ctx.tools.
 *
 * Names, parameter schemas and descriptions are kept verbatim-compatible with
 * the Python MCP server (openjev/browser/mcp_server.py) minus the
 * `mcp__openjev-browser__` prefix. `browser_status` is new: it reports model
 * detection so agents can self-diagnose "decision model failed" results.
 */

import { BrowserSession } from './session.js'
import { admitImage } from './image.js'
import type { ModelManager, ModelConfig } from './model.js'

type Exec = { signal?: AbortSignal; agent?: unknown }
type Ctx = { get: (name: string) => any }
type ContentBlock = { type: string; text?: string; attachment?: unknown }

export interface PluginDeps {
  ctx: Ctx
  config: ModelConfig & {
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
  models: ModelManager
  log: (level: string, message: string) => void
}

const GENERIC_OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

function textBlocks(value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function errorValue(tool: string, err: unknown): Record<string, unknown> {
  return { ok: false, tool, error: err instanceof Error ? err.message : String(err) }
}

/** Lazily create the browser session; reused across calls until closed. */
export class SessionManager {
  private session: BrowserSession | null = null

  constructor(private readonly deps: PluginDeps) {}

  async ensure(opts: { browser?: string; userDataDir?: string; headed?: boolean } = {}): Promise<BrowserSession> {
    if (!this.session) {
      const cfg = this.deps.config
      this.session = new BrowserSession({
        resolveClient: (signal) => this.deps.models.ensureClient(signal),
        headless: !(opts.headed ?? cfg.headed),
        browser: opts.browser ?? cfg.browser,
        userDataDir: opts.userDataDir ?? cfg.userDataDir,
        maxCandidates: cfg.maxCandidates,
        includeOffscreen: cfg.includeOffscreen,
        maxNameLength: cfg.maxNameLength,
        viewport: cfg.viewport,
        debugDir: cfg.debugDir,
        timeoutMs: cfg.timeoutMs,
      })
      await this.session.start()
      this.deps.log('info', `dsh-openjev-browser: browser started ${JSON.stringify(this.session.browserInfo)}`)
    }
    return this.session
  }

  async close(): Promise<void> {
    if (this.session) {
      await this.session.close()
      this.session = null
    }
  }
}

interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: Record<string, unknown>, value: unknown) => ContentBlock[]
  }
  timeoutMs: number
  execute: (args: any, exec: Exec) => Promise<unknown>
}

export function buildTools(sessions: SessionManager, deps: PluginDeps): ToolDef[] {
  const jsonRender = (_args: Record<string, unknown>, value: unknown) => textBlocks(value)

  return [
    {
      name: 'browser_open',
      description:
        "Open a URL in a headless browser and keep the page for later calls. " +
        "Set browser='chrome' to drive the installed Google Chrome instead of the bundled Chromium.",
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Page to open' },
          browser: {
            type: 'string', enum: ['auto', 'chromium', 'chrome', 'msedge'], default: 'auto',
            description: "'chrome' uses the installed Google Chrome",
          },
          user_data_dir: { type: 'string', description: 'Reuse a browser profile so existing logins carry over' },
          headed: { type: 'boolean', default: false, description: 'Show the browser window' },
        },
        required: ['url'],
      },
      output: { schema: GENERIC_OUTPUT_SCHEMA, render: jsonRender },
      timeoutMs: 90_000,
      execute: async (args, exec) => {
        try {
          const session = await sessions.ensure({
            browser: args.browser,
            userDataDir: args.user_data_dir,
            headed: args.headed,
          })
          const result = await session.goto(args.url)
          return { ...result, browser: session.browserInfo }
        } catch (err) {
          return errorValue('browser_open', err)
        }
      },
    },
    {
      name: 'browser_pick',
      description:
        'Ask the OpenJev decision model which element on the current page accomplishes a ' +
        'natural-language goal. Returns only that element (CSS selector, name, role, position). ' +
        'The page content is not returned, so this costs almost no context.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: "What the agent wants to accomplish, e.g. 'log in'" },
          include_alternatives: { type: 'boolean', default: false, description: 'Also return the two runner-up candidates' },
        },
        required: ['goal'],
      },
      output: { schema: GENERIC_OUTPUT_SCHEMA, render: jsonRender },
      timeoutMs: 180_000,
      execute: async (args, exec) => {
        try {
          const session = await sessions.ensure()
          return await session.pick(args.goal, { includeAlternatives: args.include_alternatives, signal: exec?.signal })
        } catch (err) {
          return errorValue('browser_pick', err)
        }
      },
    },
    {
      name: 'browser_click',
      description: 'Click an element, chosen either by goal or by CSS selector.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'Pick the element by goal, then click it' },
          selector: { type: 'string', description: 'Click this selector directly' },
        },
      },
      output: { schema: GENERIC_OUTPUT_SCHEMA, render: jsonRender },
      timeoutMs: 180_000,
      execute: async (args, exec) => {
        try {
          const session = await sessions.ensure()
          return await session.click({ selector: args.selector, goal: args.goal, signal: exec?.signal })
        } catch (err) {
          return errorValue('browser_click', err)
        }
      },
    },
    {
      name: 'browser_type',
      description: 'Type text into an element chosen by goal or selector.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          goal: { type: 'string' },
          selector: { type: 'string' },
          submit: { type: 'boolean', default: false, description: 'Press Enter afterwards' },
        },
        required: ['text'],
      },
      output: { schema: GENERIC_OUTPUT_SCHEMA, render: jsonRender },
      timeoutMs: 180_000,
      execute: async (args, exec) => {
        try {
          const session = await sessions.ensure()
          return await session.typeText(args.text, {
            selector: args.selector,
            goal: args.goal,
            submit: args.submit,
            signal: exec?.signal,
          })
        } catch (err) {
          return errorValue('browser_type', err)
        }
      },
    },
    {
      name: 'browser_text',
      description: 'Read a bounded slice of text from the page or one element.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string' },
          selector: { type: 'string' },
          limit: { type: 'integer', default: 600 },
        },
      },
      output: { schema: GENERIC_OUTPUT_SCHEMA, render: jsonRender },
      timeoutMs: 180_000,
      execute: async (args, exec) => {
        try {
          const session = await sessions.ensure()
          return await session.extractText({
            selector: args.selector,
            goal: args.goal,
            limit: args.limit ?? 600,
            signal: exec?.signal,
          })
        } catch (err) {
          return errorValue('browser_text', err)
        }
      },
    },
    {
      name: 'browser_scroll',
      description: 'Scroll the page, or scroll an element into view.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], default: 'down' },
          amount: { type: 'integer', default: 800 },
          goal: { type: 'string' },
          selector: { type: 'string' },
        },
      },
      output: { schema: GENERIC_OUTPUT_SCHEMA, render: jsonRender },
      timeoutMs: 180_000,
      execute: async (args, exec) => {
        try {
          const session = await sessions.ensure()
          return await session.scroll({
            direction: args.direction,
            amount: args.amount,
            selector: args.selector,
            goal: args.goal,
            signal: exec?.signal,
          })
        } catch (err) {
          return errorValue('browser_scroll', err)
        }
      },
    },
    {
      name: 'browser_screenshot',
      description:
        'Capture the current page as an image and return it so the agent can look at the page. ' +
        'Give a goal to box the element OpenJev selects - the quickest way to confirm a pick was right. ' +
        'Note a screenshot costs far more context than browser_pick does, so prefer picking when you only need to act.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'Pick this element and draw a box around it' },
          selector: { type: 'string', description: 'Box this selector instead' },
          full_page: { type: 'boolean', default: false },
          format: { type: 'string', enum: ['jpeg', 'png'], default: 'jpeg' },
          quality: { type: 'integer', default: 60, description: 'JPEG quality, 1-100' },
          path: { type: 'string', description: 'Also save the image to this path' },
        },
      },
      output: { schema: GENERIC_OUTPUT_SCHEMA, render: screenshotRender },
      timeoutMs: 180_000,
      execute: async (args, exec) => {
        try {
          const session = await sessions.ensure()
          const result = (await session.screenshot({
            path: args.path,
            fullPage: args.full_page,
            selector: args.selector,
            goal: args.goal,
            format: args.format,
            quality: args.quality,
            signal: exec?.signal,
          })) as Record<string, unknown>
          if (!result.ok || !(result.image instanceof Buffer)) return result

          const mediaType = result.format === 'png' ? 'image/png' : 'image/jpeg'
          const admission = await admitImage(deps.ctx, exec, result.image as Buffer, mediaType)
          const { image, ...rest } = result
          if (admission.ok) {
            return { ...rest, attachment: admission.attachment }
          }
          return {
            ...rest,
            image_unavailable: `[image unavailable: ${admission.reason}]` +
              (args.path ? '' : ' - pass "path" to save the file instead'),
          }
        } catch (err) {
          return errorValue('browser_screenshot', err)
        }
      },
    },
    {
      name: 'browser_status',
      description:
        'Report the OpenJev model/service detection state and setup guidance. ' +
        'Use this to diagnose "decision model failed" results from goal-driven tools.',
      parameters: { type: 'object', properties: {} },
      output: { schema: GENERIC_OUTPUT_SCHEMA, render: jsonRender },
      timeoutMs: 30_000,
      execute: async () => {
        try {
          return await deps.models.status()
        } catch (err) {
          return errorValue('browser_status', err)
        }
      },
    },
    {
      name: 'browser_close',
      description: 'Close the browser session and free its resources.',
      parameters: { type: 'object', properties: {} },
      output: { schema: GENERIC_OUTPUT_SCHEMA, render: jsonRender },
      timeoutMs: 15_000,
      execute: async () => {
        try {
          await sessions.close()
          return { ok: true, closed: true }
        } catch (err) {
          return errorValue('browser_close', err)
        }
      },
    },
  ]
}

function screenshotRender(_args: Record<string, unknown>, value: unknown): ContentBlock[] {
  const v = (value ?? {}) as Record<string, unknown>
  const { attachment, ...rest } = v
  const blocks: ContentBlock[] = [{ type: 'text', text: JSON.stringify(rest) }]
  if (attachment) blocks.push({ type: 'image', attachment })
  return blocks
}
