/**
 * dsh-web-access — Host half.
 *
 * Gives a DSH desktop/web profile a **configurable network-access surface**
 * with an optional **TOTP gate**, without hard-coding any assumption about
 * where the deployment sits (intranet, LAN, VPN, public).
 *
 * Three responsibilities:
 *
 *   1. Settings. Four volatile fields are declared so the shipped Settings
 *      machinery renders a native form; the values are the single source of
 *      truth for how far this profile is reachable.
 *
 *   2. Reachability. dsh 0.2.1 rejects a wildcard bind at startup and the
 *      desktop host hardcodes `http://127.0.0.1:<port>` for its window, so the
 *      listener is never re-bound. Instead this plugin runs a small reverse
 *      proxy on a concrete LAN address at the same port, forwarding to the
 *      loopback listener and writing only the trust-fence row the proxy needs.
 *
 *   3. The TOTP gate. A script-free login entry (`/dsh-access`) verifies a
 *      time-based one-time password and then hands back the process launch
 *      token through `connection.authenticatedUrl`, which is exactly the
 *      exchange the application's own root uses: the browser ends up holding
 *      the ordinary authority-bound cookie, so nothing inside the app has to
 *      know TOTP exists. The gate is optional, and can cover every caller or
 *      only non-loopback ones.
 *
 * Deliberate boundaries:
 *
 *   - `port` is NOT configurable. The desktop host reports a fixed URL to its
 *     Electron window, so changing the port desynchronises the running window
 *     from the server. The live port is exposed read-only instead.
 *   - The TOTP secret lives in `$DSH_HOME/web-access/totp.secret`, never in
 *     plugin configuration, so it is never projected to any client and never
 *     triggers a configuration reload. See README.md for recovery.
 *   - Every route this plugin serves reuses the connection layer's own Host /
 *     Origin fence through `connection.requestRejection`, so a rebound or
 *     cross-site caller is refused before any TOTP logic runs.
 */

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { base32Encode, base32Decode, otpauthUri, verifyTotp } from './totp.js'

export const name = 'web-access'

/**
 * No hard service dependency: `webServer`, `connection` and `configEditor` are
 * each adopted through `ctx.inject`, so a profile lacking one still loads this
 * plugin instead of parking it on an unsatisfied injection.
 */
export const inject = []

/**
 * This profile entry's settings.
 *
 * Deliberately NOT `.volatile()`: that marker makes a field validate to a live
 * reference handle (`{}`) instead of the scalar, which only the shipped
 * settings-form machinery knows how to unwrap. This plugin renders its own
 * panel over its own routes, so it wants plain validated values.
 */
export const Config = z.object({
  /** `0.0.0.0` means "serve the LAN through the built-in proxy"; it never
   *  becomes a wildcard listener (dsh rejects that at startup). */
  bind: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).default('127.0.0.1'),
  /** LAN address the proxy listens on; empty picks the primary private IPv4. */
  lanAddress: z.string().default(''),
  /** Trust this machine's own non-internal IPv4 addresses as hosts. */
  autoTrustLocalIps: z.boolean().default(true),
  /** Extra authorities the browser-trust fence accepts (`host`, `host:port`). */
  trustedHosts: z.array(z.string()).default([]),
  /** Require a TOTP before the login entry hands back the launch token. */
  totpEnabled: z.boolean().default(false),
  /** Which callers the gate covers: every authority, or non-loopback only. */
  totpGate: z.union([z.const('all'), z.const('remote')]).default('all'),
})

const LOGIN_PATH = '/dsh-access'
const SETUP_PATH = '/dsh-access/setup'
const CONFIG_PATH = '/dsh-access/config'
/** This plugin's own Loader row id, the entry `configEditor` edits. */
const ENTRY_ID = name

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'])

/** Codes are only 6 digits: bound attempts per source before the lockout. */
const MAX_ATTEMPTS = 8
const ATTEMPT_WINDOW_MS = 10 * 60_000
/** A fixed cost per attempt so a network attacker cannot race the window. */
const ATTEMPT_DELAY_MS = 400

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// --- secret storage ----------------------------------------------------------
// The arithmetic lives in ./totp.js with no Cordis or filesystem touch, so it
// can be exercised against the RFC 6238 test vectors directly.

function secretPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh')
  return path.join(home, 'web-access', 'totp.secret')
}

let cachedSecret

/** Read (or mint, when asked) this profile's TOTP shared key. */
function loadSecret({ create = false } = {}) {
  if (cachedSecret !== undefined) return cachedSecret
  const file = secretPath()
  try {
    const text = fs.readFileSync(file, 'utf8').trim()
    if (text !== '') {
      cachedSecret = base32Decode(text)
      return cachedSecret
    }
  } catch (error) {
    if (error instanceof HttpError) throw error
    if (error.code !== 'ENOENT') throw new HttpError(500, `the TOTP shared key could not be read: ${error.message}`)
  }
  if (!create) return undefined
  const secret = randomBytes(20)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, `${base32Encode(secret)}\n`, { mode: 0o600 })
  cachedSecret = secret
  return secret
}

// --- LAN reachability ---------------------------------------------------------
//
// Two facts rule out the obvious designs on this dsh build:
//
//   1. `dsh-host-webserver` rejects a wildcard bind outright — the config
//      validator throws `host "0.0.0.0" is an unspecified (wildcard) address`,
//      which is a *required* plugin failure, so the whole application refuses
//      to start. Never write `0.0.0.0` into `webserver.host`.
//   2. The desktop host hardcodes `http://127.0.0.1:<port>` for its Electron
//      window, so re-binding the listener to the LAN address would leave the
//      window pointing at a socket nobody listens on.
//
// The reachable design is therefore a reverse proxy: the application keeps its
// loopback listener (window included), and this plugin accepts LAN traffic on
// the same port at a concrete LAN address and forwards it. Only the trust-fence
// row is written to the profile patch; the listener is never re-bound, so no
// setting this plugin stores can keep the application from starting.

const MANAGED_START = '# >>> dsh-web-access managed rows (do not edit) >>>'
const MANAGED_END = '# <<< dsh-web-access managed rows <<<'

/** Last managed-block write, surfaced by the panel. */
let lastManaged = { path: null, changed: false, at: 0, error: null }

/** The LAN-facing proxy: bound to one concrete LAN address, never to 0.0.0.0. */
const proxyState = { server: null, host: null, port: null, listening: false, error: null }

/** This machine's non-internal IPv4 addresses, the same set upstream derives. */
function localIpv4Addresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address)
}

/**
 * The address LAN clients should use.
 *
 * An explicit `lanAddress` wins; otherwise prefer a private 192.168/10 address
 * over the 172.16/12 range, because the latter is where Hyper-V and WSL
 * switches live and those are not reachable from the house network.
 */
function pickLanAddress(config) {
  const explicit = typeof config.lanAddress === 'string' ? config.lanAddress.trim() : ''
  if (explicit !== '') return explicit
  const addresses = localIpv4Addresses()
  return addresses.find((address) => address.startsWith('192.168.'))
    ?? addresses.find((address) => address.startsWith('10.'))
    ?? addresses.find((address) => !/^172\.(1[6-9]|2\d|3[01])\./u.test(address))
    ?? addresses[0]
    ?? null
}

/** Authorities the trust fence must accept for the configured reach. */
function trustedAuthorities(config) {
  const merged = []
  if (config.bind !== '127.0.0.1') {
    const address = pickLanAddress(config)
    if (address !== null) merged.push(address)
    if (config.autoTrustLocalIps) merged.push(...localIpv4Addresses())
  }
  merged.push(...config.trustedHosts)
  return [...new Set(merged.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter((entry) => entry !== ''))]
}

/**
 * The YAML rows this plugin owns in the profile patch.
 *
 * Only the fence needs a row: the proxy serves `http://<lan>:<port>`, and the
 * fence compares that authority against the listener's loopback bind, so the
 * LAN address has to be named explicitly. `webserver` is deliberately absent —
 * re-binding it is what broke startup.
 */
