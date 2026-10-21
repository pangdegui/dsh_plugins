/**
 * dsh-workbuddy — bring WorkBuddy's models into DeepSeek Harness.
 *
 * WorkBuddy (腾讯 WorkBuddy) is an Electron agent app whose model plane is an
 * OpenAI-compatible gateway at `{endpoint}/v2/chat/completions`. Its account
 * plane is a browser login ("account-scoped external link") that ends with a
 * token poll, and its tokens refresh without a browser round-trip.
 *
 * This plugin owns that account plane and hands the model plane to DSH's
 * existing pi-ai adapter:
 *
 *   1. **Login** — `/workbuddy/login` asks WorkBuddy for a login state, sends
 *      the browser to the returned URL, and polls until the token arrives.
 *      The session (access + refresh token, account, expiry) is persisted to
 *      `$DSH_HOME/workbuddy/session.json` with owner-only permissions.
 *
 *   2. **Credential bridge** — the current access token is written to the
 *      credential seam as `WORKBUDDY_ACCESS_TOKEN`, so no token ever appears
 *      in profile YAML. Requests read the value per call, so a refresh is
 *      visible to the very next model request.
 *
 *   3. **Provider** — ensures the `llm-pi-ai` row carries a `workbuddy`
 *      provider route (`api: openai-completions`, `baseURL: {endpoint}/v2`)
 *      whose model list is the catalog this plugin ships. That route is what
 *      makes the models appear in DSH's model picker and routable by the
 *      agent loop.
 *
 *   4. **Rotation** — a timer refreshes the token shortly before expiry, so a
 *      long-lived DSH install keeps working without another login.
 *
 * Scope: one Host row plus one Settings section. The model picker already
 * renders every pi-ai route, so the browser half is purely the account plane:
 * login status, a QR code for the WorkBuddy sign-in URL, and sign-out. The
 * standalone `/workbuddy` page remains as a script-free fallback for callers
 * that are not the Web UI.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { WORKBUDDY_DEFAULT_MODEL, WORKBUDDY_MODELS } from './catalog.js'
import {
  DEFAULT_PROMPT_PREFIX,
  HARNESS_IDENTITY,
  guardAssembly,
  normalizePromptGuard,
  normalizePromptPrefix,
} from './prompt-guard.js'
import { needsRefresh, providerConfig } from './provider.js'
import { ANONYMOUS_HEADERS, WorkBuddyClient, normalizeToken } from './wb.js'
import { installWireGuard } from './wire.js'
import { renderSVG } from './uqr.js'

export const name = 'workbuddy'

/**
 * No hard dependency: `webServer` is adopted through `ctx.inject`, and
 * `credentials`, `configEditor`, `connection` and `loader` are looked up with
 * `ctx.get`, so a profile that lacks one of them still loads the plugin
 * instead of parking it on an unsatisfied injection.
 */
export const inject = []

export const Config = z.object({
  /** Account and model plane origin. The staging origin is the other valid value. */
  endpoint: z.union([z.const('https://www.workbuddy.cn'), z.const('https://staging.workbuddy.cn')]).default('https://www.workbuddy.cn'),
  /** Provider route name used for `provider:` selection and the pi-ai row. */
  provider: z.string().default('workbuddy'),
  /** Label shown in the model picker. */
  displayName: z.string().default('WorkBuddy'),
  /** Credential ref the access token is published under. */
  credentialRef: z.string().default('WORKBUDDY_ACCESS_TOKEN'),
  /** Install the `llm-pi-ai` provider row when the route is missing. */
  autoRegisterProvider: z.boolean().default(true),
  /**
   * Rewrite an existing `workbuddy` route so a plugin upgrade refreshes its
   * model list. Off by default so edits made in DSH's Models page survive a
   * restart; delete the route from the profile patch to reinstall the catalog.
   */
  syncProviderModels: z.boolean().default(false),
  /** Refresh this long before the access token expires. */
  refreshSkewMs: z.number().default(10 * 60_000),
  /**
   * How the outbound system prompt avoids WorkBuddy's channel check.
   *
   * `off` sends the prompt untouched (the gateway answers 11128 for a prompt
   * that opens with DSH's identity sentence). `prepend` puts `promptPrefix` in
   * front of the first section, keeping every section. `strip` drops the
   * identity section entirely, so the prompt opens with the deployment persona.
   */
  promptGuard: z.union([z.const('off'), z.const('prepend'), z.const('strip')]).default('prepend'),
  /** One line inserted at the very start of the prompt when `promptGuard` is `prepend`. */
  promptPrefix: z.string().default(DEFAULT_PROMPT_PREFIX),
})

