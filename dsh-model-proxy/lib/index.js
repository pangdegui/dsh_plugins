/**
 * `dsh-model-proxy` — Host half.
 *
 * Two capabilities, one plugin:
 *
 *   1. **Global proxy switch.** Replaces the process-wide undici dispatcher at
 *      runtime, so a proxy can be turned on, changed, or turned off without
 *      restarting the app. Verified against the runtime: the disposer semantics
 *      the official launcher relies on work at any time, not only at boot.
 *
 *   2. **Per-model routing.** Intercepts the `llm/stream` waterfall, resolves a
 *      rule from `options.provider` / `options.model`, and carries that decision
 *      into the request through `AsyncLocalStorage` (see `transport.js`). This is
 *      the only way to give two models on the same endpoint different proxies:
 *      a process-wide dispatcher has exactly one answer.
 *
 * Deliberate boundaries:
 *
 *   - The panel is a route of its own (`/model-proxy`), not a Settings page.
 *     `dsh-host-apiproxy` serves settings namespaces from a hard-coded
 *     whitelist, so a third-party namespace answers `settings-not-exposed`.
 *   - The plugin never imports `@deepseek-ai/dsh-http-proxy`. That package's
 *     route bookkeeping lives in module-level state, so a second copy would see
 *     a different policy; `globalThis`'s dispatcher symbol is the only state
 *     that crosses copies, and this plugin owns its own.
 *   - A loopback request is always direct. Proxying the harness's own Web UI or
 *     connection transport would form a routing loop.
 */

import { name as pluginName, APPLY_PATH, PANEL_PATH, STATUS_PATH } from './constants.js'
import { decideRoute, validateConfig, parseNoProxy } from './rules.js'
import { renderPanel } from './panel.js'
import {
  applyGlobalPolicy,
  captureBaseline,
  describeGlobal,
  disposeTransport,
  installFetchWrapper,
  loadTransport,
  runWithRoute,
} from './transport.js'

export { pluginName as name }

/**
 * Declared as soft dependencies: the Host composes them, but a profile without
 * one still loads this plugin (it simply offers fewer features) instead of
 * parking on an unsatisfied injection.
 */
export const inject = []

/** Roll-up of the last few routing decisions, for the panel. */
const RECENT_LIMIT = 20

/**
 * Copy the entry config into the shape the rest of the plugin uses.
 *
 * Every field is coerced to its exact expected type. `??` alone is not enough:
 * a hand-edited patch can hand back a non-string, and one of those reaching the
 * transport turns a valid setting into a rejected write.
 *
 * @param {unknown} raw the entry config.
 * @returns {object} the resolved config.
 */
function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const global = source.global !== null && typeof source.global === 'object' ? source.global : {}

  const proxies = {}
  if (source.proxies !== null && typeof source.proxies === 'object' && !Array.isArray(source.proxies)) {
    for (const [key, value] of Object.entries(source.proxies)) {
      if (typeof value === 'string' && value.trim() !== '') proxies[key] = value.trim()
    }
  }

  const rules = Array.isArray(source.rules)
    ? source.rules
        .filter((rule) => rule !== null && typeof rule === 'object')
        .map((rule) => {
          const entry = { proxy: rule.proxy }
          for (const field of ['provider', 'model', 'host']) {
            if (typeof rule[field] === 'string' && rule[field].trim() !== '') entry[field] = rule[field].trim()
          }
          return entry
        })
    : []

  return {
    global: {
      mode: typeof global.mode === 'string' ? global.mode.toLowerCase() : 'system',
      url: typeof global.url === 'string' ? global.url.trim() : '',
      noProxy: typeof global.noProxy === 'string' ? global.noProxy : '',
    },
    proxies,
    rules,
    defaultMode: typeof source.defaultMode === 'string' ? source.defaultMode.toLowerCase() : 'system',
    log: source.log === true,
  }
}

/**
 * Read a form body into a config object.
 *
 * The panel sends a plain form; the rules and proxies fields are one entry per
 * line, which is friendlier than JSON and impossible to get subtly wrong with a
 * trailing comma.
 *
 * @param {URLSearchParams} form the submitted fields.
 * @returns {{ config: object, reset: boolean }} the parsed config and whether this was a reset.
 */
