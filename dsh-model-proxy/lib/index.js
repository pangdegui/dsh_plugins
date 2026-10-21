/**
 * `dsh-model-proxy` — Host half.
 *
 * **One capability: send the models you tick through the proxy you configure.**
 * A request is matched by model id against the ticked list; a match is tunnelled
 * through the proxy, and anything else is left exactly as it was. Nothing else
 * in the process changes.
 *
 * That scope is the whole point, and it is why there is no global switch here.
 * The official `@deepseek-ai/dsh-http-proxy` installs one process-wide undici
 * dispatcher at launch; re-installing it would move *every* request — web
 * fetches, plugin installs, telemetry — while the configuration only ever talks
 * about models. So the plugin never calls `setGlobalDispatcher`: it attaches a
 * decision to one `llm/stream` call with `AsyncLocalStorage`, and the `fetch`
 * wrapper it installs is inert for anything without such a decision.
 *
 * Deliberate boundaries:
 *
 *   - The configuration UI is a **Settings section** (`设置 → 模型代理`, see
 *     `lib/client.js`). A proxy is ordinary configuration and belongs where
 *     configuration lives, not on a URL you have to know.
 *   - The plugin never imports `@deepseek-ai/dsh-http-proxy`. That package's
 *     route bookkeeping lives in module-level state, so a second copy would see
 *     a different policy; this plugin owns its own state instead.
 *   - A model that is not ticked is left alone rather than forced direct. "Left
 *     alone" means the request keeps the network path it would have had without
 *     this plugin, including a proxy the launcher installed from the environment.
 */

