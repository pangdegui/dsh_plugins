/**
 * LAN reach: the managed fence row and the built-in reverse proxy.
 *
 * Regression context: writing `host: 0.0.0.0` into the `webserver` row makes
 * dsh 0.2.1 refuse to start ("unspecified (wildcard) address"), and the desktop
 * host's window URL is hardcoded to 127.0.0.1 — so the listener must never be
 * re-bound. The plugin writes only the `connection.trustedHosts` row and serves
 * the LAN through a proxy on the same port at a concrete address.
 *
 *   node test/managed-rows.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-access-'))
const patchPath = path.join(dir, 'cordis.patch.yml')
fs.writeFileSync(patchPath, '# user layer\n- id: web-access\n  config:\n    bind: 0.0.0.0\n')

// A stand-in for the application's loopback listener.
const upstream = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain', 'x-upstream': 'yes', 'x-seen-host': req.headers.host ?? '' })
  res.end(`upstream:${req.url}`)
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const appPort = upstream.address().port

/** One stub composition; the proxy listens on 127.0.0.2 at the app's port. */
function buildCtx({ host = '127.0.0.1', withProfile = true } = {}) {
  const routes = new Map()
  const webServer = {
    host,
    port: appPort,
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
  ])
  if (withProfile) services.set('profileContext', { name: 'web', dir, patchPath })
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

// A free port for the proxy; it must differ from the upstream port because the
// proxy also binds 127.0.0.1 at this port.
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
  trustedHosts: ['10.1.2.3'],
  totpEnabled: false,
  totpGate: 'all',
}

// 1. The managed block names the fence row only — never the listener.
const first = buildCtx()
apply(first.ctx, config)
const written = fs.readFileSync(patchPath, 'utf8')
const managedBlock = written.slice(written.indexOf('# >>> dsh-web-access managed rows'), written.indexOf('# <<< dsh-web-access managed rows'))
assert.match(written, /dsh-web-access managed rows/u)
assert.match(managedBlock, /- id: connection/u)
assert.equal(managedBlock.includes('- id: webserver'), false, 'the listener row must never be written')
assert.equal(managedBlock.includes('0.0.0.0'), false, 'no wildcard reaches the patch')
assert.match(written, /- id: web-access/u, 'the user layer survives')
assert.match(managedBlock, /- "127\.0\.0\.2"/u)
assert.match(managedBlock, /- "10\.1\.2\.3"/u)

// 2. The proxy accepts LAN traffic and forwards it to the loopback listener.
const forwarded = await new Promise((resolve, reject) => {
  const req = http.request({
    host: '127.0.0.2',
    port: lanPort,
    path: '/hello',
    headers: { host: `127.0.0.2:${lanPort}` },
  }, (res) => {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => { body += chunk })
    res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
  })
  req.on('error', reject)
  req.end()
})
assert.equal(forwarded.status, 200, `proxy answered ${forwarded.status}`)
assert.equal(forwarded.body, 'upstream:/hello', `proxy body was ${forwarded.body}`)
assert.equal(forwarded.headers['x-upstream'], 'yes', 'response headers pass through')
assert.equal(forwarded.headers['x-seen-host'], `127.0.0.2:${lanPort}`, 'the Host header reaches upstream unchanged')

// 2b. The same port also serves 127.0.0.1, so a local browser (and a
// port-forwarder that targets loopback) uses the identical URL.
const viaLoopback = await new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: lanPort, path: '/local', headers: { host: `127.0.0.1:${lanPort}` } }, (res) => {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => { body += chunk })
    res.on('end', () => resolve({ status: res.statusCode, body }))
  })
  req.on('error', reject)
  req.end()
})
assert.equal(viaLoopback.status, 200, `the loopback copy answered ${viaLoopback.status}`)
assert.equal(viaLoopback.body, 'upstream:/local', `loopback body was ${viaLoopback.body}`)

// 3. The panel sees the LAN endpoint and a clean managed write.
await new Promise((resolve) => { setTimeout(resolve, 25) })
const status = await readStatus(first.routes)
assert.equal(status.lan.listening, true, 'the proxy reports as listening')
assert.equal(status.lan.address, '127.0.0.2')
assert.equal(status.lan.port, lanPort)
assert.equal(status.managed.error, null, `no managed-write error, got ${status.managed.error}`)
assert.deepEqual(status.origins, [`http://127.0.0.2:${lanPort}`], 'the LAN origin is the proxy endpoint')

// 4. A second apply rewrites nothing (no patch-watcher loop).
const second = buildCtx()
apply(second.ctx, config)
assert.equal(fs.readFileSync(patchPath, 'utf8'), written, 'an unchanged document is not rewritten')

// 5. Back to loopback closes the proxy and removes the block.
const third = buildCtx()
apply(third.ctx, { ...config, bind: '127.0.0.1', trustedHosts: [] })
const stripped = fs.readFileSync(patchPath, 'utf8')
assert.equal(stripped.includes('dsh-web-access managed rows'), false, 'the block is gone')
assert.match(stripped, /- id: web-access/u, 'the user layer is untouched')
const refused = await new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: lanPort, path: '/' }, () => resolve(false))
  req.on('error', () => resolve(true))
  req.end()
})
assert.equal(refused, true, 'the proxy stops listening when loopback is selected')

// 6. An unlocatable patch path is reported instead of silently ignored.
const blind = buildCtx({ withProfile: false })
apply(blind.ctx, { ...config, trustedHosts: [] })
await new Promise((resolve) => { setTimeout(resolve, 25) })
const blindStatus = await readStatus(blind.routes)
assert.equal(typeof blindStatus.managed.error, 'string', 'a missing patch path is an error, not a no-op')

for (const dispose of third.disposers) dispose()
upstream.close()
console.log('all LAN reach checks passed')
