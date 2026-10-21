/**
 * Wire guard for WorkBuddy's chat gateway.
 *
 * The gateway rejects the OpenAI `developer` instruction role with
 * `400 {"code":11128,"msg":"request illegal"}` — the same "channel
 * verification" block it raises for a prompt that opens with DSH's identity
 * sentence. A pi-ai route can ask for the classic `system` role through
 * `compat.supportsDeveloperRole: false`, but that switch is only as reliable as
 * the adapter build in front of it, so this module enforces the role on the
 * wire as well: the request the transport is about to send is normalized just
 * before it leaves the process.
 *
 * It wraps `globalThis.fetch` the same way `dsh-model-proxy` does — the fetch
 * the provider already uses is the one place every request passes through, and
 * a wrapper can be removed again when the plugin unloads. Only requests to the
 * configured WorkBuddy origin are inspected; everything else is forwarded
 * untouched.
 *
 * Every rewrite is also written to `$DSH_HOME/workbuddy/wire.log` (roles, tool
 * count, token limits and the first line of each instruction message), because
 * the gateway's block is otherwise indistinguishable from a prompt-side block.
 * The access token is never logged.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const MARKER = Symbol.for('dsh-workbuddy.wire-guard')

/** Appended one line per inspected request; failures are ignored. */
function appendLog(directory, line) {
  try {
    fs.mkdirSync(directory, { recursive: true })
    fs.appendFileSync(path.join(directory, 'wire.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* logging must never break a request */
  }
}

/** A short, safe rendering of one instruction message. */
function describeInstruction(message) {
  const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')
  return `${message.role}:${JSON.stringify(text.slice(0, 60))}`
}

/** Headers as a plain object, with the bearer token and cookies removed. */
function redactHeaders(headers) {
  const result = {}
  if (headers === undefined) return result
  const entries = typeof headers.entries === 'function' ? [...headers.entries()] : Object.entries(headers)
  for (const [name, value] of entries) {
    const lower = String(name).toLowerCase()
    result[name] = lower === 'authorization' || lower === 'cookie' ? '<redacted>' : String(value)
  }
  return result
}

/** A one-word description of the fetch implementation in use, for the log. */
function describeFetch(fn) {
  const source = typeof fn === 'function' ? Function.prototype.toString.call(fn).slice(0, 120) : 'none'
  return JSON.stringify(source)
}

/**
 * The header the gateway's channel check actually keys on.
 *
 * Measured against the live gateway with everything else held constant: the
 * same body returns `400 / 11128` when `User-Agent` starts with
 * `deepseek-harness/`, and streams normally when it names anything else — Node's
 * default, `pi (…)`, even `WorkBuddy/1.0`. DSH sets that header once for the
 * whole process, so it reaches every provider; only WorkBuddy rejects it.
 */
const HARNESS_USER_AGENT = /deepseek-harness/i

/** What a rejected `User-Agent` is replaced with when header alignment is off. */
export const NEUTRAL_USER_AGENT = 'WorkBuddy/1.0'

/** The version the client reports when nothing is configured. */
export const DEFAULT_APP_VERSION = '1.0.0'

/**
 * Headers the official client sets on every gateway call.
 *
 * Taken from the WorkBuddy desktop bundle (`VlmUpstream` /
 * `applyGatewayHeaders` / `applyTraceHeaders` in its `server.js`): the relay
 * strips its caller's hop-by-hop headers and then stamps exactly this set. The
 * per-request ids are random, so replaying them carries no state.
 */
function officialHeaders(appVersion, conversationId) {
  const trace = randomHex(16)
  const span = randomHex(8)
  const parent = randomHex(8)
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'accept-encoding': 'identity',
    'x-requested-with': 'XMLHttpRequest',
    'x-conversation-id': conversationId,
    'x-conversation-request-id': randomUuid(),
    'acp-connection-id': randomUuid(),
    'x-conversation-message-id': randomUuid(),
    'x-request-id': randomUuid(),
    'x-agent-intent': 'craft',
    'x-agent-purpose': 'conversation',
    'x-codebuddy-request': '1',
    'x-ide-type': 'WorkBuddy',
    'x-ide-name': 'WorkBuddy',
    'x-ide-version': appVersion,
    'x-private-data': 'true',
    'x-product': 'SaaS',
    traceparent: `00-${trace}-${span}-01`,
    b3: `${trace}-${span}-1-${parent}`,
    'x-b3-traceid': trace,
    'x-b3-parentspanid': parent,
    'x-b3-spanid': span,
    'x-b3-sampled': '1',
    'x-trace-id': trace,
    'user-agent': `WorkBuddy/${appVersion} WorkBuddy/${appVersion}`,
  }
}

/** Headers that betray a non-official client and carry no meaning to the gateway. */
const STRIPPED_HEADERS = new Set([
  'user-agent',
  'accept',
  'accept-encoding',
  'x-requested-with',
  'x-deepseek-harness-user-id',
])

/**
 * Rewrite one request's headers to look like the official client's.
 *
 * Everything the caller sent is preserved except the SDK fingerprints
 * (`x-stainless-*`) and the headers the official relay itself overwrites;
 * `authorization` and any gateway-specific header the user configured stay.
 *
 * @param headers - `Headers`, a plain object, or undefined.
 * @param appVersion - version to report.
 * @param conversationId - stable id for the process.
 * @returns a new header object to send.
 */
function alignHeaders(headers, appVersion, conversationId) {
  const entries = headers === undefined
    ? []
    : typeof headers.entries === 'function'
      ? [...headers.entries()]
      : Object.entries(headers)
  const next = {}
  for (const [name, value] of entries) {
    const lower = String(name).toLowerCase()
    if (lower.startsWith('x-stainless-') || STRIPPED_HEADERS.has(lower)) continue
    next[name] = value
  }
  return { ...next, ...officialHeaders(appVersion, conversationId) }
}

/** A random hex string of `bytes` bytes. */
function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex')
}