import { APPLY_PATH, MODELS_PATH, PANEL_PATH, STATUS_PATH, name as pluginName } from './constants.js'
import { normalizeConfig, toRules, validateUserConfig } from './config.js'
import { decideRoute } from './rules.js'
import {
  describeActive,
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

/**
 * Read the JSON body the settings page posts.
 *
 * The page sends a structure, not a form: the shape is small and typed, so JSON
 * is the honest encoding and the client needs no encoder at all.
 *
 * @param {string} body the raw request body.
 * @returns {{ config: object }} the submitted config, already normalized.
 */
function configFromJson(body) {
  let parsed
  try {
    parsed = JSON.parse(body === '' ? '{}' : body)
  } catch (error) {
    throw new Error(`请求不是有效的 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求内容必须是一个对象')
  }
  return { config: normalizeConfig(parsed) }
}

// --- plugin ------------------------------------------------------------------

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx the plugin context.
 * @param {unknown} rawConfig this entry's config.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  let config = normalizeConfig(rawConfig)
  /** Set while a save is in flight, so the page never reads a half-applied state. */
  let applying = false

  const transportReady = { ok: false, problems: ['transport not loaded yet'] }

  /**
   * Write one routing decision to the Host log when the user asked for it.
   *
   * This is a diagnostic switch, not a history: nothing is retained for the
   * settings page, which renders only the current configuration.
   *
   * @param {string} text the line to log.
   */
  const trace = (text) => {
    if (config.log) ctx.logger?.info?.(`model-proxy: ${text}`)
  }

  /** The rules the current config compiles to; recomputed whenever it changes. */
  let rules = toRules(config)

  /**
   * Persist a config through the profile's own editor, so a page write survives
   * a restart.
   *
   * `configEditor.edit()` is what the official settings pages use: it validates
   * the config through the plugin's `internal/config` waterfall, writes the row
   * into `cordis.patch.yml` atomically, and then lets the Loader reconcile. That
   * last part means this plugin is reloaded — the in-memory config is replaced by
   * whatever the Loader reads back, which is the behaviour we want, because the
   * file is the single source of truth.
   *
   * @param {object} next the validated config to write.
   * @returns {Promise<{ ok: boolean, text: string }>} the outcome, user-facing.
   */
  const persist = async (next) => {
    const editor = ctx.get('configEditor')
    if (editor === undefined || typeof editor.edit !== 'function') {
      return { ok: false, text: '配置编辑器不可用：改动只在本次运行内生效，重启后会丢失。' }
    }
    let entry
    try {
      const entries = editor.entries()
      entry = entries.find((candidate) => candidate.options.id === pluginName)
        ?? entries.find((candidate) => candidate.options.name === 'dsh-model-proxy')
    } catch (error) {
      return { ok: false, text: `无法定位本插件的配置条目：${error instanceof Error ? error.message : String(error)}` }
    }
    if (entry === undefined) {
      return { ok: false, text: '没有可写的配置条目：本插件不是以可配置行加载的。' }
    }
    try {
      await editor.edit(entry, () => next)
      return { ok: true, text: '已保存到配置文件，重启后仍然生效。' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, text: `写入配置文件失败：${message}` }
    }
  }

  /**
   * Resolve a model request to a routing decision.
   *
   * @param {{ provider?: string, model?: string }} options the waterfall payload.
   * @returns {object} the decision.
   */
  const decide = (options) => {
    const decision = decideRoute({ rules, proxies: {}, provider: options?.provider, model: options?.model })
    const detail = decision.kind === 'proxy' ? ` -> ${decision.url}` : ''
    trace(`${decision.kind}${detail} (${decision.from}) ${options?.model ?? ''}`.trim())
    return decision
  }

  // --- the waterfall listener ------------------------------------------------
  // Only `llm/stream` is intercepted, which is what keeps the plugin's effect
  // confined to model traffic. A call no rule matches returns the downstream
  // generator untouched, so it keeps its original network path.
  const disposeStream = ctx.on(
    'llm/stream',
    (options, next) => {
      const decision = decide(options)
      const source = next()
      if (decision.kind === 'unrouted') return source

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

  // --- the routes the settings page talks to ---------------------------------
  ctx.inject(['webServer'], (webCtx) => {
    /**
     * The models this deployment offers, grouped by provider.
     *
     * Read on every request rather than cached: a provider added while the page
     * is open should show up on the next refresh, and the adapters answer from
     * their own catalogs, so this costs no network call.
     *
     * A provider whose adapter throws is reported with an empty list instead of
     * failing the whole read — one broken route must not hide the other ten.
     *
     * @returns {Promise<Array<{ provider: string, name: string, models: Array<{ id: string, name: string }> }>>}
     */
    const listModels = async () => {
      const llm = webCtx.get('llm')
      if (llm === undefined || typeof llm.listProviders !== 'function') return []

      let providers = []
      try {
        providers = llm.listProviders()
      } catch {
        return []
      }

      const groups = await Promise.all(
        (Array.isArray(providers) ? providers : []).map(async (provider) => {
          const id = typeof provider?.id === 'string' ? provider.id : ''
          if (id === '') return null
          const name = typeof provider?.name === 'string' && provider.name !== '' ? provider.name : id
          let models = []
          if (typeof llm.listModels === 'function') {
            try {
              const listed = await llm.listModels(id)
              models = (Array.isArray(listed) ? listed : [])
                .map((model) => ({
                  id: typeof model?.id === 'string' ? model.id : '',
                  name: typeof model?.name === 'string' && model.name !== '' ? model.name : String(model?.id ?? ''),
                }))
                .filter((model) => model.id !== '')
            } catch {
              models = []
            }
          }
          return { provider: id, name, models }
        }),
      )

      return groups.filter((group) => group !== null)
    }

    /** A config as the page renders it, plus what it compiles to. */
    const viewOf = (source = config) => ({
      proxy: source.proxy,
      models: source.models,
      log: source.log,
      ruleCount: toRules(source).length,
    })

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
          active: describeActive(),
          ...viewOf(),
        })
        return
      }

      if (path === MODELS_PATH && req.method === 'GET') {
        sendJson(res, 200, { ok: true, providers: await listModels() })
        return
      }

      // The configuration UI is the Settings section now (`lib/client.js`). The
      // bare path redirects so an old bookmark still lands somewhere useful
      // instead of showing a second, divergent form.
      if (path === PANEL_PATH && req.method === 'GET') {
        res.writeHead(303, {
          'cache-control': 'no-store',
          location: '/',
          'content-type': 'text/plain; charset=utf-8',
        })
        res.end('模型代理由「设置 → 模型代理」配置。\n')
        return
      }

      if (path === APPLY_PATH && req.method === 'POST') {
        if (applying) {
          sendJson(res, 409, { ok: false, error: 'another save is in progress' })
          return
        }
        applying = true
        try {
          const { config: submitted } = configFromJson(await readBody(req))
          const problems = validateUserConfig(submitted)

          if (problems.length > 0) {
            sendJson(res, 400, { ok: false, error: problems.join('; '), problems })
            return
          }

          // Write first, then adopt: the config editor persists the row and the
          // Loader reloads this plugin, so committing in memory before the write
          // could show a state the file does not have.
          const outcome = await persist(submitted)
          if (!outcome.ok) {
            // Still apply for this run — the user changed something and expects
            // to see it work — but say plainly that it will not survive a restart.
            config = submitted
            rules = toRules(config)
            trace(`config applied in memory only: rules=${String(rules.length)}`)
          } else {
            trace(`config saved: rules=${String(toRules(submitted).length)}`)
          }
          sendJson(res, outcome.ok ? 202 : 200, {
            ok: true,
            persisted: outcome.ok,
            message: outcome.text,
            // Report what was submitted, not the state this closure still holds:
            // a persisted write reloads the plugin, so `config` here is already
            // stale by the time the response is built.
            ...viewOf(submitted),
          })
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error)
          sendJson(res, 400, { ok: false, error: text })
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
        webCtx.webServer.register({ kind: 'exact', path: MODELS_PATH, handler }),
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'model-proxy: routes')
  })

  // --- startup ---------------------------------------------------------------
  // Loading the transport waits for boot to settle: a failed probe must be
  // reported, not thrown, so the panel can explain it instead of the plugin
  // parking the profile.
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
      ctx.logger?.info?.(`model-proxy: routing ${String(rules.length)} model(s) for model traffic only`)
    })()
    return () => {
      cancelled = true
    }
  }, 'model-proxy: startup')

  // This plugin never installs a process-wide dispatcher, so teardown only has
  // to close the connections it opened. The launcher's own path is untouched.
  ctx.effect(() => () => {
    void disposeTransport()
  }, 'model-proxy: teardown')
}
