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
 * Loopback hosts are never proxied. This mirrors the official policy in
 * `@deepseek-ai/dsh-http-proxy`, and it is not optional: proxying the harness's
 * own Web UI or connection transport turns them into a routing loop.
 *
 * Both `::1` and `[::1]` are listed because a bare `::1` is read by some
 * matchers as host `:` port `1`.
 */
export const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

/** The three global modes, plus `proxy`, which carries a URL. */
export const GLOBAL_MODES = new Set(['system', 'direct', 'proxy'])

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
 * Normalize one entry of the `noProxy` list. Accepts the comma/space separated
 * string a person writes and returns its non-empty entries.
 *
 * @param {unknown} raw the bypass list as configured.
 * @returns {string[]} the entries, trimmed, in the order written.
 */
export function parseNoProxy(raw) {
  if (typeof raw !== 'string') return []
  return raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/**
 * Whether `hostname` is a loopback literal or name.
 *
 * @param {string} hostname a URL's hostname, without a port.
 * @returns {boolean} true when the address must stay direct.
 */
export function isLoopback(hostname) {
  const host = String(hostname ?? '').toLowerCase()
  if (LOOPBACK_HOSTNAMES.has(host)) return true
  // 127.0.0.0/8 — the whole block is loopback, not just 127.0.0.1.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  // IPv4-mapped loopback, e.g. ::ffff:127.0.0.1
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  return false
}

/**
 * Whether `url` is exempted by a `noProxy` list entry.
 *
 * A bare entry matches that host and every subdomain of it, so `example.com`
 * also bypasses `api.example.com`. A leading `.` or `*.` is accepted and means
 * the same thing. An entry may carry `:port`, and `*` bypasses everything.
 * CIDR ranges are deliberately not matched: `noProxy` entries name hosts, and a
 * range would have to be rewritten as a suffix anyway.
 *
 * @param {string[]} entries the bypass list from {@link parseNoProxy}.
 * @param {URL} url the request URL.
 * @returns {boolean} true when the request must not be proxied.
 */
export function bypassesProxy(entries, url) {
  if (entries.length === 0) return false
  const host = stripBrackets(url.hostname.toLowerCase())
  const port = url.port === '' ? defaultPort(url.protocol) : Number(url.port)

  for (const entry of entries) {
    if (entry === '*') return true

    // `[::1]:8080` — an IPv6 literal with an optional port.
    let pattern = entry.toLowerCase()
    let entryPort = 0
    if (pattern.startsWith('[')) {
      const closing = pattern.indexOf(']')
      if (closing !== -1) {
        const rest = pattern.slice(closing + 1)
        pattern = stripBrackets(pattern.slice(0, closing + 1))
        if (rest.startsWith(':')) {
          const parsed = Number.parseInt(rest.slice(1), 10)
          entryPort = Number.isNaN(parsed) ? 0 : parsed
        }
      }
    } else if (pattern.includes(':') && pattern.split(':').length === 2) {
      const [name, rawPort] = pattern.split(':')
      const parsed = Number.parseInt(rawPort, 10)
      if (!Number.isNaN(parsed)) {
        pattern = name
        entryPort = parsed
      }
    } else {
      pattern = stripBrackets(pattern)
    }

    if (entryPort !== 0 && entryPort !== port) continue

    if (pattern.startsWith('*.')) pattern = pattern.slice(2)
    else if (pattern.startsWith('.') || pattern.startsWith('*')) pattern = pattern.slice(1)
    if (pattern === '') continue

    if (host === pattern) return true
    if (host.endsWith(`.${pattern}`)) return true
  }
  return false
}

/**
 * The default port of a URL scheme, for a `noProxy` entry that names one.
 *
 * @param {string} protocol a URL protocol, e.g. `https:`.
 * @returns {number} the port the scheme implies.
 */
function defaultPort(protocol) {
  return protocol === 'https:' ? 443 : 80
}

/**
 * Strip the square brackets a URL puts around an IPv6 literal.
 *
 * @param {string} host a hostname, possibly bracketed.
 * @returns {string} the bare host.
 */
function stripBrackets(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/**
 * Compile one `proxy` reference into a concrete URL.
 *
 * A reference is either a name in `proxies` or a literal URL, so a one-off rule
 * needs no dictionary entry.
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
  // `direct` / `system` are modes, not URLs; a rule may use them too.
  const lowered = value.toLowerCase()
  if (lowered === 'direct' || lowered === 'system') {
    return { ok: true, url: lowered }
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
 * @param {{ provider?: string, model?: string, host?: string }} request what is known about this request.
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

  if (rule.host !== undefined) {
    declared += 1
    if (!hostMatches(String(rule.host), String(request.host ?? ''))) return false
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
 * Compare a configured host against a request's host.
 *
 * Exact, a `*.suffix` wildcard, or a `host:port` form.
 *
 * @param {string} pattern the configured host field.
 * @param {string} actual the request host, possibly with a port.
 * @returns {boolean} true when the pattern covers the host.
 */
function hostMatches(pattern, actual) {
  if (pattern === actual) return true
  if (pattern.startsWith('*.')) return actual.endsWith(pattern.slice(1))
  const bareHost = (value) => (value.includes(':') ? value.slice(0, value.indexOf(':')) : value)
  return bareHost(pattern) === bareHost(actual)
}

/**
 * Decide how to send one request.
 *
 * Resolution order, first hit wins:
 *   1. loopback host → `direct` (never proxied, not configurable)
 *   2. `noProxy` list → `direct`
 *   3. the first matching rule
 *   4. `defaultMode`
 *
 * The result is deliberately one of three shapes so the caller never has to
 * invent a meaning for an empty string:
 *   - `{ kind: 'inherit' }` — leave whatever the global layer installed
 *   - `{ kind: 'direct' }`  — bypass, including any global policy
 *   - `{ kind: 'proxy', url }` — tunnel through this proxy
 *
 * @param {object} options the resolved configuration plus request facts.
 * @returns {{ kind: 'inherit' } | { kind: 'direct' } | { kind: 'proxy', url: string, from: string }}
 */
export function decideRoute({ noProxy = [], rules = [], proxies = {}, defaultMode = 'system', provider, model, host }) {
  const request = { provider, model, host }

  if (host !== undefined && isLoopback(host)) {
    return { kind: 'direct', from: 'loopback' }
  }

  if (host !== undefined) {
    let url
    try {
      url = new URL(`http://${host}`)
    } catch {
      url = undefined
    }
    if (url !== undefined && bypassesProxy(noProxy, url)) {
      return { kind: 'direct', from: 'noProxy' }
    }
  }

  for (const [index, rule] of rules.entries()) {
    if (!ruleMatches(rule, request)) continue
    const target = resolveProxyReference(rule.proxy, proxies)
    if (!target.ok) {
      return { kind: 'inherit', from: `rule#${index + 1}-invalid: ${target.reason}` }
    }
    if (target.url === 'direct') return { kind: 'direct', from: `rule#${index + 1}` }
    if (target.url === 'system') return { kind: 'inherit', from: `rule#${index + 1}` }
    return { kind: 'proxy', url: target.url, from: `rule#${index + 1}` }
  }

  const fallback = String(defaultMode ?? 'system').toLowerCase()
  if (fallback === 'direct') return { kind: 'direct', from: 'default' }
  return { kind: 'inherit', from: 'default' }
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

  const global = config.global ?? {}
  const mode = String(global.mode ?? 'system').toLowerCase()
  if (!GLOBAL_MODES.has(mode)) {
    problems.push(`global.mode must be one of system / direct / proxy, got "${String(global.mode)}"`)
  }
  if (mode === 'proxy') {
    const checked = validateProxyUrl(global.url)
    if (!checked.ok) problems.push(`global.url: ${checked.reason}`)
  }

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
    const fields = ['provider', 'model', 'host'].filter((field) => rule[field] !== undefined)
    if (fields.length === 0) {
      problems.push(`${label}: needs at least one of provider / model / host`)
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
