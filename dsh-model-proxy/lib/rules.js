/**
 * `rules.js` — pure routing logic, no Cordis, no undici, no I/O.
 *
 * Kept separate so the matching rules can be unit-tested by hand and so this
 * module stays loadable where no transport exists. Everything here is a total
 * function over plain data: the same inputs always produce the same decision.
 *
 * @module dsh-model-proxy/rules
 */

/** Schemes a proxy URL may use. SOCKS and PAC are refused, never silently dropped. */
export const SUPPORTED_PROXY_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * The rule fields that can decide a route.
 *
 * Only model identity is here — no host. A host rule would have to be evaluated
 * on requests this plugin never sees a model for (model discovery, web fetch),
 * and covering those is exactly what "proxy for models only" rules out.
 */
export const RULE_FIELDS = ['provider', 'model']

/**
 * Parse a proxy URL, refusing anything the transport cannot route.
 *
 * @param {unknown} raw the candidate URL.
 * @returns {{ ok: true, url: string } | { ok: false, reason: string }}
 */
export function validateProxyUrl(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'not a string' }
  const value = raw.trim()
  if (value === '') return { ok: false, reason: 'empty' }

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, reason: 'not a valid URL' }
  }

  if (/^socks/i.test(parsed.protocol)) {
    return { ok: false, reason: `${parsed.protocol}// is a SOCKS proxy, which is not supported; use http:// or https://` }
  }
  if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: `unsupported scheme ${parsed.protocol}//; use http:// or https://` }
  }
  return { ok: true, url: value }
}

/**
 * Compile one `proxy` reference into a concrete URL.
 *
 * A reference is either a name in `proxies` or a literal URL, so a one-off rule
 * needs no dictionary entry. `direct` is accepted because a rule may want to
 * pull one model out of a proxy the others use.
 *
 * @param {unknown} reference the configured value.
 * @param {Record<string, string>} proxies named proxy URLs.
 * @returns {{ ok: true, url: string } | { ok: false, reason: string }}
 */
export function resolveProxyReference(reference, proxies) {
  if (typeof reference !== 'string' || reference.trim() === '') {
    return { ok: false, reason: 'empty proxy reference' }
  }
  const value = reference.trim()
  if (Object.hasOwn(proxies, value)) {
    return validateProxyUrl(proxies[value])
  }
  // `direct` is a mode, not a URL; a rule may use it.
  if (value.toLowerCase() === 'direct') {
    return { ok: true, url: 'direct' }
  }
  return validateProxyUrl(value)
}

/**
 * Whether one rule matches a request.
 *
 * Every field the rule declares must match; a rule with no fields matches
 * everything and therefore acts as a catch-all. `model` accepts the bare model
 * id (`deepseek-v4-flash`) or the VS Code style `model@endpoint` form, because
 * the waterfall receives the former while the model picker shows the latter.
 *
 * @param {object} rule one configured rule.
 * @param {{ provider?: string, model?: string }} request what is known about this request.
 * @returns {boolean} true when every declared field agrees.
 */
export function ruleMatches(rule, request) {
  if (rule === null || typeof rule !== 'object') return false

  let declared = 0

  if (rule.provider !== undefined) {
    declared += 1
    if (String(request.provider ?? '') !== String(rule.provider)) return false
  }

  if (rule.model !== undefined) {
    declared += 1
    if (!modelMatches(String(rule.model), String(request.model ?? ''))) return false
  }

  // A rule that constrains nothing would swallow every request; require at
  // least one field so a typo cannot silently become a global override.
  return declared > 0
}

/**
 * Compare a configured model pattern against a request's model id.
 *
 * Exact match, or the same bare id with a different `@endpoint` suffix. A
 * trailing `*` does a prefix match, which is how one rule covers a family such
 * as `deepseek/*`.
 *
 * @param {string} pattern the configured model field.
 * @param {string} actual the model id on the request.
 * @returns {boolean} true when the pattern covers the id.
 */
function modelMatches(pattern, actual) {
  if (pattern === actual) return true
  if (pattern.endsWith('*')) return actual.startsWith(pattern.slice(0, -1))
  const bare = (value) => (value.includes('@') ? value.slice(0, value.indexOf('@')) : value)
  return bare(pattern) === bare(actual)
}

/**
 * Decide how to send one model request.
 *
 * Resolution order, first hit wins:
 *   1. a rule matches → its proxy, or `direct`
 *   2. nothing matched → `unrouted`, i.e. leave the request alone
 *
 * `unrouted` is the important default and not an alias for `direct`: it means
 * the wrapper does not touch this request at all, so it takes the same network
 * path it would have taken without the plugin — normally the launcher's
 * environment proxy. Returning `direct` here would silently override a proxy the
 * user configured elsewhere, which is not this plugin's decision to make.
 *
 * The result is one of three shapes so the caller never has to invent a meaning
 * for an empty string:
 *   - `{ kind: 'unrouted' }` — do not touch the request
 *   - `{ kind: 'direct' }`  — bypass every proxy for this model
 *   - `{ kind: 'proxy', url }` — tunnel this model through this proxy
 *
 * @param {object} options the resolved configuration plus request facts.
 * @returns {{ kind: 'unrouted', from: string } | { kind: 'direct', from: string } | { kind: 'proxy', url: string, from: string }}
 */
export function decideRoute({ rules = [], proxies = {}, provider, model }) {
  const request = { provider, model }

  for (const [index, rule] of rules.entries()) {
    if (!ruleMatches(rule, request)) continue
    const target = resolveProxyReference(rule.proxy, proxies)
    if (!target.ok) {
      // A broken rule must not silently become "no proxy": report it as
      // unrouted so the request keeps whatever path it already had.
      return { kind: 'unrouted', from: `rule#${index + 1}-invalid: ${target.reason}` }
    }
    if (target.url === 'direct') return { kind: 'direct', from: `rule#${index + 1}` }
    return { kind: 'proxy', url: target.url, from: `rule#${index + 1}` }
  }

  return { kind: 'unrouted', from: 'no-rule' }
}

/**
 * Report every structural problem in a configuration, so the panel can show
 * them instead of the plugin failing to load.
 *
 * @param {object} config the entry config.
 * @returns {string[]} one sentence per problem; empty when the config is usable.
 */
export function validateConfig(config) {
  const problems = []
  if (config === null || typeof config !== 'object') return ['config must be an object']

  for (const [name, url] of Object.entries(config.proxies ?? {})) {
    const checked = validateProxyUrl(url)
    if (!checked.ok) problems.push(`proxies.${name}: ${checked.reason}`)
  }

  const rules = Array.isArray(config.rules) ? config.rules : []
  if (config.rules !== undefined && !Array.isArray(config.rules)) {
    problems.push('rules must be an array')
  }
  for (const [index, rule] of rules.entries()) {
    const label = `rules[${index + 1}]`
    if (rule === null || typeof rule !== 'object') {
      problems.push(`${label}: must be an object`)
      continue
    }
    const fields = ['provider', 'model'].filter((field) => rule[field] !== undefined)
    if (fields.length === 0) {
      problems.push(`${label}: needs at least one of provider / model`)
    }
    if (rule.proxy === undefined) {
      problems.push(`${label}: needs a proxy`)
      continue
    }
    const target = resolveProxyReference(rule.proxy, config.proxies ?? {})
    if (!target.ok) problems.push(`${label}.proxy: ${target.reason}`)
  }

  return problems
}
