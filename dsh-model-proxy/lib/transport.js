/**
 * `transport.js` — everything that talks to undici.
 *
 * **Scope: model traffic only.** This module never installs a process-wide
 * dispatcher. Replacing the global dispatcher is what the official
 * `@deepseek-ai/dsh-http-proxy` does at launch, and it is exactly the wrong tool
 * here: it changes the network path for every request the harness makes — web
 * fetches, plugin installs, subprocess-adjacent HTTP, telemetry — while the
 * configuration only ever talks about models.
 *
 * So the mechanism is narrower:
 *
 *   1. A rule decision is attached to one `llm/stream` call through
 *      `AsyncLocalStorage` (see {@link runWithRoute}).
 *   2. `globalThis.fetch` is wrapped, and the wrapper does nothing at all unless
 *      an ambient route is present. A request with no route takes the original
 *      `fetch`, so it reaches the network exactly as it would have with this
 *      plugin uninstalled — including whatever proxy the launcher put in place
 *      from `HTTPS_PROXY`.
 *
 * The consequence worth stating plainly: removing this plugin cannot leave the
 * process on a proxy it created, because it never changed the default path.
 *
 * Why wrap `fetch` instead of passing `dispatcher` to the adapter: the global
 * `fetch` in this runtime is patched by the Electron host and rejects an undici
 * dispatcher from a different undici copy ("invalid onRequestStart method").
 * Delegating to `undici.fetch` with that same dispatcher, from the copy this
 * module imported, does work — that is the seam this file exists for.
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

/** A dispatcher used when a route says "direct". */
let directDispatcher

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
 * @param {{ kind: 'unrouted' | 'direct' | 'proxy', url?: string } | undefined} route the decision.
 * @param {() => T} fn the work that issues the request.
 * @returns {T} whatever `fn` returns.
 */
export function runWithRoute(route, fn) {
  if (route === undefined || route.kind === 'unrouted') return fn()
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
 * The wrapper is inert unless an ambient route is present, and a route only
 * ever comes from the `llm/stream` listener. That is the whole mechanism behind
 * this plugin's scope: a request that is not an LLM call has no ambient route,
 * so it takes the original `fetch` and reaches the network exactly as it would
 * have without the plugin installed.
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
    // No ambient route means "not a model call": leave it completely alone,
    // including any dispatcher the launcher installed from the environment.
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
 * A short description of the proxies currently open, for the panel.
 *
 * There is no process-wide policy to report, because this plugin never touches
 * the global dispatcher. The only state worth showing is which proxy
 * connections it has opened for model traffic.
 *
 * @returns {string} the active proxy URLs, or a phrase when there are none.
 */
export function describeActive() {
  if (undici === undefined) return 'transport 未加载'
  if (dispatchers.size === 0) return '尚未建立代理连接'
  return [...dispatchers.keys()].map((url) => `proxy ${url}`).join(', ')
}

/**
 * Close every dispatcher this plugin created.
 *
 * Only its own are closed. The launcher's dispatcher was never replaced, so
 * there is nothing to restore: removing this plugin returns the process to
 * exactly the network behaviour it had before the plugin loaded.
 *
 * @returns {Promise<void>} resolves once each dispatcher has drained.
 */
export async function disposeTransport() {
  const closing = [...dispatchers.values(), directDispatcher].filter((entry) => entry !== undefined)
  dispatchers.clear()
  directDispatcher = undefined

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
