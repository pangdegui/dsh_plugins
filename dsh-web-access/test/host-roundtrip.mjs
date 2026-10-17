/**
 * Round-trip the config route: GET the payload, then POST it straight back,
 * which is exactly what the panel's save button does.
 *
 * The Host half is imported for real (the workspace node_modules junction
 * resolves @deepseek-ai/schemastery), with Cordis, the webserver and the
 * connection fence stubbed.
 *
 *   node test/host-roundtrip.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { apply, Config } from '../lib/index.js'

// Regression: a `.volatile()` field validates to a live reference handle (`{}`)
// instead of the scalar. One of those reaching the panel makes every save a
// rejected write, so the schema must hand back plain values.
{
  const result = Config['~standard'].validate({})
  assert.equal(result.issues, undefined, `the schema accepts an empty config: ${JSON.stringify(result.issues)}`)
  const config = result.value
  assert.equal(config.bind, '127.0.0.1', `bind resolves to its default string, got ${JSON.stringify(config.bind)}`)
  assert.equal(typeof config.autoTrustLocalIps, 'boolean', 'autoTrustLocalIps resolves to a boolean')
  assert.ok(Array.isArray(config.trustedHosts), 'trustedHosts resolves to an array')
  assert.equal(typeof config.totpEnabled, 'boolean', 'totpEnabled resolves to a boolean')
  assert.equal(config.totpGate, 'all', `totpGate resolves to its default string, got ${JSON.stringify(config.totpGate)}`)

  const filled = Config['~standard'].validate({ bind: '0.0.0.0', totpEnabled: true, totpGate: 'remote', autoTrustLocalIps: false, trustedHosts: ['10.0.0.5'] })
  assert.deepEqual(filled.value, { bind: '0.0.0.0', autoTrustLocalIps: false, trustedHosts: ['10.0.0.5'], totpEnabled: true, totpGate: 'remote' }, 'a full config validates to plain values')
}

const routes = new Map()

const webServer = {
  host: '127.0.0.1',
  port: 19387,
  register(route) {
    routes.set(route.path, route)
    return () => { routes.delete(route.path) }
  },
}

const connection = {
  trustedHosts: [],
  // Treat every request as trusted and authenticated: this test is about the
  // settings round-trip, not about the fence.
  requestRejection() { return undefined },
  authenticatedUrl(base) { return `${base}?token=TEST` },
}

const edits = []
const ownEntry = {
  options: {
    id: 'web-access',
    name: 'dsh-web-access',
    config: { bind: '127.0.0.1', autoTrustLocalIps: true, trustedHosts: [], totpEnabled: false, totpGate: 'all' },
  },
  fiber: { state: 2 },
}

const configEditor = {
  entries: () => [ownEntry],
  edit: async (entry, change) => {
    edits.push({ id: entry.options.id, next: change({ ...entry.options.config }, {}) })
  },
}

const services = new Map([
  ['webServer', webServer],
  ['connection', connection],
  ['configEditor', configEditor],
])

const ctx = {
  logger: { warn() {}, error() {} },
  get(name) { return services.get(name) },
  inject(_names, callback) { callback(this) },
  effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
  // Cordis exposes injected services as context properties, which the route
  // registration reads as `ctx.webServer`.
  get webServer() { return services.get('webServer') },
  get connection() { return services.get('connection') },
  get configEditor() { return services.get('configEditor') },
}

apply(ctx, {
  bind: '127.0.0.1',
  autoTrustLocalIps: true,
  trustedHosts: [],
  totpEnabled: false,
  totpGate: 'all',
})

const route = routes.get('/dsh-access/config')
assert.ok(route !== undefined, 'the config route is registered')

function makeRes() {
  return {
    statusCode: 0,
    payload: '',
    writeHead(status) { this.statusCode = status },
    end(chunk) { this.payload = chunk ?? '' },
  }
}

function makeReq(method, body) {
  const req = new EventEmitter()
  req.method = method
  req.headers = { host: '127.0.0.1:19387' }
  req.socket = { remoteAddress: '127.0.0.1' }
  if (body !== undefined) {
    setImmediate(() => {
      req.emit('data', Buffer.from(body))
      req.emit('end')
    })
  }
  return req
}

const getRes = makeRes()
await route.handler(makeReq('GET'), getRes)
assert.equal(getRes.statusCode, 200, `GET answered 200, got ${getRes.statusCode}: ${getRes.payload}`)
const fetched = JSON.parse(getRes.payload)
console.log('GET payload:', JSON.stringify({ config: fetched.config, status: fetched.status }))

// Exactly what the panel does: stringify the config object it was handed.
const postRes = makeRes()
await route.handler(makeReq('POST', JSON.stringify(fetched.config)), postRes)
console.log('POST ->', postRes.statusCode, postRes.payload)

assert.equal(postRes.statusCode, 200, `POST of the GET payload must succeed, got ${postRes.statusCode}: ${postRes.payload}`)

// The write is deferred so the response survives the plugin restart it causes.
await new Promise((resolve) => { setImmediate(resolve) })
await new Promise((resolve) => { setTimeout(resolve, 20) })
assert.equal(edits.length >= 1, true, 'the write reached configEditor.edit')
assert.equal(edits[0].id, 'web-access', `configEditor edited this plugin's own row, got ${edits[0].id}`)
assert.equal(edits[0].next.bind, '127.0.0.1', 'the edited config keeps the bind')

const afterWrite = makeRes()
await route.handler(makeReq('GET'), afterWrite)
const afterPayload = JSON.parse(afterWrite.payload)
assert.equal(afterPayload.status.lastSaveError, null, `persisting reported no failure, got ${afterPayload.status.lastSaveError}`)

// And the one change the user actually made.
const toggled = makeRes()
await route.handler(makeReq('POST', JSON.stringify({ ...fetched.config, autoTrustLocalIps: false })), toggled)
console.log('POST (autoTrustLocalIps=false) ->', toggled.statusCode, toggled.payload)
assert.equal(toggled.statusCode, 200, `toggling autoTrustLocalIps must succeed, got ${toggled.statusCode}: ${toggled.payload}`)

console.log('\nall checks passed')
