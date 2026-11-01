/**
 * mDNS wiring: the panel settings start and stop the alias publisher, and the
 * published name enters the trust fence so `Host: lab.local:3080` is accepted.
 *
 * The responder itself is replaced through `internals`, so this test never
 * touches port 5353 or the network.
 *
 *   node test/mdns-wiring.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { apply, internals } from '../lib/index.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-access-mdns-'))
const patchPath = path.join(dir, 'cordis.patch.yml')
fs.writeFileSync(patchPath, '# user layer\n- id: web-access\n  config:\n    bind: 0.0.0.0\n')

const created = []
let stopped = 0
internals.createPublisher = (options) => {
  const publisher = {
    name: options.name,
    address: options.address,
    port: options.port,
    status: { published: true, error: null, conflict: false },
    async start() {},
    stop() {
      stopped += 1
      this.status.published = false
    },
  }
  created.push(publisher)
  return publisher
}

function buildCtx() {
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
    requestRejection() { return undefined },
    authenticatedUrl(base) { return `${base}?token=TEST` },
  }
  const services = new Map([
    ['webServer', webServer],
    ['connection', connection],
    ['profileContext', { name: 'web', dir, patchPath }],
  ])
  const disposers = []
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    get(name) { return services.get(name) },
    inject(_names, callback) { callback(this) },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => { if (typeof dispose === 'function') dispose() }
    },
    get webServer() { return services.get('webServer') },
    get connection() { return services.get('connection') },
  }
  return { ctx, routes, disposers }
}

function makeRes() {
  return {
    statusCode: 0,
    payload: '',
    writeHead(status) { this.statusCode = status },
    end(chunk) { this.payload = chunk ?? '' },
  }
}

function makeReq() {
  const req = new EventEmitter()
  req.method = 'GET'
  req.headers = { host: '127.0.0.1:19387' }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}

async function readStatus(routes) {
  const route = routes.get('/dsh-access/config')
  assert.ok(route !== undefined, 'the config route is registered')
  const res = makeRes()
  await route.handler(makeReq(), res)
  assert.equal(res.statusCode, 200, `GET /dsh-access/config answered ${res.statusCode}: ${res.payload}`)
  return JSON.parse(res.payload).status
}

const settle = async () => {
  await new Promise((resolve) => { setImmediate(resolve) })
  await new Promise((resolve) => { setTimeout(resolve, 30) })
}

const lanPort = await new Promise((resolve) => {
  const probe = http.createServer()
  probe.listen(0, '127.0.0.1', () => {
    const port = probe.address().port
    probe.close(() => resolve(port))
  })
})

const config = {
  bind: '0.0.0.0',
  lanAddress: '127.0.0.2',
  lanPort,
  autoTrustLocalIps: false,
  trustedHosts: [],
  totpEnabled: false,
  totpGate: 'all',
  mdnsEnabled: true,
  mdnsName: 'lab.local',
}

// 1. Enabling the alias builds one publisher for the proxy endpoint.
const first = buildCtx()
apply(first.ctx, config)
await settle()

assert.equal(created.length, 1, 'one publisher is created')
assert.equal(created[0].name, 'lab.local', 'the configured name is published')
assert.equal(created[0].address, '127.0.0.2', 'the alias points at the proxy address')
assert.equal(created[0].port, lanPort, 'the alias carries the LAN port')

// 2. The name is trusted by the fence, or the alias would resolve to a 403.
const managed = fs.readFileSync(patchPath, 'utf8')
assert.match(managed, /- "lab\.local"/u, 'the published alias joins the trusted hosts')

const status = await readStatus(first.routes)
assert.equal(status.mdns.enabled, true)
assert.equal(status.mdns.published, true, 'the panel sees the alias as published')
assert.equal(status.mdns.name, 'lab.local')
assert.equal(status.mdns.address, '127.0.0.2')
assert.equal(status.mdns.port, lanPort)

// 3. Turning the alias off stops it and removes the trusted row.
for (const dispose of first.disposers) dispose()
assert.equal(stopped, 1, 'disposing the fiber stops the publisher')

const second = buildCtx()
apply(second.ctx, { ...config, mdnsEnabled: false })
await settle()
assert.equal(created.length, 1, 'no publisher is created while the alias is off')
const disabled = await readStatus(second.routes)
assert.equal(disabled.mdns.enabled, false)
assert.equal(disabled.mdns.published, false, 'nothing is published while the alias is off')
assert.equal(fs.readFileSync(patchPath, 'utf8').includes('lab.local'), false, 'the alias row is dropped with the alias')
for (const dispose of second.disposers) dispose()

// 4. A loopback-only profile publishes nothing even when the box is checked.
const third = buildCtx()
apply(third.ctx, { ...config, bind: '127.0.0.1' })
await settle()
assert.equal(created.length, 1, 'a loopback profile creates no publisher')
const loopback = await readStatus(third.routes)
assert.equal(loopback.mdns.enabled, false)
assert.equal(loopback.mdns.published, false)
for (const dispose of third.disposers) dispose()

console.log('dsh-web-access mDNS wiring checks')
console.log('  start, trust row, status, stop: ok')
console.log('  all checks passed')