const ROUTE_BASE = '/workbuddy'
const SESSION_VERSION = 1

/** Home directory DSH itself resolves, so the file lands beside the profile. */
function dshHome() {
  const home = process.env.DSH_HOME
  return home !== undefined && home.trim() !== '' ? home : path.join(os.homedir(), '.dsh')
}

function sessionPath() {
  return path.join(dshHome(), 'workbuddy', 'session.json')
}

/** Persist the session atomically with owner-only permissions. */
function saveSession(session) {
  const file = sessionPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(session, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporary, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
}

/** Read the persisted session, tolerating a missing or corrupt file. */
function loadSession(logger) {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionPath(), 'utf8'))
    if (parsed?.version !== SESSION_VERSION || typeof parsed?.token?.accessToken !== 'string') return undefined
    return parsed
  } catch (error) {
    if (error?.code !== 'ENOENT') logger?.warn?.(`workbuddy: ignoring unreadable session file: ${String(error)}`)
    return undefined
  }
}

function deleteSession() {
  try {
    fs.rmSync(sessionPath(), { force: true })
  } catch {
    /* a missing file is the desired end state */
  }
}

function sameProviderConfig(left, right) {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

/**
 * Which provider an assembly is being built for.
 *
 * The prompt service resolves its `provider` variable from
 * `context.agent.options.provider` while assembling, so the primary source is
 * already present on the assembly. The agent's model-selection listener may
 * override the same variable for a concurrent switch, which is why this reads
 * the post-waterfall assembly rather than the context. The persisted request
 * header is a last resort for an agent whose options do not name a route.
 *
 * @param assembly - the post-waterfall assembly.
 * @param context - the waterfall context (`{ agent, scope, signal }`).
 * @returns the provider name, or undefined when it cannot be determined.
 */
function assemblyProvider(assembly, context) {
  const selected = assembly?.variables?.provider
  if (typeof selected === 'string' && selected !== '') return selected
  try {
    const provider = context?.agent?.session?.requestHeader?.()?.config?.provider
    if (typeof provider === 'string' && provider !== '') return provider
  } catch {
    /* a session without a header yet is not an error */
  }
  return undefined
}

/**
 * One reconciliation per process is enough: the write is persisted, and a
 * repeat would only reload `llm-pi-ai` again.
 */
let providerReconciled = false

/**
 * Write the `workbuddy` provider into the `llm-pi-ai` row through the Loader's
 * own editor, which persists it in the profile patch and hot-reloads only that
 * entry. Idempotent: an unchanged route writes nothing.
 */
async function reconcileProvider(ctx, config) {
  if (providerReconciled) return true
  const editor = ctx.get('configEditor')
  if (editor === undefined || typeof editor.entries !== 'function' || typeof editor.edit !== 'function') return false
  // The row is normally found by its patch id. Fall back to the module name so
  // a profile that re-adds the row with another id still gets the route.
  const entry = editor.entries().find((candidate) => {
    const options = candidate?.options
    if (options === undefined) return false
    return options.id === 'llm-pi-ai' || options.name === '@deepseek-ai/dsh-llm-pi-ai' || options.name === 'llm-pi-ai'
  })
  if (entry === undefined) {
    ctx.logger?.warn?.('workbuddy: no llm-pi-ai row in this profile; model route not installed')
    return false
  }
  const wanted = providerConfig(config)
  let skipped = false
  try {
    await editor.edit(entry, (current, inherited) => {
      const providers = { ...(inherited?.providers ?? current?.providers ?? {}) }
      const live = providers[config.provider]
      if (live !== undefined && !config.syncProviderModels) {
        skipped = true
        return { ...inherited, providers }
      }
      const next = sameProviderConfig(live, wanted) ? providers : { ...providers, [config.provider]: wanted }
      return { ...inherited, providers: next }
    })
    providerReconciled = true
    if (skipped) {
      ctx.logger?.info?.(
        `workbuddy: pi-ai route "${config.provider}" already configured; leaving it untouched (set syncProviderModels to rewrite its model list)`,
      )
    } else {
      ctx.logger?.info?.(`workbuddy: pi-ai route "${config.provider}" reconciled (${WORKBUDDY_MODELS.length} models)`)
    }
    return true
  } catch (error) {
    ctx.logger?.warn?.(`workbuddy: could not persist the pi-ai route: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/** Publish the access token where pi-ai's `apiKeyEnv` reads it. */
async function publishToken(ctx, config, accessToken) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined || typeof credentials.set !== 'function') {
    ctx.logger?.warn?.('workbuddy: credential store unavailable; requests will fail with MISSING_CREDENTIAL')
    return false
  }
  try {
    await credentials.set(config.credentialRef, accessToken)
    return true
  } catch (error) {
    ctx.logger?.warn?.(`workbuddy: could not store the access token: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

async function clearPublishedToken(ctx, config) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined || typeof credentials.unset !== 'function') return
  try {
    await credentials.unset(config.credentialRef)
  } catch (error) {
    ctx.logger?.warn?.(`workbuddy: could not remove the stored token: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Persist the prompt-guard settings into this plugin's own config row.
 *
 * `configEditor.edit()` validates the row, writes it into the profile patch and
 * lets the Loader reload this entry, so the page's change survives a restart.
 * The row is rewritten in full because the editor replaces a value, not a
 * field: leaving a key out would fall back to the schema default instead of
 * keeping what the profile already had.
 *
 * @param ctx - plugin context, for the editor seam.
 * @param config - the resolved config currently in effect.
 * @param next - `{ mode, prefix }` to store.
 * @returns `{ ok, text }`, user-facing.
 */
async function persistPromptGuard(ctx, config, next) {
  const editor = ctx.get('configEditor')
  if (editor === undefined || typeof editor.edit !== 'function' || typeof editor.entries !== 'function') {
    return { ok: false, text: '配置编辑器不可用：改动只在本次运行内生效，重启后会丢失。' }
  }
  let entry
  try {
    entry = editor.entries().find((candidate) => {
      const options = candidate?.options
      if (options === undefined) return false
      return options.id === 'workbuddy' || options.name === 'dsh-workbuddy'
    })
  } catch (error) {
    return { ok: false, text: `无法读取配置条目：${error instanceof Error ? error.message : String(error)}` }
  }
  if (entry === undefined) {
    return { ok: false, text: '没有可写的配置条目：本插件不是以可配置行加载的。' }
  }
  const row = {
    endpoint: config.endpoint,
    provider: config.provider,
    displayName: config.displayName,
    credentialRef: config.credentialRef,
    autoRegisterProvider: config.autoRegisterProvider,
    syncProviderModels: config.syncProviderModels,
    refreshSkewMs: config.refreshSkewMs,
    promptGuard: next.mode,
    promptPrefix: next.prefix,
  }
  try {
    await editor.edit(entry, () => row)
    return { ok: true, text: '已保存到配置文件，下一次请求立即生效。' }
  } catch (error) {
    return { ok: false, text: `写入配置文件失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

// --- login orchestration -----------------------------------------------------

/** The single login this process is currently polling, if any. */
let pendingLogin

function startLogin(ctx, client, config, state) {
  if (pendingLogin !== undefined) {
    const age = Date.now() - pendingLogin.startedAt
    // Reuse a recent flow: the user may already have the tab open.
    if (age < 10 * 60_000) return pendingLogin
    pendingLogin.controller.abort(new Error('superseded'))
    pendingLogin = undefined
  }

  const controller = new AbortController()
  const flow = {
    startedAt: Date.now(),
    state: undefined,
    authUrl: undefined,
    result: undefined,
    error: undefined,
    controller,
    ready: undefined,
  }
  flow.ready = (async () => {
    try {
      const loginState = await client.createLoginState(controller.signal)
      flow.state = loginState.state
      flow.authUrl = loginState.authUrl
      ctx.logger?.info?.(`workbuddy: login required, open ${loginState.authUrl}`)
      const token = await client.waitForLogin(loginState.state, { signal: controller.signal })
      const account = await client.fetchAccount(token.accessToken).catch((error) => {
        ctx.logger?.warn?.(`workbuddy: login succeeded but account lookup failed: ${String(error)}`)
        return undefined
      })
      const session = {
        version: SESSION_VERSION,
        endpoint: client.endpoint,
        token,
        account: account ?? undefined,
        savedAt: Date.now(),
      }
      saveSession(session)
      state.session = session
      await publishToken(ctx, config, token.accessToken)
      flow.result = session
      ctx.logger?.info?.(`workbuddy: login complete for ${account?.uid ?? '(unknown)'}`)
      if (pendingLogin === flow) pendingLogin = undefined
    } catch (error) {
      flow.error = error
      if (pendingLogin === flow) pendingLogin = undefined
      if (!controller.signal.aborted) ctx.logger?.warn?.(`workbuddy: login failed: ${String(error)}`)
    }
  })()

  pendingLogin = flow
  return flow
}

/** Refresh in the background; returns the token that should now be published. */
async function refreshSession(ctx, config, session, client) {
  if (typeof session?.token?.refreshToken !== 'string' || session.token.refreshToken === '') {
    ctx.logger?.warn?.('workbuddy: session has no refresh token; run /workbuddy/login again')
    return undefined
  }
  try {
    const token = await client.refreshToken(session.token.refreshToken)
    // A refresh answer may omit the refresh token when the provider keeps the
    // existing one; never trade a working refresh token for `undefined`.
    if (token.refreshToken === undefined) token.refreshToken = session.token.refreshToken
    if (token.refreshExpiresAt === undefined) token.refreshExpiresAt = session.token.refreshExpiresAt
    const next = { ...session, token, savedAt: Date.now() }
    saveSession(next)
    await publishToken(ctx, config, token.accessToken)
    ctx.logger?.info?.(`workbuddy: access token refreshed, expires ${new Date(token.expiresAt ?? 0).toISOString()}`)
    return next
  } catch (error) {
    ctx.logger?.warn?.(`workbuddy: token refresh failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

// --- HTTP surface ------------------------------------------------------------

function requestRejection(ctx, req) {
  const connection = ctx.get('connection')
  if (connection === undefined || typeof connection.requestRejection !== 'function') return undefined
  try {
    return connection.requestRejection(req)
  } catch {
    return 403
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body, undefined, 2)
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
  })
  res.end(html)
}

/** Read a small JSON request body, capped so a stray upload cannot sit in memory. */
function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        const parsed = text === '' ? {} : JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('请求内容必须是一个对象'))
          return
        }
        resolve(parsed)
      } catch (error) {
        reject(new Error(`请求不是有效的 JSON：${error instanceof Error ? error.message : String(error)}`))
      }
    })
    req.on('error', reject)
  })
}

/** Escape one interpolated value before it enters the login page's HTML. */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

function page(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
:root{color-scheme:light dark;--bg:#f6f8fb;--fg:#16181d;--muted:#5c6470;--card:#ffffff;--line:#dfe3ea;--accent:#1f5fd6;--ok:#1a7f37;--warn:#9a6700}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--fg:#e6e9ef;--muted:#aeb6c2;--card:#141922;--line:#262c36;--accent:#7cc4ff;--ok:#63d68f;--warn:#ffc46b}}
*{box-sizing:border-box}
body{margin:0;padding:32px 24px;background:var(--bg);color:var(--fg);font:15px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto}h1{margin:0 0 16px;font-size:20px;line-height:28px}p{margin:8px 0;color:var(--muted)}
a{color:var(--accent)}code{padding:2px 6px;border:1px solid var(--line);border-radius:5px;background:var(--card);font-size:13px}
.card{margin:16px 0;padding:16px 20px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
.ok{color:var(--ok)}.warn{color:var(--warn)}
</style></head><body><main>${body}</main></body></html>`
}

/** Render a login URL as an inline QR image the settings page can show. */
function qrDataUri(text) {
  const svg = renderSVG(text, { ecc: 'M', border: 2, pixelSize: 4 })
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

function sessionView(session) {
  if (session === undefined) return { loggedIn: false }
  const token = session.token ?? {}
  return {
    loggedIn: true,
    account: session.account === undefined ? undefined : {
      uid: session.account.uid,
      nickname: session.account.nickname,
      uin: session.account.uin,
      type: session.account.type,
    },
    expiresAt: token.expiresAt,
    expiresInSeconds: Number.isFinite(token.expiresAt) ? Math.round((token.expiresAt - Date.now()) / 1000) : undefined,
    expired: Number.isFinite(token.expiresAt) ? token.expiresAt <= Date.now() : undefined,
    hasRefreshToken: typeof token.refreshToken === 'string' && token.refreshToken !== '',
    savedAt: session.savedAt,
  }
}

function registerRoutes(ctx, config, client, state) {
  const disposers = []

  const guarded = (handler) => async (req, res) => {
    const rejection = requestRejection(ctx, req)
    if (rejection === 403) return sendJson(res, 403, { error: 'host/origin refused' })
    if (rejection === 401) return sendJson(res, 401, { error: 'sign in to the DSH web app first' })
    try {
      await handler(req, res)
    } catch (error) {
      ctx.logger?.warn?.(`workbuddy: route failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      if (!res.headersSent) sendJson(res, 500, { error: String(error?.message ?? error) })
      else res.end()
    }
  }

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/status`,
    handler: guarded(async (_req, res) => {
      sendJson(res, 200, {
        endpoint: client.endpoint,
        provider: config.provider,
        displayName: config.displayName,
        catalogSize: WORKBUDDY_MODELS.length,
        promptGuard: {
          mode: config.promptGuard,
          prefix: config.promptPrefix,
          identity: HARNESS_IDENTITY,
        },
        ...sessionView(state.session),
      })
    }),
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/prompt`,
    handler: guarded(async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'use POST' })
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      const mode = normalizePromptGuard(body.mode, null)
      if (mode === null) {
        return sendJson(res, 400, { error: 'mode 必须是 off、prepend 或 strip' })
      }
      // A blank prefix means "use the shipped default", not "send nothing":
      // `prepend` with an empty line would be indistinguishable from `off`.
      const prefix = normalizePromptPrefix(typeof body.prefix === 'string' ? body.prefix : config.promptPrefix)
      const outcome = await persistPromptGuard(ctx, config, { mode, prefix })
      // Apply in memory too: without a config editor the change must still take
      // effect for this run, and the listener reads these fields per assembly.
      config.promptGuard = mode
      config.promptPrefix = prefix
      ctx.logger?.info?.(`workbuddy: prompt guard ${mode}${outcome.ok ? '' : ' (not persisted)'}`)
      sendJson(res, 200, {
        ok: true,
        persisted: outcome.ok,
        message: outcome.text,
        promptGuard: { mode: config.promptGuard, prefix: config.promptPrefix, identity: HARNESS_IDENTITY },
      })
    }),
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/login`,
    handler: guarded(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const started = startLogin(ctx, client, config, state)
      // Wait only for the auth URL, never for the browser login itself.
      for (let i = 0; i < 100 && started.authUrl === undefined && started.error === undefined; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      if (started.error !== undefined) return sendJson(res, 502, { error: String(started.error?.message ?? started.error) })
      if (started.authUrl === undefined) {
        return sendJson(res, 504, { error: 'WorkBuddy did not return a login URL in time' })
      }
      if (url.searchParams.get('format') === 'json') {
        return sendJson(res, 200, {
          authUrl: started.authUrl,
          state: started.state,
          qr: qrDataUri(started.authUrl),
        })
      }
      res.writeHead(302, { location: started.authUrl, 'cache-control': 'no-store' })
      res.end()
    }),
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/logout`,
    handler: guarded(async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'use POST' })
      if (pendingLogin !== undefined) {
        pendingLogin.controller.abort(new Error('logout'))
        pendingLogin = undefined
      }
      state.session = undefined
      deleteSession()
      await clearPublishedToken(ctx, config)
      sendJson(res, 200, { loggedIn: false })
    }),
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_BASE,
    handler: guarded(async (_req, res) => {
      const view = sessionView(state.session)
      const account = view.account
      const status = view.loggedIn
        ? `<p class="ok">已登录：${escapeHtml(account?.nickname ?? '')} (${escapeHtml(account?.uid ?? '')})</p>
           <p>Access token 到期：${escapeHtml(view.expiresAt ? new Date(view.expiresAt).toLocaleString('zh-CN') : '未知')}</p>`
        : '<p class="warn">尚未登录 WorkBuddy。</p>'
      sendHtml(res, 200, page('WorkBuddy for DSH', `
        <h1>WorkBuddy → DeepSeek Harness</h1>
        <div class="card">${status}
          <p>模型路由：<code>${escapeHtml(config.provider)}</code> · 端点：<code>${escapeHtml(client.endpoint)}/v2</code></p>
          <p><a href="${ROUTE_BASE}/login" target="_blank" rel="noreferrer">登录 / 重新登录</a>（在新标签页打开）· <a href="${ROUTE_BASE}/status">状态 JSON</a></p>
          <p>登录完成后，在 DSH 的模型选择器里选择 “${escapeHtml(config.displayName)}” 下的模型即可。</p>
        </div>`))
    }),
  }))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* disposing twice is harmless */
      }
    }
  }
}

// --- plugin ------------------------------------------------------------------

export function apply(ctx, config) {
  const resolved = {
    endpoint: config?.endpoint === 'https://staging.workbuddy.cn' ? 'https://staging.workbuddy.cn' : 'https://www.workbuddy.cn',
    provider: typeof config?.provider === 'string' && config.provider.trim() !== '' ? config.provider.trim() : 'workbuddy',
    displayName: typeof config?.displayName === 'string' && config.displayName.trim() !== '' ? config.displayName.trim() : 'WorkBuddy',
    credentialRef:
      typeof config?.credentialRef === 'string' && config.credentialRef.trim() !== '' ? config.credentialRef.trim() : 'WORKBUDDY_ACCESS_TOKEN',
    autoRegisterProvider: config?.autoRegisterProvider !== false,
    syncProviderModels: config?.syncProviderModels === true,
    refreshSkewMs: Number.isFinite(config?.refreshSkewMs) ? Math.max(0, config.refreshSkewMs) : 10 * 60_000,
    promptGuard: normalizePromptGuard(config?.promptGuard, 'prepend'),
    promptPrefix: normalizePromptPrefix(config?.promptPrefix),
  }
  const client = new WorkBuddyClient({ endpoint: resolved.endpoint })
  const loaded = loadSession(ctx.logger)
  const state = { session: loaded?.endpoint === resolved.endpoint ? loaded : undefined }

  // The gateway rejects the `developer` instruction role with 11128, and the
  // route's compat switch is only one layer of defence: this wrapper normalizes
  // the role on the wire, for every request this process sends to the endpoint.
  // It also records what was sent, since the gateway's block looks the same
  // whichever reason triggered it.
  ctx.effect(
    () =>
      installWireGuard({
        endpoint: resolved.endpoint,
        logDirectory: path.join(dshHome(), 'workbuddy'),
      }),
    'workbuddy: wire guard',
  )

  // The prompt guard sits on the assembly waterfall: it sees the finished
  // prompt before the loop renders it into the session, and it rewrites only
  // assemblies addressed to this plugin's provider. `prepend` keeps the plugin
  // outermost so a later listener (the agent's model selection) cannot hide the
  // provider variable this reads.
  ctx.effect(
    () =>
      ctx.on(
        'system-prompt/assemble',
        async (assembly, context, next) => {
          const assembled = await next()
          return guardAssembly(resolved, assembled, assemblyProvider(assembled, context))
        },
        { global: true, prepend: true },
      ),
    'workbuddy: prompt guard',
  )

  // Publish whatever we already have, then keep it fresh. Both steps are
  // effects: they dispose with the plugin and never write during teardown.
  ctx.effect(() => {
    let cancelled = false
    void (async () => {
      const session = state.session
      if (session !== undefined && typeof session.token?.accessToken === 'string') {
        await publishToken(ctx, resolved, session.token.accessToken)
      }
      if (cancelled) return
      if (!resolved.autoRegisterProvider) return
      const loader = ctx.get('loader')
      if (loader !== undefined && typeof loader.await === 'function') {
        try {
          await loader.await()
        } catch {
          /* a failed fiber is reported by the boot audit */
        }
      }
      if (!cancelled) await reconcileProvider(ctx, resolved)
    })()
    return () => {
      cancelled = true
    }
  }, 'workbuddy: bootstrap')

  // Rotation: check every minute, refresh when inside the skew window.
  ctx.effect(() => {
    const timer = setInterval(() => {
      void (async () => {
        const session = state.session
        if (session === undefined) return
        if (!needsRefresh(session.token, resolved.refreshSkewMs)) return
        const next = await refreshSession(ctx, resolved, session, client)
        if (next !== undefined) state.session = next
      })()
    }, 60_000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'workbuddy: rotation')

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => registerRoutes(webCtx, resolved, client, state), 'workbuddy: routes')
  })

  // A login poll owns its own timers; abort it with the plugin so a stopped
  // profile cannot keep waiting on a browser tab nobody will finish.
  ctx.effect(() => () => {
    if (pendingLogin !== undefined) {
      pendingLogin.controller.abort(new Error('plugin disposed'))
      pendingLogin = undefined
    }
  }, 'workbuddy: pending-login')
}

/** Exposed for tests: pure pieces plus the login orchestrator. */
export const internals = {
  WorkBuddyClient,
  ANONYMOUS_HEADERS,
  WORKBUDDY_MODELS,
  WORKBUDDY_DEFAULT_MODEL,
  providerConfig,
  needsRefresh,
  normalizeToken,
  guardAssembly,
  assemblyProvider,
  startLogin,
}
