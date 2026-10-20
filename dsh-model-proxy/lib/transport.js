/**
 * `transport.js` — everything that talks to undici.
 *
 * Two independent layers, because they answer different questions and fail in
 * different ways:
 *
 *   1. **Global policy.** Installing an undici dispatcher process-wide is what
 *      the official `@deepseek-ai/dsh-http-proxy` does at launch. It is
 *      re-installable at runtime, which is what makes the panel's switch work
 *      without a restart. Everything that calls a plain `fetch()` — the OpenAI
 *      SDK, pi-ai, the DeepSeek adapter — picks it up on the next request.
 *
 *   2. **Per-request routing.** `globalThis.fetch` is wrapped so a request with
 *      an ambient route (set by the `llm/stream` waterfall listener) uses that
 *      route's dispatcher instead of the global one.
 *
 * Why the wrapper and not just a `dispatcher` option: the global `fetch` in
 * Node is patched by Electron/VS Code hosts and, in this runtime, rejects an
 * undici dispatcher from a different undici copy ("invalid onRequestStart
 * method"). Delegating to `undici.fetch` with that same dispatcher, from the
 * copy this module imported, does work — that is the seam this file exists for.
 *
 * A caveat worth knowing: `undici.setGlobalDispatcher` writes to
 * `globalThis[Symbol.for('undici.globalDispatcher.2')]`, so it crosses module
 * copies. The route bookkeeping inside `@deepseek-ai/dsh-http-proxy` does not,
 * which is why this plugin owns its own state instead of importing that module.
 *
 * @module dsh-model-proxy/transport
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/** The ambient route for the request currently being issued, per async context. */
const ambient = new AsyncLocalStorage()

/** Installed dispatchers, keyed by proxy URL. Long-lived so connections pool. */
const dispatchers = new Map()

/** A dispatcher used when a route says "direct" while a global proxy is installed. */
let directDispatcher

/** The dispatcher that was installed before this plugin touched anything. */
let baseline

let undici

/**
 * Load undici once and verify the two assumptions this plugin rests on.
 *
 * Both probes are cheap and local; nothing leaves the machine. A failure here
 * means the plugin must degrade to a no-op rather than break every request, so
 * the caller gets a report instead of an exception.
 *
 * @param {{ module?: object }} [options] `module` overrides the import, which is
 *   how the self-tests point at a specific undici copy without a node_modules.
 * @returns {Promise<{ ok: boolean, problems: string[] }>} the probe verdict.
 */
