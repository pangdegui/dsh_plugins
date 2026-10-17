/**
 * Materialize the browser half outside the app and render both registered
 * components once, with React and the Host stubbed.
 *
 * Catches the class of defect that shows up as a blank panel: a module that
 * throws while materializing, an `apply` that registers the wrong slot id, or a
 * component that throws on its first render.
 *
 *   node test/client-render.mjs
 */

import assert from 'node:assert/strict'

const calls = []
const React = {
  createElement(type, props, ...children) {
    calls.push({ type, props: props ?? {}, children })
    if (type === undefined || type === null) throw new Error('createElement received an undefined type')
    return { type, props: props ?? {}, children }
  },
  useState(initial) { return [initial, () => {}] },
  useEffect() { /* effects do not run in this harness */ },
  useCallback(fn) { return fn },
}

let registration = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) { registration = entry },
  },
}

await import('../lib/client.js')

assert.ok(registration !== null, 'the module registered a factory')
assert.equal(registration.id, 'dsh-web-access', 'factory id equals the package name')

const mod = registration.factory((name) => {
  if (name === 'react') return React
  if (name === '@deepseek-ai/dsh-client-ui-primitives') throw new Error('primitives unavailable in this harness')
  throw new Error(`unexpected require: ${name}`)
})

assert.equal(typeof mod.apply, 'function', 'factory exports apply')
assert.deepEqual(mod.inject, ['slots', 'locale'], 'factory exports its service inject list')

const registered = []
const ctx = {
  effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
  locale: { bind: () => (key) => key, register: () => () => {} },
  slots: {
    inject(name, callback) { assert.equal(typeof name, 'string'); callback() },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
  },
}

mod.apply(ctx)

const bySlot = new Map(registered.map((entry) => [entry.options.name, entry]))
assert.ok(bySlot.has('sidebar.panellist'), 'registers the sidebar button')
assert.ok(bySlot.has('main'), 'registers the central panel')

const button = bySlot.get('sidebar.panellist')
assert.equal(button.options.id, 'web-access', 'sidebar id is web-access')
assert.equal(button.options.order, 5, 'sidebar order places it between plugins (0) and schedules (10)')

const panel = bySlot.get('main')
assert.equal(panel.options.key, 'web-access', 'main key matches the sidebar id')

// Render both components once, as the renderer would.
const icon = button.component({ size: 16, active: false })
assert.equal(icon.type, 'svg', 'the sidebar occupant renders an svg')
assert.ok(Array.isArray(icon.children) && icon.children.length > 0, 'the icon has artwork')

const tree = panel.component({ t: undefined })
assert.equal(tree.type, 'section', 'the panel renders its root section')

// Walk the tree: every element must have a real type, and the copy must appear.
let nodes = 0
const texts = []
const walk = (node) => {
  if (node === null || node === undefined || node === false) return
  if (Array.isArray(node)) { for (const child of node) walk(child); return }
  if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return }
  if (typeof node !== 'object') return
  nodes += 1
  assert.ok(node.type !== undefined && node.type !== null, 'every element has a type')
  for (const child of node.children ?? []) walk(child)
  walk(node.props?.children)
}
walk(tree)

assert.ok(nodes > 20, `the panel renders a populated tree (got ${nodes} elements)`)
// Without a `t` seat the component falls back to its own dictionary, so the
// visible heading is copy rather than the key.
assert.ok(
  texts.some((text) => text.includes('Web access') || text.includes('Web 访问')),
  'the heading copy is rendered (dictionary fallback when no t seat is injected)',
)
assert.ok(texts.length > 10, `the panel renders visible copy (got ${texts.length} text nodes)`)

console.log('dsh-web-access client checks')
console.log(`  registrations: ${registered.map((entry) => entry.options.name).join(', ')}`)
console.log(`  elements rendered: ${nodes}`)
console.log('  all checks passed')