function configFromForm(form) {
  const reset = form.get('action') === 'reset'

  const proxies = {}
  for (const line of String(form.get('proxies') ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf(':')
    // `http://host:port` has a colon too, so split on the FIRST one and treat
    // the remainder as the URL; a named entry therefore needs `name: url`.
    if (separator === -1) continue
    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()
    if (key !== '' && value !== '') proxies[key] = value
  }

  const rules = []
  for (const line of String(form.get('rules') ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const rule = {}
    // Fields are `key: value` pairs separated by whitespace. A model id or URL
    // may itself contain a colon, so consume up to the next ` key:` boundary.
    const pattern = /(provider|model|host|proxy)\s*:\s*([\s\S]*?)(?=\s+(?:provider|model|host|proxy)\s*:|$)/g
    for (const match of trimmed.matchAll(pattern)) {
      rule[match[1]] = match[2].trim()
    }
    if (Object.keys(rule).length > 0) rules.push(rule)
  }

  if (reset) {
    return {
      reset: true,
      config: {
        global: { mode: 'direct', url: '', noProxy: '' },
        proxies: {},
        rules: [],
        defaultMode: 'system',
        log: false,
      },
    }
  }

  return {
    reset: false,
    config: {
      global: {
        mode: String(form.get('globalMode') ?? 'system').toLowerCase(),
        url: String(form.get('globalUrl') ?? '').trim(),
        noProxy: String(form.get('noProxy') ?? '').trim(),
      },
      proxies,
      rules,
      defaultMode: String(form.get('defaultMode') ?? 'system').toLowerCase(),
      log: form.get('log') === 'on',
    },
  }
}

// --- HTTP helpers ------------------------------------------------------------

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // No scripts at all: every action is a form POST back to this route.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
  })
  res.end(html)
}

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

/**
 * Reuse the connection layer's own Host/Origin fence rather than reimplementing
 * it, so a rebound or cross-site caller is refused before any handler runs.
 *
 * @returns {number | undefined} the rejection status, or undefined when trusted.
 */
function fence(ctx, req) {
  const connection = ctx.get('connection')
  if (connection === undefined || typeof connection.requestRejection !== 'function') return 403
  try {
    return connection.requestRejection(req)
  } catch {
    return 403
  }
}

function readBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// --- plugin ------------------------------------------------------------------

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx the plugin context.
 * @param {unknown} rawConfig this entry's config.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  let config = resolveConfig(rawConfig)
  const recent = []
  /** Set while a save is in flight, so the panel never reads a half-applied state. */
  let applying = false

  const transportReady = { ok: false, problems: ['transport not loaded yet'] }

  /**
   * Append one decision to the recent list the panel shows.
   *
   * @param {string} text the line to keep.
   */
  const remember = (text) => {
    recent.push(text)
    if (recent.length > RECENT_LIMIT) recent.shift()
    if (config.log) ctx.logger?.info?.(`model-proxy: ${text}`)
  }

  /**
   * Apply the global layer and report what happened.
   *
   * @returns {{ ok: boolean, text: string }} the outcome, already user-facing.
   */
  const applyGlobal = () => {
    if (!transportReady.ok) {
      return { ok: false, text: `代理传输不可用：${transportReady.problems.join('；')}` }
    }
    const noProxy = parseNoProxy(config.global.noProxy)
    // Publish the bypass list for the code paths that read the environment
    // rather than a policy object, and for spawned children. The dispatcher
    // itself does not consult it; the route decision does.
    const result = applyGlobalPolicy({
      mode: config.global.mode,
      url: config.global.url,
      noProxy,
    })
    if (!result.ok) return { ok: false, text: `全局代理未应用：${result.reason}` }
    return { ok: true, text: `全局代理已应用：${result.applied}` }
  }

  /**
   * Resolve a request to a routing decision.
   *
   * @param {{ provider?: string, model?: string }} options the waterfall payload.
   * @param {string | undefined} host the request host, when known.
   * @returns {object} the decision, plus the label to remember.
   */
  const decide = (options, host) => {
    const decision = decideRoute({
      noProxy: parseNoProxy(config.global.noProxy),
      rules: config.rules,
      proxies: config.proxies,
      defaultMode: config.defaultMode,
      provider: options?.provider,
      model: options?.model,
      host,
    })
    const detail = decision.kind === 'proxy' ? ` -> ${decision.url}` : ''
    remember(`${decision.kind}${detail} (${decision.from}) ${options?.model ?? host ?? ''}`.trim())
    return decision
  }

  // --- the waterfall listener ------------------------------------------------
  // Only `llm/stream` is intercepted. Model discovery (`GET /models`) issues its
  // fetch inside pi-ai with no provider context, so it can only be matched by a
  // `host` rule; that is a documented limitation rather than a silent gap.
  const disposeStream = ctx.on(
    'llm/stream',
    (options, next) => {
      const decision = decide(options, undefined)
      const source = next()
      if (decision.kind === 'inherit') return source

      // Every `next()` runs inside the ambient route, so the fetch the adapter
      // issues while the generator advances sees this decision and no other.
      return (async function* routed() {
        const iterator = source[Symbol.asyncIterator]()
        let exhausted = false
        try {
          while (true) {
            const step = await runWithRoute(decision, () => iterator.next())
            if (step.done === true) {
              exhausted = true
              return
            }
            yield step.value
          }
        } finally {
          if (!exhausted) await iterator.return?.(undefined).catch(() => {})
        }
      })()
    },
    { global: true, prepend: true },
  )
  ctx.effect(() => disposeStream, 'model-proxy: llm/stream')

  // --- the fetch wrapper -----------------------------------------------------
  ctx.effect(() => {
    const dispose = installFetchWrapper()
    return () => dispose()
  }, 'model-proxy: fetch wrapper')

  // --- the panel -------------------------------------------------------------
  ctx.inject(['webServer'], (webCtx) => {
    const handler = async (req, res) => {
      const rejection = fence(webCtx, req)
      if (rejection !== undefined) {
        sendJson(res, rejection === 401 ? 401 : 403, { ok: false, error: rejection === 401 ? 'unauthenticated' : 'forbidden' })
        return
      }

      const path = String(req.url ?? '').split('?')[0]

      if (path === STATUS_PATH && req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          transport: transportReady.ok,
          problems: transportReady.problems,
          global: { ...config.global, active: describeGlobal() },
          defaultMode: config.defaultMode,
          proxies: config.proxies,
          rules: config.rules,
          recent,
        })
        return
      }

      if (path === PANEL_PATH && req.method === 'GET') {
        sendHtml(res, 200, renderPanel({
          config,
          activeGlobal: describeGlobal(),
          problems: [...transportReady.problems, ...validateConfig(config)],
          recent,
          message: null,
        }))
        return
      }

      if (path === APPLY_PATH && req.method === 'POST') {
        if (applying) {
          sendHtml(res, 409, renderPanel({
            config,
            activeGlobal: describeGlobal(),
            problems: [],
            recent,
            message: { kind: 'error', text: '另一个保存正在进行，请稍后重试。' },
          }))
          return
        }
        applying = true
        try {
          const body = await readBody(req)
          const form = new URLSearchParams(body)
          const parsed = configFromForm(form)
          const next = resolveConfig(parsed.config)
          const problems = validateConfig(next)

          if (problems.length > 0) {
            sendHtml(res, 400, renderPanel({
              config: next,
              activeGlobal: describeGlobal(),
              problems,
              recent,
              message: { kind: 'error', text: '配置未应用，请先修正上面的问题。' },
            }))
            return
          }

          // Only commit once the new config is known to be usable, so a bad
          // form leaves the running policy exactly as it was.
          config = next
          const outcome = applyGlobal()
          remember(`config saved: global=${config.global.mode} rules=${config.rules.length}`)
          sendHtml(res, 200, renderPanel({
            config,
            activeGlobal: describeGlobal(),
            problems: [],
            recent,
            message: { kind: outcome.ok ? 'ok' : 'error', text: outcome.text },
          }))
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error)
          sendHtml(res, 400, renderPanel({
            config,
            activeGlobal: describeGlobal(),
            problems: [],
            recent,
            message: { kind: 'error', text: `保存失败：${text}` },
          }))
        } finally {
          applying = false
        }
        return
      }

      sendJson(res, 404, { ok: false, error: 'not found' })
    }

    webCtx.effect(() => {
      const disposers = [
        webCtx.webServer.register({ kind: 'exact', path: PANEL_PATH, handler }),
        webCtx.webServer.register({ kind: 'exact', path: APPLY_PATH, handler }),
        webCtx.webServer.register({ kind: 'exact', path: STATUS_PATH, handler }),
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'model-proxy: routes')
  })

  // --- startup ---------------------------------------------------------------
  // Loading the transport and installing the first policy wait for boot to
  // settle: a failed probe must be reported, not thrown, and captureBaseline()
  // has to observe the launcher's dispatcher before it is replaced.
  ctx.effect(() => {
    let cancelled = false
    void (async () => {
      const loader = ctx.get('loader')
      if (loader !== undefined && typeof loader.await === 'function') {
        try {
          await loader.await()
        } catch {
          /* a failed fiber is reported by the boot audit, not here */
        }
      }
      if (cancelled) return

      const verdict = await loadTransport()
      transportReady.ok = verdict.ok
      transportReady.problems = verdict.problems
      if (!verdict.ok) {
        ctx.logger?.warn?.(`model-proxy: proxy transport unavailable: ${verdict.problems.join('; ')}`)
        return
      }

      captureBaseline()
      const outcome = applyGlobal()
      if (outcome.ok) ctx.logger?.info?.(`model-proxy: ${outcome.text}`)
      else ctx.logger?.warn?.(`model-proxy: ${outcome.text}`)
    })()
    return () => {
      cancelled = true
    }
  }, 'model-proxy: startup')

  // Restoring the launcher's dispatcher on unload keeps a reload from stranding
  // the process on a proxy this plugin created.
  ctx.effect(() => () => {
    void disposeTransport()
  }, 'model-proxy: teardown')
}
