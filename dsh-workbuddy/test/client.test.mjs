/**
 * Self-tests for the browser half (`lib/client.js`).
 *
 * The file is not an ES module: it registers a lazy factory with
 * `window.__ModuleLoader__.load`. This harness stands in for that loader, so it
 * can check the export face, the slot registration and the dictionaries without
 * a browser. Rendering is checked with an inert React stand-in; everything CSS-
 * or layout-dependent remains unverified here.
 *
 * Run with: node test/client.test.mjs
 */
import assert from 'node:assert/strict'

const failures = []
let passed = 0

async function test(label, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Minimal React stand-in: elements are plain objects, hooks are inert. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useEffect: () => {},
  useCallback: (fn) => fn,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}

/**
 * Only `react` is provided on purpose. Current client-plugin guidance keeps a
 * bundle off the Harness Client packages, so requiring one must fail here.
 */
const provided = new Map([['react', React]])

/** Load `lib/client.js` the way the Harness does, then evaluate the factory. */
async function loadClient() {
  const registrations = []
  globalThis.window = {
    __ModuleLoader__: {
      load: (registration) => {
        registrations.push(registration)
      },
    },
  }
  await import('../lib/client.js')
  assert.equal(registrations.length, 1, 'the file must register exactly one module')
  const registration = registrations[0]
  const exports = registration.factory((specifier) => {
    if (!provided.has(specifier)) throw new Error(`unexpected require("${specifier}")`)
    return provided.get(specifier)
  })
  return { registration, exports }
}

const { registration, exports: moduleExports } = await loadClient()

await test('registers under the package name', () => {
  assert.equal(registration.id, 'dsh-workbuddy')
})

await test('exports the cordis plugin face', () => {
  assert.equal(moduleExports.name, 'workbuddy')
  assert.equal(typeof moduleExports.apply, 'function')
  assert.deepEqual(moduleExports.inject, ['slots', 'locale'])
})

function applyWithFakes() {
  const sections = []
  const dictionaries = []
  const disposers = []
  const ctx = {
    locale: {
      bind: (ns) => (key, params) => {
        const entry = dictionaries.find((candidate) => candidate.ns === ns)
        const table = entry?.table?.zh ?? {}
        const text = table[key] ?? key
        if (params === undefined) return text
        return text.replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined ? whole : String(params[name])))
      },
      register: (ns, table) => {
        dictionaries.push({ ns, table })
        return () => {}
      },
    },
    slots: {
      inject: (name, fn) => {
        assert.equal(name, 'settings.section', 'the account page belongs in Settings')
        fn()
      },
      register: (options, component) => {
        sections.push({ options, component })
        return () => {}
      },
    },
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return { dispose: disposer }
    },
  }
  moduleExports.apply(ctx)
  for (const section of sections) section.t = ctx.locale.bind('workbuddy')
  return { sections, dictionaries, disposers, t: ctx.locale.bind('workbuddy') }
}

await test('owns one Settings section', () => {
  const { sections } = applyWithFakes()
  assert.equal(sections.length, 1)
  assert.equal(sections[0].options.name, 'settings.section')
  assert.equal(sections[0].options.id, 'workbuddy')
  assert.equal(typeof sections[0].component, 'function')
})

await test('the navigation label follows the active locale', () => {
  const { sections } = applyWithFakes()
  assert.equal(sections[0].options.label(), 'WorkBuddy')
})

await test('zh and en define the same keys', () => {
  const { dictionaries } = applyWithFakes()
  const table = dictionaries.find((entry) => entry.ns === 'workbuddy')?.table ?? {}
  const zh = Object.keys(table.zh ?? {}).sort()
  const en = Object.keys(table.en ?? {}).sort()
  assert.ok(zh.length > 0, 'the zh table must not be empty')
  assert.deepEqual(en, zh, 'a key missing from one language falls back to the raw key')
  for (const key of ['login', 'logout', 'loginTitle', 'loginWaiting', 'qrAlt', 'loadFailed', 'guardMode', 'guardModePrepend', 'guardSave']) {
    assert.ok(zh.includes(key), `dictionary must carry ${key}`)
  }
})

