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
 *   2. Reconciliation. `bind` and the trust fence are properties of *other*
 *      entries (`webserver`, `connection`), not of this plugin, so `apply`
 *      rewrites them through `configEditor`, the Loader-owned path that
 *      persists the change into the profile patch and hot-reloads only the
 *      affected entry. A Cordis `restart` re-runs `Service.init`, so the
 *      webserver really rebinds — no application restart required. Each
 *      target is written at most once per process, which makes a reconcile
 *      idempotent instead of a restart loop.
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
  /** The bind address the webserver should listen on. */
  bind: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).default('127.0.0.1'),
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

// --- reconciliation ----------------------------------------------------------

/**
 * Bounded write attempts per target.
 *
 * The primary decision is always "does the live value already match?", so a
 * settled profile writes nothing. This counter only stops a restart loop when a
 * write genuinely fails to take effect; it resets whenever the live value does
 * match, so a user may toggle a setting back and forth freely.
 */
const editAttempts = new Map()
const MAX_EDIT_ATTEMPTS = 3

async function editEntry(ctx, editor, entryId, key, nextValue) {
  const editorService = editor ?? ctx.get('configEditor')
  if (editorService === undefined) return false
  const entry = editorService.entries().find((candidate) => candidate.options.id === entryId)
  if (entry === undefined) return false
  const signature = `${entryId}:${key}`
  const used = editAttempts.get(signature) ?? 0
  if (used >= MAX_EDIT_ATTEMPTS) {
    ctx.logger?.warn?.('web-access: %s did not take effect after %s writes; leaving it alone', signature, used)
    return false
  }
  editAttempts.set(signature, used + 1)
  try {
    await editorService.edit(entry, (_current, inherited) => ({ ...inherited, [key]: nextValue }))
    return true
  } catch (error) {
    ctx.logger.warn('web-access: could not persist %s.%s: %s', entryId, key, error instanceof Error ? error.message : String(error))
    return false
  }
}

/** This machine's non-internal IPv4 addresses, the same set upstream derives. */
function localIpv4Addresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address)
}

/** Bring the fence in line with the chosen reach, then the bind itself. */
async function reconcile(ctx, config) {
  const editor = ctx.get('configEditor')
  if (editor === undefined) return

  const wantedTrust = config.autoTrustLocalIps && config.bind === '0.0.0.0' ? localIpv4Addresses() : []
  const merged = [...new Set([...wantedTrust, ...config.trustedHosts])].filter((entry) => typeof entry === 'string' && entry.trim() !== '')
  const liveTrust = ctx.get('connection')?.trustedHosts
  const sameTrust = Array.isArray(liveTrust) && liveTrust.length === merged.length && liveTrust.every((value, index) => value === merged[index])
  if (!sameTrust) await editEntry(ctx, editor, 'connection', 'trustedHosts', merged)

  const liveHost = ctx.get('webServer')?.host
  if (typeof liveHost === 'string' && liveHost !== config.bind) {
    await editEntry(ctx, editor, 'webserver', 'host', config.bind)
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
function reachableOrigins(ctx) {
  const server = ctx.get('webServer')
  const port = server?.port
  if (typeof port !== 'number') return []
  const bind = typeof server.host === 'string' ? server.host : '127.0.0.1'
  const hosts = bind === '0.0.0.0' ? localIpv4Addresses() : [bind]
  return hosts.map((host) => `http://${host}:${String(port)}`)
}

function setupPayload(ctx, config, secret) {
  const origins = reachableOrigins(ctx)
  return {
    enabled: config.totpEnabled === true,
    gate: config.totpGate,
    bind: config.bind,
    port: ctx.get('webServer')?.port ?? null,
    secret: base32Encode(secret),
    otpauth: otpauthUri(secret, os.hostname()),
    trust: {
      localIps: config.autoTrustLocalIps && config.bind === '0.0.0.0' ? localIpv4Addresses() : [],
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
  const origins = reachableOrigins(ctx)
  return {
    config: {
      bind: config.bind,
      autoTrustLocalIps: config.autoTrustLocalIps,
      trustedHosts: config.trustedHosts,
      totpEnabled: config.totpEnabled,
      totpGate: config.totpGate,
    },
    status: {
      host: ctx.get('webServer')?.host ?? null,
      port: ctx.get('webServer')?.port ?? null,
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
    autoTrustLocalIps: settings.autoTrustLocalIps !== false,
    trustedHosts: Array.isArray(settings.trustedHosts)
      ? settings.trustedHosts.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
      : [],
    totpEnabled: settings.totpEnabled === true,
    totpGate: settings.totpGate === 'remote' ? 'remote' : 'all',
  }

  // The fence and the bind belong to other entries; adopt them once the
  // services they live on exist, so a late or absent one never blocks load.
  ctx.inject(['webServer'], (webCtx) => {
    registerRoutes(webCtx, resolved)

    // Reconciling writes configuration back through the Loader, so it waits for
    // boot to settle first. The effect stays synchronous and returns a
    // disposer; the await lives inside the closure it owns.
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