function managedRows(config) {
  const authorities = trustedAuthorities(config)
  if (authorities.length === 0) return ''
  const lines = [
    '# Authorities the browser-trust fence accepts for LAN access. The',
    "# application's own listener stays on loopback and is never re-bound.",
    '- id: connection',
    '  config:',
    '    trustedHosts:',
  ]
  for (const authority of authorities) lines.push(`      - ${JSON.stringify(authority)}`)
  return lines.join('\n')
}

/** Locate the profile patch the Loader watches. */
function patchPath(ctx) {
  const fromProfile = ctx.get('profileContext')?.patchPath
  if (typeof fromProfile === 'string' && fromProfile !== '') return fromProfile
  const fromEditor = ctx.get('configEditor')?.documentPath
  return typeof fromEditor === 'string' && fromEditor !== '' ? fromEditor : null
}

/**
 * Write (or remove) the managed block and report what happened.
 *
 * Idempotent by construction: an unchanged document is never rewritten, so the
 * patch watcher settles after at most one reload instead of oscillating.
 */
function syncManagedRows(ctx, config) {
  const file = patchPath(ctx)
  const at = Date.now()
  if (file === null) {
    lastManaged = { path: null, changed: false, at, error: 'the profile patch path is unavailable' }
    return lastManaged
  }
  let before
  try {
    before = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') {
      lastManaged = { path: file, changed: false, at, error: String(error.message ?? error) }
      return lastManaged
    }
    before = ''
  }
  const body = managedRows(config)
  const block = body === '' ? '' : `${MANAGED_START}\n${body}\n${MANAGED_END}\n`
  const start = before.indexOf(MANAGED_START)
  const end = before.indexOf(MANAGED_END)
  let after = before
  if (start !== -1 && end > start) {
    after = `${before.slice(0, start)}${block}${before.slice(end + MANAGED_END.length).replace(/^\r?\n/u, '')}`
  } else if (block !== '') {
    after = `${before.trimEnd()}\n\n${block}`
  }
  if (after === before) {
    lastManaged = { path: file, changed: false, at, error: null }
    return lastManaged
  }
  try {
    const temp = `${file}.web-access.tmp`
    fs.writeFileSync(temp, after, { mode: 0o600 })
    fs.renameSync(temp, file)
    lastManaged = { path: file, changed: true, at, error: null }
  } catch (error) {
    lastManaged = { path: file, changed: false, at, error: String(error.message ?? error) }
  }
  return lastManaged
}

// --- the LAN proxy -----------------------------------------------------------

/** Forward one ordinary HTTP request to the loopback listener, Host intact. */
function forwardHttp(req, res, port) {
  const upstream = http.request({
    host: '127.0.0.1',
    port,
    method: req.method,
    path: req.url,
    headers: req.headers,
  }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers)
    answer.pipe(res)
  })
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh-web-access: the local Harness listener is unavailable\n')
    } else {
      res.destroy()
    }
  })
  req.on('error', () => upstream.destroy())
  req.pipe(upstream)
}

