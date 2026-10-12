/**
 * Smoke test: load the built plugin with a mock cordis context and exercise
 * the model-free tool paths (open/text/status/close). Goal-driven picks need
 * a real OpenJev service and are intentionally not covered here.
 *
 * Run: node scripts/smoke.mjs   (after `pnpm build`)
 */

import assert from 'node:assert/strict'

const { apply, name, inject } = await import('../lib/index.js')

assert.equal(name, 'dsh-openjev-browser')
assert.deepEqual(inject, ['tools'])

const registered = new Map()
const ctx = {
  get(service) {
    if (service === 'tools') {
      return {
        register(def) {
          assert.ok(def.name, 'tool needs a name')
          assert.ok(def.output && typeof def.output.render === 'function', `${def.name}: output.render required`)
          assert.ok(def.output.schema, `${def.name}: output.schema required`)
          registered.set(def.name, def)
        },
      }
    }
    return undefined // attachments / llm not provided in the smoke context
  },
  logger: () => (msg) => console.log(`  [plugin] ${msg}`),
  on() {},
}

apply(ctx, { openjevUrl: 'http://127.0.0.1:9' }) // unreachable on purpose

const expected = [
  'browser_open', 'browser_pick', 'browser_click', 'browser_type',
  'browser_text', 'browser_scroll', 'browser_screenshot', 'browser_status', 'browser_close',
]
assert.deepEqual([...registered.keys()].sort(), expected.sort())
console.log(`registered: ${expected.join(', ')}`)

const exec = {}

// browser_status: no service at 127.0.0.1:9, so ready=false with guidance.
const status = await registered.get('browser_status').execute({}, exec)
assert.equal(status.ready, false)
assert.ok(Array.isArray(status.setup) && status.setup.length > 0, 'status should include setup guidance')
console.log('browser_status ok (fail-soft guidance present)')

// browser_open + browser_text need no model (selector-free text path).
const opened = await registered.get('browser_open').execute({ url: 'about:blank' }, exec)
assert.ok(opened.url, 'open should report the url')
console.log(`browser_open ok via ${opened.browser?.channel ?? 'unknown browser'}`)

const text = await registered.get('browser_text').execute({ limit: 200 }, exec)
assert.equal(text.ok, true)
console.log('browser_text ok')

// render() must return content blocks.
const blocks = registered.get('browser_text').output.render({}, text)
assert.ok(Array.isArray(blocks) && blocks[0].type === 'text')
console.log('output.render ok')

const closed = await registered.get('browser_close').execute({}, exec)
assert.deepEqual(closed, { ok: true, closed: true })
console.log('browser_close ok')

console.log('\nSMOKE PASS')
process.exit(0)
