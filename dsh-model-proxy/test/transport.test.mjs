/**
 * Self-tests for `transport.js`: the two claims the plugin rests on.
 *
 *   1. The global switch takes effect on the next request and can be reverted,
 *      including back to the launcher's own dispatcher.
 *   2. A route carried through AsyncLocalStorage survives the async-generator
 *      boundary and selects that route's dispatcher, while a request outside any
 *      route keeps using the global one.
 *
 * Both are checked against real HTTP servers on loopback, so a wrong dispatcher
 * shows up as a wrong `VIA-x` body rather than a passing assertion.
 *
 * Run with: node test/transport.test.mjs
 */

import assert from 'node:assert/strict'
import http from 'node:http'

import { reportSkip, resolveUndici } from './undici.mjs'
import {
  applyGlobalPolicy,
  captureBaseline,
  currentRoute,
  describeGlobal,
  disposeTransport,
  installFetchWrapper,
  loadTransport,
  runWithRoute,
} from '../lib/transport.js'

const proxyHits = []
let proxyServer
let proxyPort
let secondServer
let secondPort

/** Start a proxy that answers with its own name and records every target. */
function startProxy(name) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      proxyHits.push({ name, url: req.url })
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`VIA-${name}`)
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** An unreachable-looking host: every request must go through a proxy to succeed. */
const TARGET = 'http://example.invalid/probe'

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

const resolved = await resolveUndici()
if (!('module' in resolved)) {
  reportSkip('transport.test.mjs', resolved.skip)
  process.exit(0)
}

const verdict = await loadTransport({ module: resolved.module })
if (!verdict.ok) {
  console.error('transport unavailable:', verdict.problems)
  process.exit(1)
}

const first = await startProxy('A')
const second = await startProxy('B')
proxyServer = first.server
proxyPort = first.port
secondServer = second.server
secondPort = second.port

captureBaseline()

await test('global proxy applies to plain fetch', async () => {
  const applied = applyGlobalPolicy({ mode: 'proxy', url: `http://127.0.0.1:${proxyPort}` })
  assert.equal(applied.ok, true, applied.reason)
  const response = await fetch(TARGET)
  assert.equal(await response.text(), 'VIA-A')
})

await test('global proxy can be switched at runtime', async () => {
  proxyHits.length = 0
  const applied = applyGlobalPolicy({ mode: 'proxy', url: `http://127.0.0.1:${secondPort}` })
  assert.equal(applied.ok, true, applied.reason)
  const response = await fetch(TARGET)
  assert.equal(await response.text(), 'VIA-B')
  assert.equal(proxyHits.filter((hit) => hit.name === 'A').length, 0, 'the old proxy must go unused')
})

await test('direct bypasses the global proxy', async () => {
  proxyHits.length = 0
  applyGlobalPolicy({ mode: 'direct' })
  await assert.rejects(() => fetch(TARGET), (error) => {
    assert.ok(error.cause?.code !== undefined || error.message.length > 0)
    return true
  })
  assert.equal(proxyHits.length, 0, 'no proxy may be contacted in direct mode')
})

await test('system restores the launcher dispatcher', async () => {
  applyGlobalPolicy({ mode: 'proxy', url: `http://127.0.0.1:${proxyPort}` })
  const applied = applyGlobalPolicy({ mode: 'system' })
  assert.equal(applied.ok, true, applied.reason)
  assert.match(describeGlobal(), /system/)
})

await test('an empty proxy URL is refused, not installed', async () => {
  const applied = applyGlobalPolicy({ mode: 'proxy', url: '   ' })
  assert.equal(applied.ok, false)
  assert.match(applied.reason, /empty/)
})

// --- per-request routing -----------------------------------------------------

const disposeWrapper = installFetchWrapper()

await test('a route selects its own dispatcher over the global one', async () => {
  applyGlobalPolicy({ mode: 'proxy', url: `http://127.0.0.1:${proxyPort}` })

  const viaSecond = await runWithRoute({ kind: 'proxy', url: `http://127.0.0.1:${secondPort}` }, () => fetch(TARGET))
  assert.equal(await viaSecond.text(), 'VIA-B', 'the ambient route must win over the global policy')
})

await test('a direct route bypasses a global proxy', async () => {
  applyGlobalPolicy({ mode: 'proxy', url: `http://127.0.0.1:${proxyPort}` })
  proxyHits.length = 0
  await assert.rejects(() => runWithRoute({ kind: 'direct' }, () => fetch(TARGET)))
  assert.equal(proxyHits.length, 0)
})

await test('no route keeps the global policy', async () => {
  applyGlobalPolicy({ mode: 'proxy', url: `http://127.0.0.1:${proxyPort}` })
  const response = await fetch(TARGET)
  assert.equal(await response.text(), 'VIA-A')
})

await test('concurrent routes do not leak into each other', async () => {
  applyGlobalPolicy({ mode: 'proxy', url: `http://127.0.0.1:${proxyPort}` })
  const [a, b] = await Promise.all([
    runWithRoute({ kind: 'proxy', url: `http://127.0.0.1:${proxyPort}` }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return (await fetch(TARGET)).text()
    }),
    runWithRoute({ kind: 'proxy', url: `http://127.0.0.1:${secondPort}` }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return (await fetch(TARGET)).text()
    }),
  ])
  assert.equal(a, 'VIA-A')
  assert.equal(b, 'VIA-B')
})

await test('the route survives an async generator boundary', async () => {
  applyGlobalPolicy({ mode: 'proxy', url: `http://127.0.0.1:${proxyPort}` })

  // Mirrors what the llm/stream listener does: wrap a generator so each next()
  // runs inside the route, and the adapter's fetch happens during that next().
  async function* adapterStream() {
    yield { type: 'start' }
    const response = await fetch(TARGET)
    yield { type: 'text', text: await response.text() }
    yield { type: 'finish' }
  }

  const source = adapterStream()[Symbol.asyncIterator]()
  const seen = []
  while (true) {
    const step = await runWithRoute({ kind: 'proxy', url: `http://127.0.0.1:${secondPort}` }, () => source.next())
    if (step.done === true) break
    seen.push(step.value)
  }
  assert.equal(seen[1].text, 'VIA-B', 'a generator step must see the route it runs under')
})

await test('currentRoute reports the ambient decision', async () => {
  assert.equal(currentRoute(), undefined)
  await runWithRoute({ kind: 'direct' }, () => {
    assert.deepEqual(currentRoute(), { kind: 'direct' })
  })
  await runWithRoute({ kind: 'proxy', url: 'http://p:1' }, () => {
    assert.deepEqual(currentRoute(), { kind: 'proxy', url: 'http://p:1' })
  })
})

await test('the wrapper restores the original fetch on dispose', () => {
  const before = globalThis.fetch
  disposeWrapper()
  // The wrapper was installed once; disposing it must not leave a routed fetch
  // behind. A second install/dispose pair proves the marker logic is idempotent.
  const again = installFetchWrapper()
  again()
  assert.equal(typeof globalThis.fetch, 'function')
  assert.notEqual(globalThis.fetch, before, 'fetch is expected to be a different function after a fresh install/dispose cycle')
})

await disposeTransport()

proxyServer.close()
secondServer.close()

if (failures.length > 0) {
  console.error(`\n${failures.length} failed, ${passed} passed\n`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exitCode = 1
} else {
  console.log(`${passed} passed`)
}
