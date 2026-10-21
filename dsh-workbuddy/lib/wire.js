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
 *   write `wire.log` into; omit to log nothing).
 * @returns a disposer that restores the previous fetch.
 */
export function installWireGuard(options) {
  const endpoint = typeof options?.endpoint === 'string' ? options.endpoint.replace(/\/+$/, '') : ''
  const logDirectory = typeof options?.logDirectory === 'string' ? options.logDirectory : undefined
  const original = globalThis.fetch
  if (typeof original !== 'function' || original[MARKER] === true) return () => {}

  const wrapper = async (input, init) => {
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
        const changed = normalizeRoles(body)
        if (logDirectory !== undefined) {
          const instructions = (body.messages ?? [])
            .filter((message) => message.role === 'system' || message.role === 'developer')
            .map(describeInstruction)
            .join(' | ')
          appendLog(
            logDirectory,
            `request model=${body.model} roles=[${roles}] tools=${(body.tools ?? []).length} ` +
              `max_tokens=${body.max_tokens} max_completion_tokens=${body.max_completion_tokens} ` +
              `${changed ? 'REWROTE developer->system ' : ''}instructions=${instructions}`,
          )
        }
        if (changed) {
          init = { ...init, body: JSON.stringify(body) }
          init.headers = forgetContentLength(init.headers)
        }
      }
    } catch {
      /* an unexpected body shape is forwarded untouched */
    }
    return original(input, init)
  }
  wrapper[MARKER] = true
  globalThis.fetch = wrapper
  return () => {
    if (globalThis.fetch === wrapper) globalThis.fetch = original
  }
}
