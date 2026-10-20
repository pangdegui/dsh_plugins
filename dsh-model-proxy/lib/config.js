/**
 * `config.js` — the user-facing configuration shape, and how it becomes rules.
 *
 * The stored config is deliberately tiny, because that is what the settings page
 * asks for: **one proxy** plus **the models it applies to**. A general rule
 * language (named proxies, provider/host selectors, per-rule targets) is more
 * power than the question "send these models through that proxy" needs, and it
 * made the page a pair of small textareas.
 *
 * `rules.js` still owns the matching, and this module compiles the small shape
 * into the rules it understands. That keeps one implementation of "does this
 * rule cover this model" — the tested one — while the stored shape stays
 * something a person can read in `cordis.patch.yml`:
 *
 * ```yaml
 * proxy: http://127.0.0.1:10808
 * models:
 *   - deepseek/deepseek-v4.1-flash
 *   - z-ai/glm-5.3-flash
 * log: false
 * ```
 *
 * An empty `proxy`, or an empty `models`, compiles to no rules at all, so the
 * plugin routes nothing and every request keeps the path it already had.
 *
 * @module dsh-model-proxy/config
 */

import { validateProxyUrl } from './rules.js'

/** The fields this plugin stores. Anything else in a patch is ignored. */
export const CONFIG_FIELDS = ['proxy', 'models', 'log']

/**
 * Coerce stored config into the exact shape the rest of the plugin expects.
 *
 * Hand-edited patches are the reason every field is checked rather than
 * trusted: a number where a string belongs would otherwise reach the transport
 * and turn a readable mistake into an opaque failure at request time.
 *
 * The legacy `proxies` / `rules` pair from the first release is migrated rather
 * than dropped, so an existing profile keeps working after the upgrade.
 *
 * @param {unknown} raw the entry config, as the Loader read it.
 * @returns {{ proxy: string, models: string[], log: boolean }} the resolved config.
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const migrated = migrateLegacy(source)

  const proxy = typeof migrated.proxy === 'string' ? migrated.proxy.trim() : ''

  const models = []
  if (Array.isArray(migrated.models)) {
    for (const entry of migrated.models) {
      if (typeof entry !== 'string') continue
      const id = entry.trim()
      if (id === '' || models.includes(id)) continue
      models.push(id)
    }
  }

  return { proxy, models, log: migrated.log === true }
}

/**
 * Read the first release's `{ proxies, rules }` shape as the current one.
 *
 * A legacy rule carries its own `proxy` reference, so several distinct URLs
 * cannot all become "the one proxy". The first rule with a usable URL wins and
 * its `model` fields become the list; anything else is reported as unmigrated
 * by {@link normalizeConfig} simply not appearing.
 *
 * @param {object} source the raw config.
 * @returns {object} the current shape, or `source` unchanged when already current.
 */
function migrateLegacy(source) {
  if (typeof source.proxy === 'string' || source.proxies === undefined) return source

  const proxies = source.proxies !== null && typeof source.proxies === 'object' ? source.proxies : {}
  const rules = Array.isArray(source.rules) ? source.rules : []

  const models = []
  let proxy = ''
  for (const rule of rules) {
    if (rule === null || typeof rule !== 'object') continue
    const reference = typeof rule.proxy === 'string' ? rule.proxy.trim() : ''
    const target = Object.hasOwn(proxies, reference) ? proxies[reference] : reference
    if (proxy === '' && typeof target === 'string' && validateProxyUrl(target).ok) proxy = target
    if (typeof rule.model === 'string' && rule.model.trim() !== '' && !models.includes(rule.model.trim())) {
      models.push(rule.model.trim())
    }
  }

  return { proxy, models, log: source.log }
}

/**
 * Compile the config into the rules `rules.js` matches against.
 *
 * A model listed with no proxy is not a rule: it would mean "route this model
 * nowhere", which is the same as not listing it. Dropping both halves when one
 * is missing is what makes an empty page mean "do nothing".
 *
 * @param {{ proxy: string, models: string[] }} config the resolved config.
 * @returns {Array<{ model: string, proxy: string }>} the rules, in list order.
 */
export function toRules(config) {
  const proxy = typeof config?.proxy === 'string' ? config.proxy.trim() : ''
  const models = Array.isArray(config?.models) ? config.models : []
  if (proxy === '' || models.length === 0) return []
  return models.map((model) => ({ model, proxy }))
}

/**
 * Report what is wrong with a config, in sentences a user can act on.
 *
 * The empty cases are not errors: a fresh install has no proxy and no models,
 * and the page must be able to render that without shouting at the user.
 *
 * @param {{ proxy: string, models: string[] }} config the resolved config.
 * @returns {string[]} one sentence per problem; empty when the config is usable.
 */
export function validateUserConfig(config) {
  const problems = []
  const proxy = typeof config?.proxy === 'string' ? config.proxy.trim() : ''
  const models = Array.isArray(config?.models) ? config.models : []

  if (proxy === '') {
    if (models.length > 0) problems.push(`已勾选 ${String(models.length)} 个模型，但没有填写代理地址。`)
    return problems
  }

  const checked = validateProxyUrl(proxy)
  if (!checked.ok) problems.push(`代理地址无效：${checked.reason}`)

  return problems
}

/**
 * Whether a config would route anything at all.
 *
 * @param {{ proxy: string, models: string[] }} config the resolved config.
 * @returns {boolean} true when at least one model is covered.
 */
export function isActive(config) {
  return toRules(config).length > 0
}