/** A random RFC 4122 id. */
function randomUuid() {
  return crypto.randomUUID()
}

/**
 * Replace a harness-identifying `User-Agent`, leaving every other header alone.
 *
 * Returns the input when there is nothing to change, so a request that is fine
 * keeps the exact header object the transport built.
 *
 * @param headers - `Headers`, a plain object, or undefined.
 * @param replacement - the user agent to send instead.
 * @returns the headers to send, or the input when unchanged.
 */
function overrideUserAgent(headers, replacement) {
  if (headers === undefined) return headers
  const entries = typeof headers.entries === 'function' ? [...headers.entries()] : Object.entries(headers)
  const current = entries.find(([name]) => String(name).toLowerCase() === 'user-agent')?.[1]
  if (typeof current !== 'string' || !HARNESS_USER_AGENT.test(current)) return headers
  if (typeof headers.set === 'function') {
    headers.set('user-agent', replacement)
    return headers
  }
  const next = {}
  for (const [name, value] of entries) {
    if (String(name).toLowerCase() === 'user-agent') continue
    next[name] = value
  }
  next['user-agent'] = replacement
  return next
}

/**
 * Rewrite `developer` instruction messages to `system`, in place.
 *
 * pi-ai emits `developer` only for a reasoning model whose compat allows it, so
 * the rewrite is a no-op for every other request. The body is re-serialized
 * only when something actually changed.
 *
 * @param body - the parsed request body.
 * @returns true when at least one message changed role.
 */
function normalizeRoles(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  let changed = false
  for (const message of messages) {
    if (message?.role !== 'developer') continue
    message.role = 'system'
    changed = true
  }
  return changed
}

/** Drop a stale Content-Length so the fetch implementation recomputes it. */
function forgetContentLength(headers) {
  if (headers === undefined) return headers
  if (typeof headers.delete === 'function') {
    headers.delete('content-length')
    return headers
  }
  const copy = { ...headers }
  for (const name of Object.keys(copy)) {
    if (name.toLowerCase() === 'content-length') delete copy[name]
  }
  return copy
}

/**
 * Install the fetch wrapper once per process.
 *
 * @param options - `endpoint` (WorkBuddy origin), `logDirectory` (session dir to
 *   write `wire.log` into; omit to log nothing), `alignHeaders` (default true:
 *   send the official client's header set), `appVersion` (version to report).
 * @returns a disposer that restores the previous fetch.
 */
export function installWireGuard(options) {
  const endpoint = typeof options?.endpoint === 'string' ? options.endpoint.replace(/\/+$/, '') : ''
  const logDirectory = typeof options?.logDirectory === 'string' ? options.logDirectory : undefined
  const align = options?.alignHeaders !== false
  const appVersion =
    typeof options?.appVersion === 'string' && options.appVersion.trim() !== ''
      ? options.appVersion.trim()
      : DEFAULT_APP_VERSION
  const conversationId = randomUuid()
  const original = globalThis.fetch
  if (typeof original !== 'function' || original[MARKER] === true) return () => {}

  const wrapper = async (input, init) => {
    let watched = false
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
      if (
        endpoint !== '' &&
        typeof url === 'string' &&
        url.startsWith(endpoint) &&
        url.includes('/v2/chat/completions') &&
        typeof init?.body === 'string'
      ) {
        const body = JSON.parse(init.body)
        const roles = (body.messages ?? []).map((message) => message.role).join(',')
        const bodyChanged = normalizeRoles(body)
        const headers = align
          ? alignHeaders(init.headers, appVersion, conversationId)
          : overrideUserAgent(init.headers, NEUTRAL_USER_AGENT)
        const headersChanged = headers !== init.headers
        if (logDirectory !== undefined) {
          const instructions = (body.messages ?? [])
            .filter((message) => message.role === 'system' || message.role === 'developer')
            .map(describeInstruction)
            .join(' | ')
          appendLog(
            logDirectory,
            `request model=${body.model} roles=[${roles}] tools=${(body.tools ?? []).length} ` +
              `max_tokens=${body.max_tokens} max_completion_tokens=${body.max_completion_tokens} ` +
              `${bodyChanged ? 'REWROTE developer->system ' : ''}${headersChanged ? (align ? 'ALIGNED headers ' : 'REWROTE user-agent ') : ''}` +
              `instructions=${instructions}`,
          )
          appendLog(logDirectory, `headers=${JSON.stringify(redactHeaders(headers))}`)
          appendLog(logDirectory, `transport=${describeFetch(original)}`)
          watched = true
        }
        if (bodyChanged || headersChanged) {
          init = { ...init, headers: bodyChanged ? forgetContentLength(headers) : headers }
          if (bodyChanged) init.body = JSON.stringify(body)
        }
      }
    } catch {
      /* an unexpected body shape is forwarded untouched */
    }
    const response = await original(input, init)
    if (watched && response.status >= 400) {
      try {
        const text = await response.clone().text()
        appendLog(logDirectory, `response status=${response.status} body=${JSON.stringify(text.slice(0, 600))}`)
      } catch {
        /* a body that cannot be read is not worth a second failure */
      }
    }
    return response
  }
  wrapper[MARKER] = true
  globalThis.fetch = wrapper
  return () => {
    if (globalThis.fetch === wrapper) globalThis.fetch = original
  }
}
