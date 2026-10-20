/**
 * Prove the scope claim end to end, against the real undici the app ships.
 *
 * The claim: installing this plugin's fetch wrapper cannot change the network
 * path of anything that is not a model request. Before the wrapper, a request to
 * an unroutable host fails; after the wrapper, the same request must fail the
 * same way — because the wrapper delegates to the original fetch whenever there
 * is no ambient route.
 *
 * And the complementary claim: with an ambient route, the same request succeeds
 * through the proxy. Same process, same host, opposite outcomes: the difference
 * can only be the route.
 *
 * Run with:
 *   set UNDICI_PATH=...\undici\index.js
 *   node test/scope.test.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'

import { reportSkip, resolveUndici } from './undici.mjs'
import { installFetchWrapper, loadTransport, runWithRoute } from '../lib/transport.js'

const resolved = await resolveUndici()
if (!('module' in resolved)) {
  reportSkip('scope.test.mjs', resolved.skip)
  process.exit(0)
}

const verdict = await loadTransport({ module: resolved.module })
if (!verdict.ok) {
  console.error('transport unavailable:', verdict.problems)
  process.exit(1)
}

const hits = []
const proxy = http.createServer((req, res) => {
  hits.push(req.url)
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('VIA-PROXY')
})
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`

const TARGET = 'http://example.invalid/not-a-model-request'
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

/** True when the request reached DNS and failed there, i.e. no proxy answered. */
async function failsWithoutProxy() {
  try {
    await fetch(TARGET)
    return false
  } catch {
    return true
  }
}

// Baseline, before this plugin wraps anything.
const baselineFails = await failsWithoutProxy()

const uninstall = installFetchWrapper()

await test('unrelated traffic behaves exactly as it did before the wrapper', async () => {
  hits.length = 0
  const stillFails = await failsWithoutProxy()
  assert.equal(stillFails, baselineFails, 'the wrapper must not change an unrouted request')
  assert.equal(hits.length, 0, 'no plugin-owned proxy may see unrelated traffic')
})

await test('the same request succeeds when a route is present', async () => {
  hits.length = 0
  const response = await runWithRoute({ kind: 'proxy', url: proxyUrl }, () => fetch(TARGET))
  assert.equal(await response.text(), 'VIA-PROXY')
  // An HTTP proxy receives the absolute form, not a bare path.
  assert.equal(hits.length, 1)
  assert.equal(hits[0], TARGET)
})

await test('after the route, the same request fails again', async () => {
  hits.length = 0
  assert.equal(await failsWithoutProxy(), baselineFails)
  assert.equal(hits.length, 0)
})

uninstall()
proxy.close()

if (failures.length > 0) {
  console.error(`${failures.length} failed, ${passed} passed`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exitCode = 1
} else {
  console.log(`${passed} passed`)
}
