/**
 * Self-tests for `rules.js`: pure matching, no Cordis, no network.
 *
 * Run with: node test/rules.test.mjs
 */

import assert from 'node:assert/strict'
import {
  bypassesProxy,
  decideRoute,
  isLoopback,
  parseNoProxy,
  resolveProxyReference,
  ruleMatches,
  validateConfig,
  validateProxyUrl,
} from '../lib/rules.js'

let passed = 0
const failures = []

/** Run one case and record the outcome instead of aborting on the first error. */
function test(label, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// --- proxy URL validation ----------------------------------------------------

test('accepts http and https proxies', () => {
  assert.equal(validateProxyUrl('http://127.0.0.1:10808').ok, true)
  assert.equal(validateProxyUrl('https://proxy.example:8443').ok, true)
})

test('refuses SOCKS by name', () => {
  const result = validateProxyUrl('socks5://127.0.0.1:1080')
  assert.equal(result.ok, false)
  assert.match(result.reason, /SOCKS/)
})

test('refuses a malformed or empty URL', () => {
  assert.equal(validateProxyUrl('').ok, false)
  assert.equal(validateProxyUrl('not a url').ok, false)
  assert.equal(validateProxyUrl(undefined).ok, false)
})

// --- noProxy -----------------------------------------------------------------

test('splits a noProxy list on commas and spaces', () => {
  assert.deepEqual(parseNoProxy('a.com, b.com  c.com'), ['a.com', 'b.com', 'c.com'])
  assert.deepEqual(parseNoProxy(''), [])
  assert.deepEqual(parseNoProxy(undefined), [])
})

test('matches a host and its subdomains', () => {
  const entries = parseNoProxy('example.com')
  assert.equal(bypassesProxy(entries, new URL('http://example.com/x')), true)
  assert.equal(bypassesProxy(entries, new URL('http://api.example.com/x')), true)
  assert.equal(bypassesProxy(entries, new URL('http://notexample.com/x')), false)
})

test('honours a leading dot or star-dot', () => {
  for (const written of ['.example.com', '*.example.com']) {
    const entries = parseNoProxy(written)
    assert.equal(bypassesProxy(entries, new URL('http://api.example.com/')), true, written)
    assert.equal(bypassesProxy(entries, new URL('http://example.com/')), true, written)
  }
})

test('honours a port on an entry', () => {
  const entries = parseNoProxy('example.com:8443')
  assert.equal(bypassesProxy(entries, new URL('https://example.com:8443/')), true)
  assert.equal(bypassesProxy(entries, new URL('https://example.com/')), false)
})

test('star bypasses everything', () => {
  assert.equal(bypassesProxy(parseNoProxy('*'), new URL('https://anything.example/')), true)
})

// --- loopback ----------------------------------------------------------------

test('detects the loopback block, not just 127.0.0.1', () => {
  assert.equal(isLoopback('127.0.0.1'), true)
  assert.equal(isLoopback('127.5.6.7'), true, 'the whole 127/8 range is loopback')
  assert.equal(isLoopback('localhost'), true)
  assert.equal(isLoopback('::1'), true)
  assert.equal(isLoopback('example.com'), false)
  assert.equal(isLoopback('10.0.0.1'), false)
})

// --- rule matching -----------------------------------------------------------

test('provider and model must both agree', () => {
  const rule = { provider: 'command', model: 'deepseek/deepseek-v4.1-flash', proxy: 'local' }
  assert.equal(ruleMatches(rule, { provider: 'command', model: 'deepseek/deepseek-v4.1-flash' }), true)
  assert.equal(ruleMatches(rule, { provider: 'other', model: 'deepseek/deepseek-v4.1-flash' }), false)
  assert.equal(ruleMatches(rule, { provider: 'command', model: 'z-ai/glm-5.3-flash' }), false)
})

test('model matches with or without an endpoint suffix', () => {
  const rule = { model: 'deepseek-v4-flash', proxy: 'local' }
  assert.equal(ruleMatches(rule, { model: 'deepseek-v4-flash' }), true)
  assert.equal(ruleMatches(rule, { model: 'deepseek-v4-flash@command' }), true, 'picker form still matches')
})

test('model supports a trailing wildcard', () => {
  const rule = { model: 'deepseek/*', proxy: 'local' }
  assert.equal(ruleMatches(rule, { model: 'deepseek/v4-flash' }), true)
  assert.equal(ruleMatches(rule, { model: 'z-ai/glm' }), false)
})

test('host supports a wildcard suffix', () => {
  const rule = { host: '*.commandcode.ai', proxy: 'local' }
  assert.equal(ruleMatches(rule, { host: 'api.commandcode.ai' }), true)
  assert.equal(ruleMatches(rule, { host: 'commandcode.ai' }), false, 'a wildcard needs the subdomain')
})

test('a rule with no fields matches nothing', () => {
  assert.equal(ruleMatches({ proxy: 'local' }, { provider: 'x', model: 'y' }), false)
})

// --- proxy references --------------------------------------------------------

test('resolves a named proxy', () => {
  assert.deepEqual(resolveProxyReference('local', { local: 'http://127.0.0.1:10808' }), {
    ok: true,
    url: 'http://127.0.0.1:10808',
  })
})

test('resolves a literal URL without a dictionary entry', () => {
  assert.deepEqual(resolveProxyReference('http://127.0.0.1:9000', {}), { ok: true, url: 'http://127.0.0.1:9000' })
})

test('resolves the direct and system keywords', () => {
  assert.deepEqual(resolveProxyReference('direct', {}), { ok: true, url: 'direct' })
  assert.deepEqual(resolveProxyReference('system', {}), { ok: true, url: 'system' })
})

test('reports an unknown name rather than inventing a URL', () => {
  assert.equal(resolveProxyReference('missing', {}).ok, false)
})

// --- route decisions ---------------------------------------------------------

const base = { noProxy: [], rules: [], proxies: {}, defaultMode: 'system' }

test('loopback is direct even with a matching rule', () => {
  const decision = decideRoute({
    ...base,
    rules: [{ provider: 'x', proxy: 'http://p:1' }],
    provider: 'x',
    host: '127.0.0.1',
  })
  assert.deepEqual(decision, { kind: 'direct', from: 'loopback' })
})

test('noProxy wins over a matching rule', () => {
  const decision = decideRoute({
    ...base,
    noProxy: parseNoProxy('api.example.com'),
    rules: [{ host: 'api.example.com', proxy: 'http://p:1' }],
    host: 'api.example.com',
  })
  assert.equal(decision.kind, 'direct')
  assert.equal(decision.from, 'noProxy')
})

test('the first matching rule wins', () => {
  const decision = decideRoute({
    ...base,
    proxies: { a: 'http://a:1', b: 'http://b:2' },
    rules: [
      { provider: 'x', model: 'm', proxy: 'a' },
      { provider: 'x', proxy: 'b' },
    ],
    provider: 'x',
    model: 'm',
  })
  assert.deepEqual(decision, { kind: 'proxy', url: 'http://a:1', from: 'rule#1' })
})

test('defaultMode applies when nothing matched', () => {
  assert.equal(decideRoute({ ...base, provider: 'x' }).kind, 'inherit')
  assert.equal(decideRoute({ ...base, defaultMode: 'direct', provider: 'x' }).kind, 'direct')
})

test('an invalid rule proxy falls back to inherit rather than guessing', () => {
  const decision = decideRoute({
    ...base,
    rules: [{ provider: 'x', proxy: 'missing-name' }],
    provider: 'x',
  })
  assert.equal(decision.kind, 'inherit')
  assert.match(decision.from, /invalid/)
})

// --- config validation -------------------------------------------------------

test('accepts the shipped default config', () => {
  assert.deepEqual(validateConfig({
    global: { mode: 'system', url: '', noProxy: '' },
    proxies: {},
    rules: [],
    defaultMode: 'system',
    log: false,
  }), [])
})

test('reports an unknown global mode', () => {
  const problems = validateConfig({ global: { mode: 'warp' } })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /global\.mode/)
})

test('reports a proxy mode with no URL', () => {
  const problems = validateConfig({ global: { mode: 'proxy', url: '' } })
  assert.match(problems.join('\n'), /global\.url/)
})

test('reports a rule with no fields and a rule with no proxy', () => {
  const problems = validateConfig({ rules: [{ proxy: 'http://p:1' }, { provider: 'x' }] })
  assert.match(problems.join('\n'), /rules\[1\]: needs at least one/)
  assert.match(problems.join('\n'), /rules\[2\]: needs a proxy/)
})

test('reports a bad named proxy', () => {
  const problems = validateConfig({ proxies: { bad: 'socks5://127.0.0.1:1' } })
  assert.match(problems.join('\n'), /proxies\.bad/)
})

// --- report ------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n${failures.length} failed, ${passed} passed\n`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exitCode = 1
} else {
  console.log(`${passed} passed`)
}
