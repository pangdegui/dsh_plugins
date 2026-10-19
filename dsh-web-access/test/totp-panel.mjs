/**
 * TOTP: the gate must actually gate, the panel must get a scannable QR, and a
 * token URL must not be offered while the gate is on (it would bypass it).
 *
 *   node test/totp-panel.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

// The shared key lives under $DSH_HOME; never touch the real one in a test.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-access-home-'))
process.env.DSH_HOME = home

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-access-profile-'))
const patchPath = path.join(dir, 'cordis.patch.yml')
fs.writeFileSync(patchPath, '# user layer\n- id: web-access\n  config:\n    bind: 127.0.0.1\n')

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
  // The login entry is reached by an anonymous but trusted caller; the two
  // settings routes are reached by the authenticated panel.
  requestRejection(req) { return req.url === '/dsh-access' ? 401 : undefined },
  authenticatedUrl(base) { return `${base}?token=TEST` },
}
const services = new Map([
  ['webServer', webServer],
  ['connection', connection],
  ['profileContext', { name: 'web', dir, patchPath }],
])
const ctx = {
  logger: { warn() {}, info() {}, error() {} },
  get(name) { return services.get(name) },
  inject(_names, callback) { callback(this) },
  effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
  get webServer() { return services.get('webServer') },
  get connection() { return services.get('connection') },
}

apply(ctx, {
  bind: '127.0.0.1',
  lanAddress: '',
  autoTrustLocalIps: true,
  trustedHosts: [],
  totpEnabled: true,
  totpGate: 'all',
})

// Reconcile settles asynchronously and provisions the key.
await new Promise((resolve) => { setTimeout(resolve, 40) })
const keyFile = path.join(home, 'web-access', 'totp.secret')
assert.equal(fs.existsSync(keyFile), true, 'enabling the gate provisions a key without a manual step')

function makeRes() {
  return {
    statusCode: 0,
    payload: '',
    writeHead(status) { this.statusCode = status },
    end(chunk) { this.payload = chunk ?? '' },
  }
}

function makeReq(method = 'GET', url = '/') {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:19387' }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}

// 1. The setup route hands back a scannable QR plus the key and otpauth link.
const setupRoute = routes.get('/dsh-access/setup')
assert.ok(setupRoute !== undefined, 'the setup route is registered')
const setupRes = makeRes()
await setupRoute.handler(makeReq(), setupRes)
assert.equal(setupRes.statusCode, 200, `setup answered ${setupRes.statusCode}: ${setupRes.payload}`)
const setup = JSON.parse(setupRes.payload)
assert.equal(setup.enabled, true)
assert.match(setup.otpauth, /^otpauth:\/\/totp\//u)
assert.match(setup.secret, /^[A-Z2-7]+$/u)
assert.match(setup.qr ?? '', /^data:image\/svg\+xml;base64,/u, 'the QR is an inline SVG data URI')
const svg = Buffer.from(setup.qr.split(',')[1], 'base64').toString('utf8')
assert.match(svg, /^<svg /u, 'the data URI decodes to SVG')
assert.match(svg, /<path /u, 'the SVG carries the module paths')

// 2. Token URLs disappear while the gate is on — they would bypass it.
const configRoute = routes.get('/dsh-access/config')
const configRes = makeRes()
await configRoute.handler(makeReq(), configRes)
const status = JSON.parse(configRes.payload).status
assert.deepEqual(status.tokenUrls, [], 'no token URL is offered while TOTP is on')

// 3. The login entry asks for a code instead of handing out a token.
const loginRoute = routes.get('/dsh-access')
const loginRes = makeRes()
await loginRoute.handler(makeReq('GET', '/dsh-access'), loginRes)
assert.equal(loginRes.statusCode, 200)
assert.match(loginRes.payload, /name="code"/u, 'the login page is the code form')

fs.rmSync(home, { recursive: true, force: true })
fs.rmSync(dir, { recursive: true, force: true })
console.log('all TOTP panel checks passed')