export async function loadTransport(options = {}) {
  const problems = []
  if (undici !== undefined) return { ok: true, problems }

  try {
    undici = options.module ?? (await import('undici'))
  } catch (error) {
    return { ok: false, problems: [`cannot import undici: ${error instanceof Error ? error.message : String(error)}`] }
  }

  for (const name of ['Agent', 'ProxyAgent', 'fetch', 'setGlobalDispatcher', 'getGlobalDispatcher']) {
    if (typeof undici[name] !== 'function') {
      problems.push(`undici has no ${name}()`)
    }
  }

  if (problems.length === 0) {
    try {
      // Constructing the two types the plugin will use proves the exports are
      // usable, without opening a socket.
      const agent = new undici.Agent()
      await agent.close()
      const proxy = new undici.ProxyAgent('http://127.0.0.1:1')
      await proxy.close()
    } catch (error) {
      problems.push(`undici dispatchers are unusable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { ok: problems.length === 0, problems }
}

/**
 * Run `fn` with `route` as the ambient decision for every fetch it issues.
 *
 * The route travels through `AsyncLocalStorage`, so concurrent model calls do
 * not see each other's decision and a nested call inherits the outer one until
 * it sets its own.
 *
 * @template T
 * @param {{ kind: 'inherit' | 'direct' | 'proxy', url?: string } | undefined} route the decision.
 * @param {() => T} fn the work that issues the request.
 * @returns {T} whatever `fn` returns.
 */
export function runWithRoute(route, fn) {
  if (route === undefined || route.kind === 'inherit') return fn()
  return ambient.run(route, fn)
}

/**
 * The ambient route, if a request is running under one.
 *
 * @returns {{ kind: 'direct' } | { kind: 'proxy', url: string } | undefined} the route.
 */
export function currentRoute() {
  const route = ambient.getStore()
  if (route === undefined) return undefined
  return route.kind === 'proxy' ? { kind: 'proxy', url: route.url } : { kind: 'direct' }
}

/**
 * Get (or build) the dispatcher for one proxy URL.
 *
 * @param {string} url the proxy URL, already validated.
 * @returns {object} an undici dispatcher.
 */
function proxyDispatcher(url) {
  let dispatcher = dispatchers.get(url)
  if (dispatcher === undefined) {
    dispatcher = new undici.ProxyAgent(url)
    dispatchers.set(url, dispatcher)
  }
  return dispatcher
}

/**
 * Get (or build) the dispatcher that ignores every proxy.
 *
 * @returns {object} an undici dispatcher.
 */
function directAgent() {
  directDispatcher ??= new undici.Agent({ connections: 8 })
  return directDispatcher
}

/**
 * Translate a route into the dispatcher it names.
 *
 * @param {{ kind: 'direct' } | { kind: 'proxy', url: string }} route the decision.
 * @returns {object} an undici dispatcher.
 */
function dispatcherFor(route) {
  return route.kind === 'proxy' ? proxyDispatcher(route.url) : directAgent()
}

/**
 * Install `globalThis.fetch` as a route-aware wrapper.
 *
 * Returns a disposer that puts the original back. It only restores what it
 * installed: if someone wrapped `fetch` after this plugin did, the disposer
 * leaves their wrapper in place rather than silently unwrapping it.
 *
 * @returns {() => void} the disposer.
 */
export function installFetchWrapper() {
  const original = globalThis.fetch
  if (typeof original !== 'function') return () => {}

  const wrapper = function routedFetch(input, init) {
    const route = currentRoute()
    if (route === undefined) return original.call(globalThis, input, init)
    // A body that is a stream needs `duplex: 'half'`; the caller already set it
    // when the original call required it, so pass `init` through unchanged.
    return undici.fetch(input, { ...(init ?? {}), dispatcher: dispatcherFor(route) })
  }

  // A marker so a reload can recognise its own wrapper instead of stacking.
  const marker = Symbol.for('dsh.model-proxy.fetch')
  if (original[marker] === true) return () => {}
  wrapper[marker] = true

  globalThis.fetch = wrapper
  return () => {
    if (globalThis.fetch === wrapper) globalThis.fetch = original
  }
}

/**
 * Replace the process-wide proxy with `policy`.
 *
 * `system` restores whatever dispatcher was in place when this plugin first
 * took over — normally the launcher's own env-derived policy. `direct` installs
 * a dispatcher that bypasses everything. `proxy` installs one proxy.
 *
 * The previous dispatcher is *not* closed here: it may be the launcher's, and
 * closing it would break any request still in flight on it. Only dispatchers
 * this plugin created are ever closed, by {@link disposeTransport}.
 *
 * @param {{ mode: 'system' | 'direct' | 'proxy', url?: string }} policy the global policy.
 * @returns {{ ok: boolean, applied: string, reason?: string }} what was installed.
 */
export function applyGlobalPolicy(policy) {
  if (undici === undefined) return { ok: false, applied: 'none', reason: 'transport not loaded' }

  const mode = String(policy?.mode ?? 'system').toLowerCase()

  if (mode === 'system') {
    if (baseline !== undefined) undici.setGlobalDispatcher(baseline)
    return { ok: true, applied: 'system' }
  }

  if (mode === 'direct') {
    undici.setGlobalDispatcher(directAgent())
    return { ok: true, applied: 'direct' }
  }

  if (mode === 'proxy') {
    if (typeof policy.url !== 'string' || policy.url.trim() === '') {
      return { ok: false, applied: 'none', reason: 'global.url is empty' }
    }
    try {
      undici.setGlobalDispatcher(proxyDispatcher(policy.url.trim()))
    } catch (error) {
      return { ok: false, applied: 'none', reason: error instanceof Error ? error.message : String(error) }
    }
    return { ok: true, applied: `proxy ${policy.url.trim()}` }
  }

  return { ok: false, applied: 'none', reason: `unknown mode "${String(policy?.mode)}"` }
}

/**
 * Remember the dispatcher currently in place as the `system` baseline.
 *
 * Called once at startup, before the first policy is applied. Captured here
 * rather than read on every switch because `system` means "what the launcher
 * decided", which stops being observable once this plugin has replaced it.
 */
export function captureBaseline() {
  if (undici === undefined || baseline !== undefined) return
  try {
    baseline = undici.getGlobalDispatcher()
  } catch {
    baseline = undefined
  }
}

/**
 * A short description of the dispatcher currently installed, for the panel.
 *
 * @returns {string} the active global policy as the panel should show it.
 */
export function describeGlobal() {
  if (undici === undefined) return 'transport not loaded'
  try {
    const current = undici.getGlobalDispatcher()
    if (current === baseline) return 'system (launcher environment)'
    if (current === directDispatcher) return 'direct'
    for (const [url, dispatcher] of dispatchers) {
      if (dispatcher === current) return `proxy ${url}`
    }
    return 'unknown dispatcher'
  } catch (error) {
    return `unavailable: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * Close every dispatcher this plugin created.
 *
 * Only its own are closed; the baseline belongs to the launcher and is restored
 * rather than closed, so a reload cannot break the harness's own transports.
 *
 * @returns {Promise<void>} resolves once each dispatcher has drained.
 */
export async function disposeTransport() {
  if (undici !== undefined && baseline !== undefined) {
    try {
      undici.setGlobalDispatcher(baseline)
    } catch {
      /* the launcher's dispatcher is gone; nothing to restore into */
    }
  }

  const closing = [...dispatchers.values(), directDispatcher].filter((entry) => entry !== undefined)
  dispatchers.clear()
  directDispatcher = undefined
  baseline = undefined

  await Promise.all(
    closing.map(async (dispatcher) => {
      try {
        await dispatcher.close()
      } catch {
        /* close() is best effort; a broken socket must not fail the reload */
      }
    }),
  )
}