/** Tunnel one upgraded connection (WebSocket) with its original handshake. */
function forwardUpgrade(req, socket, head, port) {
  const upstream = net.connect(port, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      lines.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`)
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head !== undefined && head.length > 0) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
}

/** Start (or keep) the LAN listener; never throws and never blocks startup. */
function startProxy(ctx, config) {
  if (config.bind === '127.0.0.1') {
    stopProxy()
    return
  }
  const port = ctx.get('webServer')?.port
  const host = pickLanAddress(config)
  if (typeof port !== 'number' || host === null) {
    proxyState.error = typeof port !== 'number'
      ? 'the local listener has no port yet'
      : 'this machine has no LAN IPv4 address'
    return
  }
  if (proxyState.server !== null && proxyState.host === host && proxyState.port === port) return
  stopProxy()
  const server = http.createServer((req, res) => forwardHttp(req, res, port))
  server.on('upgrade', (req, socket, head) => forwardUpgrade(req, socket, head, port))
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })
  server.once('error', (error) => {
    proxyState.server = null
    proxyState.host = null
    proxyState.port = null
    proxyState.listening = false
    proxyState.error = String(error.message ?? error)
    ctx.logger?.warn?.('web-access: LAN proxy could not listen on %s:%s: %s', host, port, proxyState.error)
  })
  server.once('listening', () => {
    proxyState.listening = true
    proxyState.error = null
    ctx.logger?.info?.('web-access: LAN proxy listening on http://%s:%s', host, port)
  })
  proxyState.server = server
  proxyState.host = host
  proxyState.port = port
  proxyState.listening = false
  proxyState.error = null
  server.listen(port, host)
}

/** Close the LAN listener, if one is open. */
function stopProxy() {
  const server = proxyState.server
  proxyState.server = null
  proxyState.host = null
  proxyState.port = null
  proxyState.listening = false
  if (server === null) return
  try {
    server.closeAllConnections?.()
    server.close()
  } catch {
    // closing an already-closed server is not worth surfacing
  }
}

/** Apply the configured reach: fence row first, then the LAN listener. */
async function reconcile(ctx, config) {
  syncManagedRows(ctx, config)
  startProxy(ctx, config)
  if (lastManaged.error !== null) {
    ctx.logger?.warn?.('web-access: managed rows were not written: %s', lastManaged.error)
  }
}

// --- the trust fence ---------------------------------------------------------

/**
 * Reuse the connection layer's fence rather than reimplementing it.
 *
 * `undefined` = trusted and authenticated, `401` = trusted but anonymous (the
 * state a login page must serve), `403` = refused by the Host/Origin check.
 */
function fence(ctx, req) {
  const connection = ctx.get('connection')
  if (connection === undefined || typeof connection.requestRejection !== 'function') return 403
  try {
    const rejection = connection.requestRejection(req)
    return rejection === undefined ? undefined : rejection
  } catch {
    return 403
  }
}

function isLoopbackRequest(req) {
  const host = String(req.headers.host ?? '').toLowerCase()
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return LOOPBACK_HOSTNAMES.has(hostname)
}

function requestScheme(req) {
  return req.socket.encrypted === true ? 'https' : 'http'
}

// --- rate limiting -----------------------------------------------------------

const attempts = new Map()

function permitAttempt(key) {
  const now = Date.now()
  const history = (attempts.get(key) ?? []).filter((at) => now - at < ATTEMPT_WINDOW_MS)
  if (history.length >= MAX_ATTEMPTS) {
    attempts.set(key, history)
    return false
  }
  history.push(now)
  attempts.set(key, history)
  return true
}

// --- HTTP helpers ------------------------------------------------------------

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
  })
  res.end(html)
}

function readBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new HttpError(413, 'request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

/** Reject anything that is not a bare `host[:port]` before it becomes a Location. */
function requestAuthority(req) {
  const host = String(req.headers.host ?? '')
  if (host === '' || !/^[A-Za-z0-9.\-:[\]]+$/u.test(host)) throw new HttpError(400, 'malformed Host header')
  return host
}

// --- pages -------------------------------------------------------------------

const PAGE_CSS = `
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
    background:#f5f5f7; color:#1d1d1f; }
  .card { width:min(360px,calc(100vw - 48px)); padding:24px; border-radius:14px;
    background:#fff; box-shadow:0 8px 28px rgba(0,0,0,.10); }
  h1 { margin:0 0 6px; font-size:17px; font-weight:600; }
  p { margin:0 0 14px; font-size:13px; opacity:.72; }
  label { display:block; font-size:13px; margin-bottom:6px; opacity:.8; }
  input { width:100%; box-sizing:border-box; padding:10px 12px; font-size:16px; letter-spacing:.16em;
    border:1px solid rgba(128,128,128,.4); border-radius:8px; background:transparent; color:inherit; }
  input:focus { outline:2px solid #0a84ff; outline-offset:1px; }
  button { width:100%; margin-top:14px; padding:10px 12px; font-size:14px; font-weight:600;
    border:none; border-radius:8px; background:#0a84ff; color:#fff; cursor:pointer; }
  button:hover { background:#0071e3; }
  .error { margin-top:12px; font-size:13px; color:#c4271c; }
  @media (prefers-color-scheme:dark) {
    body { background:#1b1b1d; color:#f2f2f7; }
    .card { background:#2a2a2d; box-shadow:none; border:1px solid rgba(255,255,255,.08); }
    button { background:#0a84ff; }
  }
`

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

function loginPage({ message, error }) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepSeek Harness · 连接验证</title><style>${PAGE_CSS}</style></head>
<body><main class="card">
  <h1>连接验证</h1>
  <p>${escapeHtml(message)}</p>
  <form method="post" action="${LOGIN_PATH}">
    <label for="code">动态验证码</label>
    <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code"
      pattern="[0-9]{6}" maxlength="6" autofocus required>
    <button type="submit">验证并连接</button>
    ${error === undefined ? '' : `<div class="error" role="alert">${escapeHtml(error)}</div>`}
  </form>
</main></body></html>`
}

function noticePage(title, body) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepSeek Harness · ${escapeHtml(title)}</title><style>${PAGE_CSS}</style></head>
<body><main class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`
}

// --- provisioning ------------------------------------------------------------

/** Addresses another device can actually use to reach this server. */
function reachableOrigins(ctx, config) {
  const port = ctx.get('webServer')?.port
  if (typeof port !== 'number') return []
  if (config.bind !== '127.0.0.1') {
    const host = proxyState.host ?? pickLanAddress(config)
    return host === null ? [] : [`http://${host}:${String(port)}`]
  }
  const host = typeof ctx.get('webServer')?.host === 'string' ? ctx.get('webServer').host : '127.0.0.1'
  return [`http://${host}:${String(port)}`]
}

function setupPayload(ctx, config, secret) {
  const origins = reachableOrigins(ctx, config)
  return {
    enabled: config.totpEnabled === true,
    gate: config.totpGate,
    bind: config.bind,
    port: ctx.get('webServer')?.port ?? null,
    secret: base32Encode(secret),
    otpauth: otpauthUri(secret, os.hostname()),
    trust: {
      localIps: config.bind !== '127.0.0.1' && config.autoTrustLocalIps ? localIpv4Addresses() : [],
      extra: config.trustedHosts,
      live: [...(ctx.get('connection')?.trustedHosts ?? [])],
    },
    origins,
    loginUrl: origins.length > 0 ? `${origins[0]}${LOGIN_PATH}` : LOGIN_PATH,
  }
}

// --- settings API ------------------------------------------------------------

/**
 * Outcome of the most recent settings write.
 *
 * The route answers before persisting (persisting restarts this fiber, and a
 * response queued across that restart would be lost), so the write's own
 * failure has nowhere to go in that response. Keeping it here surfaces it on
 * the next read instead of leaving a silent no-op.
 */
let lastSaveError = null
let lastSaveAt = 0

/** The editable configuration plus the live status the panel renders. */
function configPayload(ctx, config) {
  const origins = reachableOrigins(ctx, config)
  return {
    config: {
      bind: config.bind,
      lanAddress: config.lanAddress,
      autoTrustLocalIps: config.autoTrustLocalIps,
      trustedHosts: config.trustedHosts,
      totpEnabled: config.totpEnabled,
      totpGate: config.totpGate,
    },
    status: {
      host: ctx.get('webServer')?.host ?? null,
      port: ctx.get('webServer')?.port ?? null,
      /** The LAN-facing proxy this plugin runs, and why it is not listening. */
      lan: {
        address: proxyState.host,
        port: proxyState.port,
        listening: proxyState.listening,
        error: proxyState.error,
      },
      trustLive: [...(ctx.get('connection')?.trustedHosts ?? [])],
      localIps: localIpv4Addresses(),
      origins,
      loginUrl: origins.length > 0 ? `${origins[0]}${LOGIN_PATH}` : LOGIN_PATH,
      /**
       * Per-origin launch-token URLs.
       *
       * A bare `/` is refused without the process launch token, which is why
       * opening `http://host:port` in a fresh browser answers 401. These URLs
       * carry that token, so another device can complete the ordinary
       * authority-bound cookie exchange. Only an already-authenticated caller
       * can read them (this route is behind the session cookie).
       */
      tokenUrls: (() => {
        const connection = ctx.get('connection')
        if (connection === undefined || typeof connection.authenticatedUrl !== 'function') return []
        return origins.map((origin) => connection.authenticatedUrl(`${origin}/`))
      })(),
      lastSaveError,
      lastSaveAt,
      /** What the managed block write did on this process. */
      managed: {
        path: lastManaged.path,
        changed: lastManaged.changed,
        at: lastManaged.at,
        error: lastManaged.error,
      },
    },
  }
}

const TOTP_GATES = new Set(['all', 'remote'])
const HOST_AUTHORITY = /^[A-Za-z0-9.\-:[\]]+$/u

/**
 * Validate one settings draft against this plugin's own schema.
 * @throws {HttpError} 400 naming the first field that cannot be accepted.
 */
function validatePatch(body) {
  const patch = {}
  if (body.bind !== undefined) {
    const value = typeof body.bind === 'string' ? body.bind.trim() : body.bind
    if (value !== '127.0.0.1' && value !== '0.0.0.0') {
      // Name what arrived; a bare "invalid" message cannot be acted on.
      throw new HttpError(400, `bind must be 127.0.0.1 or 0.0.0.0 (received ${JSON.stringify(body.bind)})`)
    }
    patch.bind = value
  }
  if (body.autoTrustLocalIps !== undefined) {
    if (typeof body.autoTrustLocalIps !== 'boolean') throw new HttpError(400, 'autoTrustLocalIps must be a boolean')
    patch.autoTrustLocalIps = body.autoTrustLocalIps
  }
  if (body.lanAddress !== undefined) {
    const value = typeof body.lanAddress === 'string' ? body.lanAddress.trim() : body.lanAddress
    if (value !== '' && !/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(String(value))) {
      throw new HttpError(400, `lanAddress must be an IPv4 address or empty (received ${JSON.stringify(body.lanAddress)})`)
    }
    patch.lanAddress = value
  }
  if (body.trustedHosts !== undefined) {
    if (!Array.isArray(body.trustedHosts)) throw new HttpError(400, 'trustedHosts must be an array')
    const list = body.trustedHosts.map((entry) => String(entry).trim()).filter((entry) => entry !== '')
    if (!list.every((entry) => HOST_AUTHORITY.test(entry))) throw new HttpError(400, 'a trusted host must be host or host:port')
    patch.trustedHosts = list
  }
  if (body.totpEnabled !== undefined) {
    if (typeof body.totpEnabled !== 'boolean') throw new HttpError(400, 'totpEnabled must be a boolean')
    patch.totpEnabled = body.totpEnabled
  }
  if (body.totpGate !== undefined) {
    if (!TOTP_GATES.has(body.totpGate)) throw new HttpError(400, 'totpGate must be all or remote')
    patch.totpGate = body.totpGate
  }
  return patch
}

/**
 * Locate this plugin's own addressable profile row.
 *
 * The profile row id is `web-access`, but the addressable entries come from the
 * Loader and are keyed by patch id; match the package name as a fallback so a
 * composition that spells the id differently still resolves. The failure names
 * the ids that *are* addressable, because "no entry" alone cannot be acted on.
 */
function findOwnEntry(editor) {
  const entries = editor.entries()
  return entries.find((candidate) => candidate.options.id === ENTRY_ID)
    ?? entries.find((candidate) => candidate.options.name === name)
    ?? (() => {
      const ids = entries.map((candidate) => candidate.options.id).slice(0, 12).join(', ')
      throw new HttpError(503, `this plugin has no addressable configuration entry (addressable ids: ${ids === '' ? 'none' : ids})`)
    })()
}

/** Persist this plugin's own row so the Loader applies it and restarts us. */
async function persistOwnConfig(ctx, next) {
  const editor = ctx.get('configEditor')
  if (editor === undefined) throw new HttpError(503, 'the configuration editor is unavailable')
  const entry = findOwnEntry(editor)
  await editor.edit(entry, (current) => ({ ...current, ...next }))
}

// --- routes ------------------------------------------------------------------

function registerRoutes(ctx, config) {
  const login = async (req, res) => {
    const rejection = fence(ctx, req)
    if (rejection === 403) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    const connection = ctx.get('connection')
    if (rejection === undefined && connection !== undefined) {
      res.writeHead(303, { 'cache-control': 'no-store', location: '/' })
      res.end()
      return
    }
    // The gate covers loopback only when the caller is asked to prove identity.
    const loopback = isLoopbackRequest(req)
    if (config.totpEnabled !== true || (config.totpGate === 'remote' && loopback)) {
      const origin = requestScheme(req) + '://' + requestAuthority(req)
      sendHtml(res, 200, noticePage(
        '此入口当前不下发令牌',
        `未启用动态验证码时,这个入口不会把连接令牌交出去。桌面窗口已通过启动令牌登录;要在其他设备上使用,请先在「Web 访问」面板里启用动态验证码,或从面板复制带令牌的连接地址。本机应用地址: ${origin}/`,
      ))
      return
    }
    const secret = loadSecret()
    if (secret === undefined) {
      sendHtml(res, 200, noticePage('尚未生成密钥', '请先在桌面端的插件设置页里生成 TOTP 密钥,再回来完成绑定。'))
      return
    }
    if (req.method === 'POST') {
      const remote = req.socket.remoteAddress ?? 'unknown'
      if (!permitAttempt(remote)) {
        sendHtml(res, 429, loginPage({ message: '尝试次数过多,请稍后再试。', error: undefined }))
        return
      }
      await delay(ATTEMPT_DELAY_MS)
      let code = ''
      try {
        const body = await readBody(req)
        const params = new URLSearchParams(body)
        code = params.get('code') ?? ''
      } catch (error) {
        if (error instanceof HttpError) {
          sendHtml(res, error.status, loginPage({ message: '动态验证码', error: error.message }))
          return
        }
        throw error
      }
      if (!verifyTotp(secret, code)) {
        sendHtml(res, 401, loginPage({ message: '动态验证码不正确。', error: '请打开验证器应用,输入当前显示的 6 位数字。' }))
        return
      }
      const authority = requestAuthority(req)
      const target = connection?.authenticatedUrl(`${requestScheme(req)}://${authority}/`)
      res.writeHead(303, { 'cache-control': 'no-store', location: target ?? '/' })
      res.end()
      return
    }
    sendHtml(res, 200, loginPage({ message: '请输入验证器应用上显示的 6 位动态验证码,以连接到本机的 Harness。', error: undefined }))
  }

  const setup = async (req, res) => {
    // Provisioning hands out the shared key, so it demands the full cookie.
    const rejection = fence(ctx, req)
    if (rejection !== undefined) {
      sendJson(res, rejection === 403 ? 403 : 401, { ok: false, error: rejection === 403 ? 'forbidden' : 'authentication required' })
      return
    }
    let rotate = false
    if (req.method === 'POST') {
      try {
        const body = await readBody(req)
        rotate = new URLSearchParams(body).get('rotate') === '1'
      } catch {
        rotate = false
      }
      if (rotate) cachedSecret = undefined
    }
    const secret = loadSecret({ create: true })
    if (secret === undefined) throw new HttpError(500, 'the TOTP shared key could not be created')
    sendJson(res, 200, { ok: true, ...setupPayload(ctx, config, secret) })
  }

  const settings = async (req, res) => {
    // Reading or changing this plugin's settings is operator work: full cookie.
    const rejection = fence(ctx, req)
    if (rejection !== undefined) {
      sendJson(res, rejection === 403 ? 403 : 401, { ok: false, error: rejection === 403 ? 'forbidden' : 'authentication required' })
      return
    }
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, ...configPayload(ctx, config) })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    let raw = ''
    try {
      raw = await readBody(req)
    } catch (error) {
      sendJson(res, error instanceof HttpError ? error.status : 400, { ok: false, error: 'the request body could not be read' })
      return
    }
    let body = {}
    try {
      const parsed = raw === '' ? {} : JSON.parse(raw)
      body = parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      sendJson(res, 400, { ok: false, error: 'malformed JSON body' })
      return
    }
    let patch
    try {
      patch = validatePatch(body)
    } catch (error) {
      sendJson(res, error instanceof HttpError ? error.status : 400, { ok: false, error: error.message })
      return
    }
    if (Object.keys(patch).length === 0) {
      sendJson(res, 400, { ok: false, error: 'no setting was provided' })
      return
    }
    const next = { ...config, ...patch }
    // Answer first: persisting restarts this plugin's fiber, and a response
    // still queued across that restart would never reach the browser.
    sendJson(res, 200, { ok: true, ...configPayload(ctx, next) })
    setImmediate(() => {
      persistOwnConfig(ctx, next).then(
        () => {
          lastSaveError = null
          lastSaveAt = Date.now()
        },
        (error) => {
          lastSaveError = error instanceof Error ? error.message : String(error)
          lastSaveAt = Date.now()
          ctx.logger?.warn?.('web-access: saving settings failed: %s', lastSaveError)
        },
      )
    })
  }

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: LOGIN_PATH, handler: login }),
      ctx.webServer.register({ kind: 'exact', path: SETUP_PATH, handler: setup }),
      ctx.webServer.register({ kind: 'exact', path: CONFIG_PATH, handler: settings }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'web-access: routes')
}

// --- plugin ------------------------------------------------------------------

export function apply(ctx, config) {
  const settings = config ?? {}
  // Coerce every field to its exact expected primitive. `??` alone is not
  // enough: a schema marker or a hand-edited patch can hand back a non-scalar
  // (a `.volatile()` reference handle is `{}`), and one of those reaching the
  // panel turns a valid setting into a rejected write.
  const resolved = {
    bind: settings.bind === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1',
    lanAddress: typeof settings.lanAddress === 'string' ? settings.lanAddress.trim() : '',
    autoTrustLocalIps: settings.autoTrustLocalIps !== false,
    trustedHosts: Array.isArray(settings.trustedHosts)
      ? settings.trustedHosts.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
      : [],
    totpEnabled: settings.totpEnabled === true,
    totpGate: settings.totpGate === 'remote' ? 'remote' : 'all',
  }

  // The fence and the listener belong to other entries; adopt them once the
  // services they live on exist, so a late or absent one never blocks load.
  // `profileContext` carries the patch path the managed rows live in.
  ctx.inject(['webServer', 'profileContext'], (webCtx) => {
    registerRoutes(webCtx, resolved)
    // Write the fence row before the patch watcher arms (an early write cannot
    // trigger a reload of this boot), then open the LAN listener.
    syncManagedRows(webCtx, resolved)
    startProxy(webCtx, resolved)
    webCtx.effect(() => () => stopProxy(), 'web-access: LAN proxy')

    // Reconcile once more after boot settles: the port is final then, and a
    // config change that restarted this fiber lands here too. The effect stays
    // synchronous and returns a disposer; the await lives inside the closure.
    webCtx.effect(() => {
      let cancelled = false
      void (async () => {
        try {
          const loader = webCtx.get('loader')
          if (loader !== undefined && typeof loader.await === 'function') {
            try {
              await loader.await()
            } catch {
              /* a failed fiber is reported by the boot audit, not here */
            }
          }
          if (!cancelled) await reconcile(webCtx, resolved)
        } catch (error) {
          webCtx.logger?.warn?.('web-access: reconciliation failed: %s', error instanceof Error ? error.message : String(error))
        }
      })()
      return () => {
        cancelled = true
      }
    }, 'web-access: reconcile')
  })
}
