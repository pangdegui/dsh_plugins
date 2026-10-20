/**
 * Self-tests for `transport.js`: the one claim the plugin rests on.
 *
 * **Scope.** The plugin must move model traffic and nothing else. So the tests
 * prove two things about the fetch wrapper:
 *
 *   1. A request with no ambient route is passed through untouched — it never
 *      consults a proxy this plugin owns, so unrelated traffic (web fetches,
 *      plugin installs) keeps its original network path.
 *   2. A request inside an ambient route uses that route's dispatcher, and the
 *      route survives the async-generator boundary the `llm/stream` wrapper
 *      relies on, without leaking between concurrent calls.
 *
 * Both are checked against real HTTP servers on loopback: a wrong dispatcher
 * shows up as a wrong `VIA-x` body rather than a passing assertion.
 *
 * Run with: node test/transport.test.mjs
 */

import assert from 'node:assert/strict'
import http from 'node:http'

import { reportSkip, resolveUndici } from './undici.mjs'
import {
  currentRoute,
  describeActive,
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

/** An unroutable host: the request can only succeed if a proxy answers it. */
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

// The wrapper is installed once, exactly as `apply()` does it.
const uninstall = installFetchWrapper()

// --- scope: unrelated traffic is untouched -----------------------------------

await test('a request with no route never touches a proxy this plugin owns', async () => {
  proxyHits.length = 0
  // With no ambient route the wrapper delegates to the original fetch, so this
  // fails to resolve DNS instead of being answered by proxy A.
  await assert.rejects(() => fetch(TARGET))
  assert.equal(proxyHits.length, 0, 'no plugin-owned proxy may be contacted')
})

await test('the route is undefined outside runWithRoute', () => {
  assert.equal(currentRoute(), undefined)
})

await test('an unrouted decision does not create a route', () => {
  let seen = 'not-run'
  runWithRoute({ kind: 'unrouted', from: 'no-rule' }, () => {
    seen = currentRoute()
  })
  assert.equal(seen, undefined)
})

// --- a routed model call uses its proxy --------------------------------------

await test('a routed request goes through the named proxy', async () => {
  proxyHits.length = 0
  const response = await runWithRoute({ kind: 'proxy', url: `http://127.0.0.1:${proxyPort}` }, () => fetch(TARGET))
  assert.equal(await response.text(), 'VIA-A')
  assert.equal(proxyHits.length, 1)
})

await test('two models can use two different proxies at once', async () => {
  proxyHits.length = 0
  const [a, b] = await Promise.all([
    runWithRoute({ kind: 'proxy', url: `http://127.0.0.1:${proxyPort}` }, () => fetch(TARGET).then((r) => r.text())),
    runWithRoute({ kind: 'proxy', url: `http://127.0.0.1:${secondPort}` }, () => fetch(TARGET).then((r) => r.text())),
  ])
  assert.equal(a, 'VIA-A')
  assert.equal(b, 'VIA-B')
})

await test('a concurrent unrouted call is still not proxied', async () => {
  proxyHits.length = 0
  const [routed, unrouted] = await Promise.allSettled([
    runWithRoute({ kind: 'proxy', url: `http://127.0.0.1:${proxyPort}` }, () => fetch(TARGET).then((r) => r.text())),
    fetch(TARGET),
  ])
  assert.equal(routed.status, 'fulfilled')
  assert.equal(routed.value, 'VIA-A')
  assert.equal(unrouted.status, 'rejected', 'the unrouted call must not borrow the other route')
})

await test('direct bypasses even an ambient proxy', async () => {
  proxyHits.length = 0
  await assert.rejects(() =>
    runWithRoute({ kind: 'direct', from: 'rule#1' }, () => fetch(TARGET)),
  )
  assert.equal(proxyHits.length, 0, 'direct must not contact a proxy')
})

// --- the async-generator boundary -------------------------------------------

await test('a route survives an async-generator step', async () => {
  proxyHits.length = 0
  // This is the exact shape the `llm/stream` wrapper uses: the adapter's fetch
  // happens while `next()` runs, which is outside the synchronous call stack
  // that entered runWithRoute.
  async function* stream() {
    const response = await fetch(TARGET)
    yield await response.text()
  }

  const values = []
  for await (const value of runWithRoute({ kind: 'proxy', url: `http://127.0.0.1:${proxyPort}` }, () => {
    return (async function* () {
      const iterator = stream()
      for (;;) {
        const step = await runWithRoute({ kind: 'proxy', url: `http://127.0.0.1:${proxyPort}` }, () => iterator.next())
        if (step.done === true) return
        yield step.value
      }
    })()
  })) {
    values.push(value)
  }

  assert.deepEqual(values, ['VIA-A'])
})

await test('the route does not leak after the generator finishes', async () => {
  proxyHits.length = 0
  await assert.rejects(() => fetch(TARGET))
  assert.equal(proxyHits.length, 0)
})

// --- teardown ----------------------------------------------------------------

await test('describeActive reports the proxies it opened', () => {
  assert.match(describeActive(), /127\.0\.0\.1/)
})

await test('uninstalling the wrapper restores the original fetch', async () => {
  uninstall()
  proxyHits.length = 0
  await assert.rejects(() => runWithRoute({ kind: 'proxy', url: `http://127.0.0.1:${proxyPort}` }, () => fetch(TARGET)))
  assert.equal(proxyHits.length, 0)
  // Reinstall so the final dispose has work to do.
  installFetchWrapper()
})

await test('disposeTransport closes its dispatchers', async () => {
  await disposeTransport()
  assert.equal(describeActive(), '尚未建立代理连接')
})

// --- summary -----------------------------------------------------------------

proxyServer.close()
secondServer.close()

if (failures.length > 0) {
  console.error(`${failures.length} failed, ${passed} passed`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exitCode = 1
} else {
  console.log(`${passed} passed`)
}
