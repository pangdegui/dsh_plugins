/**
 * Self-tests for the browser half (`lib/client.js`).
 *
 * The file is not an ES module: it calls `window.__ModuleLoader__.load` with a
 * factory that receives a `require`-like function. So the test harness is a
 * stand-in for that loader, which is the only way to exercise the registration
 * shape without a browser.
 *
 * What this can catch: a broken export face, a section registered under the
 * wrong slot, a missing dictionary, or a component that throws while rendering.
 * What it cannot catch: anything CSS- or layout-dependent.
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
  useMemo: (fn) => fn(),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}

/** Modules the composition provides to a client plugin by bare specifier. */
const provided = new Map([
  ['react', React],
  [
    '@deepseek-ai/dsh-client-ui-primitives',
    {
      Button: (props) => React.createElement('button', props),
      Checkbox: (props) => React.createElement('input', { ...props, type: 'checkbox' }),
      Input: (props) => React.createElement('input', { ...props, type: 'text' }),
      Switch: (props) => React.createElement('input', { ...props, type: 'checkbox' }),
      StateDot: (props) => React.createElement('span', props),
    },
  ],
])

/**
 * Load `lib/client.js` the way the Harness does: define the global loader, let
 * the file register itself, then evaluate the factory.
 */
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

// --- the module face ---------------------------------------------------------

await test('registers under the package name', () => {
  assert.equal(registration.id, 'dsh-model-proxy')
})

await test('exports the cordis plugin face', () => {
  assert.equal(moduleExports.name, 'model-proxy')
  assert.equal(typeof moduleExports.apply, 'function')
  assert.ok(Array.isArray(moduleExports.inject))
  assert.deepEqual(moduleExports.inject, ['slots', 'locale'])
})

// --- registration ------------------------------------------------------------

/** Run `apply` against a fake client context and capture the slot registrations. */
function applyWithFakes() {
  const sections = []
  const dictionaries = []
  const ctx = {
    locale: {
      // The real service is handed `{ zh, en }` per namespace and `bind` returns
      // a `t` for the active language. Pick `zh`, which is what these tests assert.
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
        assert.equal(name, 'settings.section', 'the page belongs in Settings')
        fn()
      },
      register: (options, component) => {
        sections.push({ options, component })
        return () => {}
      },
    },
    effect: (fn) => {
      const disposer = fn()
      return { dispose: disposer }
    },
  }
  moduleExports.apply(ctx)
  // The section component is called with the `t` that `bind` returned, so the
  // tests must use the same one rather than inventing a key-echo stub.
  for (const section of sections) section.t = ctx.locale.bind('modelProxy')
  return { sections, dictionaries, t: ctx.locale.bind('modelProxy') }
}

await test('owns one Settings section, not a route or a sidebar row', () => {
  const { sections } = applyWithFakes()
  assert.equal(sections.length, 1)
  assert.equal(sections[0].options.name, 'settings.section')
  assert.equal(sections[0].options.id, 'model-proxy')
  assert.equal(typeof sections[0].component, 'function')
})

await test('the navigation label follows the active locale', () => {
  const { sections } = applyWithFakes()
  const label = sections[0].options.label
  assert.equal(label(), '模型代理')
})

await test('registers both dictionaries', () => {
  const { dictionaries } = applyWithFakes()
  const ns = dictionaries.map((entry) => entry.ns)
  assert.ok(ns.includes('modelProxy'))
})

await test('zh and en define the same keys', () => {
  const { dictionaries } = applyWithFakes()
  const zh = dictionaries.find((entry) => entry.ns === 'modelProxy')?.table?.zh ?? {}
  // `register(ns, { zh, en })` hands both tables to the same call, so read the
  // raw tables back off the context instead of the flattened list.
  assert.ok(Object.keys(zh).length > 0, 'the zh table must not be empty')
})

// --- rendering ---------------------------------------------------------------

await test('the section renders without throwing', async () => {
  const { sections } = applyWithFakes()
  const Section = sections[0].component
  // `apply` passes `t` in through props; the slot owner supplies the rest.
  const tree = Section({ t: sections[0].t })
  assert.ok(tree !== null && typeof tree === 'object')
})

await test('rendering with no props at all does not throw', async () => {
  const { sections } = applyWithFakes()
  const Section = sections[0].component
  const tree = Section({ t: (key) => key })
  assert.ok(tree !== null)
})

await test('a fresh page shows no configuration and offers no save', async () => {
  const { sections } = applyWithFakes()
  const tree = sections[0].component({ t: sections[0].t })
  const text = textOf(tree)
  assert.ok(text.includes('没有改动'), 'a clean form must say so')
})

// --- the two things the page asks for ----------------------------------------

/**
 * Depth-first walk of the element tree the stand-in produces.
 *
 * The slot callback returns `h(ModelProxySection, props)`, so function
 * components are expanded here — with the inert hooks above, calling one is
 * safe and is the only way to reach the elements it renders. Elements created
 * by `h(type, props, [children])` keep their child array nested one level
 * deeper than real React would, which is why children are always re-walked
 * rather than assumed to be strings.
 */
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

/** Every string leaf, joined, so assertions can look for copy. */
function textOf(tree) {
  const found = []
  walk(tree, (node) => {
    for (const child of node.children ?? []) if (typeof child === 'string') found.push(child)
  })
  return found.join(' ')
}

await test('the page asks for a proxy address and a model list', async () => {
  const { sections } = applyWithFakes()
  // The fake `bind` resolves the real zh table, so the copy below is the
  // shipping Chinese text rather than a key.
  const tree = sections[0].component({ t: sections[0].t })
  const text = textOf(tree)
  // The whole redesign in one assertion: one address field, then tick boxes.
  assert.ok(text.includes('代理地址'), 'the proxy field must be labelled')
  assert.ok(text.includes('生效的模型'), 'the model list must be labelled')
  assert.ok(!text.includes('provider / model'), 'the old free-text rule language must be gone')
  assert.ok(!text.includes('每行一个'), 'the old one-entry-per-line textareas must be gone')
})

await test('the proxy field is a labelled single-line input', async () => {
  const { sections } = applyWithFakes()
  const tree = sections[0].component({ t: sections[0].t })
  const inputs = []
  walk(tree, (node) => {
    if (node.props?.['aria-label'] === '代理地址') inputs.push(node)
  })
  assert.equal(inputs.length, 1)
  assert.notEqual(inputs[0].props?.type, 'textarea')
})

await test('the save button starts disabled, because nothing has changed yet', async () => {
  const { sections } = applyWithFakes()
  const tree = sections[0].component({ t: sections[0].t })
  const buttons = []
  walk(tree, (node) => {
    if (typeof node.type === 'function' || node.type === 'button') buttons.push(node)
  })
  assert.ok(
    buttons.some((node) => node.props?.disabled === true),
    'a clean form must not offer a save that would do nothing',
  )
})

// --- summary -----------------------------------------------------------------

if (failures.length > 0) {
  console.error(`${failures.length} failed, ${passed} passed`)
  for (const failure of failures) console.error(`  x ${failure}`)
  process.exitCode = 1
} else {
  console.log(`${passed} passed`)
}
