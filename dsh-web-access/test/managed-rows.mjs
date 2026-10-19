/**
 * The managed listener rows: written into the profile patch, idempotent, and
 * removed when the bind returns to loopback.
 *
 * This is the regression the editor path had: `configEditor` cannot address the
 * bundled `webserver` / `connection` rows on dsh 0.2.1, so the bind silently
 * stayed on loopback. The plugin now writes the rows itself.
 *
 *   node test/managed-rows.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-access-'))
const patchPath = path.join(dir, 'cordis.patch.yml')
const userLayer = '# user layer\n- id: web-access\n  config:\n    bind: 0.0.0.0\n'
fs.writeFileSync(patchPath, userLayer)

/** One stub composition: webserver, fence, and (optionally) the patch path. */
function buildCtx({ host = '127.0.0.1', withProfile = true } = {}) {
  const routes = new Map()
  const webServer = {
    host,
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
  ])
  if (withProfile) services.set('profileContext', { name: 'web', dir, patchPath })
  const ctx = {
    logger: { warn() {}, error() {} },
    get(name) { return services.get(name) },
    inject(_names, callback) { callback(this) },
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
    get webServer() { return services.get('webServer') },
    get connection() { return services.get('connection') },
  }
  return { ctx, routes }
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

// 1. bind 0.0.0.0 writes the listener rows next to the user's own layer.
const first = buildCtx()
apply(first.ctx, { bind: '0.0.0.0', autoTrustLocalIps: false, trustedHosts: ['10.1.2.3'] })
const written = fs.readFileSync(patchPath, 'utf8')
assert.match(written, /dsh-web-access managed rows/u)
assert.match(written, /- id: webserver/u)
assert.match(written, /host: 0\.0\.0\.0/u)
assert.match(written, /port: !!js ctx\.webStartup\.port \?\? 3080/u)
assert.match(written, /- id: connection/u)
assert.match(written, /- "10\.1\.2\.3"/u)
assert.match(written, /- id: web-access/u, 'the user layer survives')
assert.equal((written.match(/- id: webserver/gu) ?? []).length, 1, 'one webserver row')

// 2. a second reconcile rewrites nothing (no patch-watcher loop).
const second = buildCtx({ host: '127.0.0.1' })
apply(second.ctx, { bind: '0.0.0.0', autoTrustLocalIps: false, trustedHosts: ['10.1.2.3'] })
assert.equal(fs.readFileSync(patchPath, 'utf8'), written, 'an unchanged document is not rewritten')

// 3. the panel can see that this process still owes the restart.
await new Promise((resolve) => { setTimeout(resolve, 25) })
const owed = await readStatus(second.routes)
assert.equal(owed.restartRequired, true, 'the live loopback listener still owes the restart')
assert.equal(owed.managed.path, patchPath, 'the payload names the managed document')
assert.equal(owed.managed.error, null, `no managed-write error, got ${owed.managed.error}`)

// 4. back to loopback removes the whole block and nothing else.
const third = buildCtx()
apply(third.ctx, { bind: '127.0.0.1', autoTrustLocalIps: true, trustedHosts: [] })
const stripped = fs.readFileSync(patchPath, 'utf8')
assert.equal(stripped.includes('dsh-web-access managed rows'), false, 'the block is gone')
assert.match(stripped, /- id: web-access/u, 'the user layer is untouched')

// 5. an unlocatable patch path is reported instead of silently ignored.
const blind = buildCtx({ withProfile: false })
apply(blind.ctx, { bind: '0.0.0.0', autoTrustLocalIps: false, trustedHosts: [] })
await new Promise((resolve) => { setTimeout(resolve, 25) })
const blindStatus = await readStatus(blind.routes)
assert.equal(typeof blindStatus.managed.error, 'string', 'a missing patch path is an error, not a no-op')

console.log('all managed-row checks passed')