await test('owns one stylesheet, removed by its disposer', () => {
  const inserted = []
  const removed = []
  globalThis.document = {
    head: { appendChild: (tag) => inserted.push(tag) },
    querySelectorAll: () => [],
    createElement: () => {
      const tag = {
        dataset: {},
        textContent: '',
        remove: () => {
          removed.push(tag)
        },
      }
      return tag
    },
  }
  try {
    const { disposers } = applyWithFakes()
    assert.equal(inserted.length, 1, 'one plugin-owned <style> is enough')
    const css = inserted[0].textContent
    assert.ok(css.includes('.wb_'), 'every rule stays under the plugin prefix')
    assert.ok(css.includes('--dsw-alias-border-l1'), 'borders use the current token')
    assert.ok(css.includes('.wb_select'), 'the guard select is styled')
    assert.ok(css.includes('.wb_input'), 'the prefix field is styled')
    assert.ok(!css.includes('--dsw-alias-line-'), 'removed line tokens must not come back')
    for (const dispose of disposers) dispose()
    assert.equal(removed.length, 1, 'unloading removes the sheet')
  } finally {
    delete globalThis.document
  }
})

// --- rendering ---------------------------------------------------------------

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  const rendered =
    typeof node.type === 'function' ? node.type({ ...(node.props ?? {}), children: node.children }) : node
  if (rendered === null || rendered === undefined) return
  if (Array.isArray(rendered)) {
    for (const child of rendered) walk(child, visit)
    return
  }
  visit(rendered)
  for (const child of rendered.children ?? []) {
    if (typeof child === 'string') visit({ type: '#text', props: {}, children: [child] })
    else walk(child, visit)
  }
}

function textOf(tree) {
  const found = []
  walk(tree, (node) => {
    for (const child of node.children ?? []) if (typeof child === 'string') found.push(child)
  })
  return found.join(' ')
}

await test('the page renders without throwing before any fetch resolves', () => {
  const { sections } = applyWithFakes()
  const tree = sections[0].component({ t: sections[0].t })
  assert.ok(tree !== null && typeof tree === 'object')
  const text = textOf(tree)
  assert.ok(text.includes('WorkBuddy 模型接入'))
  assert.ok(text.includes('未登录'), 'the initial state is signed out')
})

await test('the login dialog is closed until the user asks for it', () => {
  const { sections } = applyWithFakes()
  const tree = sections[0].component({ t: sections[0].t })
  const dialogs = []
  walk(tree, (node) => {
    if (node.props?.role === 'dialog') dialogs.push(node)
  })
  assert.equal(dialogs.length, 0, 'no dialog before the login button is pressed')
})

await test('the page exposes a login action and the model route summary', () => {
  const { sections } = applyWithFakes()
  const text = textOf(sections[0].component({ t: sections[0].t }))
  assert.ok(text.includes('登录 / 重新登录'))
  assert.ok(text.includes('模型路由'))
  assert.ok(text.includes('Provider'))
})

await test('the page exposes the prompt guard with both rewrite modes', () => {
  const { sections } = applyWithFakes()
  const text = textOf(sections[0].component({ t: sections[0].t }))
  assert.ok(text.includes('提示词守卫'), 'the guard has its own section')
  assert.ok(text.includes('在开头增加一句'), 'prepend is offered')
  assert.ok(text.includes('删除身份行'), 'strip is offered')
  assert.ok(text.includes('关闭'), 'the guard can be turned off')
  assert.ok(text.includes('保存'), 'the guard is saved explicitly')
})

// --- summary -----------------------------------------------------------------

if (failures.length > 0) {
  console.error(`${failures.length} failed, ${passed} passed`)
  for (const failure of failures) console.error(`  x ${failure}`)
  process.exitCode = 1
} else {
  console.log(`${passed} passed`)
}
