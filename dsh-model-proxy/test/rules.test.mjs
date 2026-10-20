/**
 * Self-tests for `rules.js`: pure matching, no Cordis, no network.
 *
 * Run with: node test/rules.test.mjs
 */

import assert from 'node:assert/strict'
import {
  decideRoute,
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

// --- proxy references --------------------------------------------------------

test('resolves a named proxy to its URL', () => {
  const result = resolveProxyReference('local', { local: 'http://127.0.0.1:10808' })
  assert.deepEqual(result, { ok: true, url: 'http://127.0.0.1:10808' })
})

test('accepts a literal URL without a dictionary entry', () => {
  const result = resolveProxyReference('http://10.0.0.2:3128', {})
  assert.deepEqual(result, { ok: true, url: 'http://10.0.0.2:3128' })
})

test('accepts direct as a rule target', () => {
  assert.deepEqual(resolveProxyReference('direct', {}), { ok: true, url: 'direct' })
  assert.deepEqual(resolveProxyReference('DIRECT', {}), { ok: true, url: 'direct' })
})

test('rejects an empty reference', () => {
  assert.equal(resolveProxyReference('', {}).ok, false)
  assert.equal(resolveProxyReference(undefined, {}).ok, false)
})

// --- rule matching -----------------------------------------------------------

test('matches on provider alone', () => {
  assert.equal(ruleMatches({ provider: 'command', proxy: 'x' }, { provider: 'command', model: 'any' }), true)
  assert.equal(ruleMatches({ provider: 'command', proxy: 'x' }, { provider: 'other', model: 'any' }), false)
})

test('matches on model alone', () => {
  assert.equal(ruleMatches({ model: 'gpt-6', proxy: 'x' }, { model: 'gpt-6' }), true)
  assert.equal(ruleMatches({ model: 'gpt-6', proxy: 'x' }, { model: 'gpt-7' }), false)
})

test('requires every declared field to agree', () => {
  const rule = { provider: 'command', model: 'gpt-6', proxy: 'x' }
  assert.equal(ruleMatches(rule, { provider: 'command', model: 'gpt-6' }), true)
  assert.equal(ruleMatches(rule, { provider: 'command', model: 'gpt-7' }), false)
  assert.equal(ruleMatches(rule, { provider: 'other', model: 'gpt-6' }), false)
})

test('a rule with no recognised field matches nothing', () => {
  assert.equal(ruleMatches({ proxy: 'x' }, { provider: 'command', model: 'm' }), false)
  assert.equal(ruleMatches({ nonsense: 'y', proxy: 'x' }, { model: 'm' }), false)
})

test('model match tolerates an @endpoint suffix', () => {
  assert.equal(ruleMatches({ model: 'gpt-6', proxy: 'x' }, { model: 'gpt-6@command' }), true)
  assert.equal(ruleMatches({ model: 'gpt-6@command', proxy: 'x' }, { model: 'gpt-6' }), true)
})

test('model match supports a trailing wildcard', () => {
  assert.equal(ruleMatches({ model: 'deepseek/*', proxy: 'x' }, { model: 'deepseek/v4.1' }), true)
  assert.equal(ruleMatches({ model: 'deepseek/*', proxy: 'x' }, { model: 'glm/5' }), false)
})

// --- routing ----------------------------------------------------------------

test('a matching rule sends the model through its proxy', () => {
  const decision = decideRoute({
    rules: [{ model: 'gpt-6', proxy: 'local' }],
    proxies: { local: 'http://127.0.0.1:10808' },
    model: 'gpt-6',
  })
  assert.equal(decision.kind, 'proxy')
  assert.equal(decision.url, 'http://127.0.0.1:10808')
})

test('a rule can force one model direct', () => {
  const decision = decideRoute({
    rules: [{ model: 'gpt-6', proxy: 'direct' }],
    proxies: {},
    model: 'gpt-6',
  })
  assert.equal(decision.kind, 'direct')
})

test('first match wins', () => {
  const decision = decideRoute({
    rules: [
      { provider: 'command', proxy: 'a' },
      { model: 'gpt-6', proxy: 'b' },
    ],
    proxies: { a: 'http://a:1', b: 'http://b:2' },
    provider: 'command',
    model: 'gpt-6',
  })
  assert.equal(decision.url, 'http://a:1')
})

test('an unmatched model is left completely alone', () => {
  const decision = decideRoute({
    rules: [{ model: 'gpt-6', proxy: 'local' }],
    proxies: { local: 'http://127.0.0.1:10808' },
    model: 'something-else',
  })
  assert.equal(decision.kind, 'unrouted')
  assert.equal(decision.from, 'no-rule')
})

test('an empty rule list leaves every model alone', () => {
  assert.equal(decideRoute({ rules: [], proxies: {}, model: 'gpt-6' }).kind, 'unrouted')
})

test('a broken rule degrades to unrouted rather than direct', () => {
  const decision = decideRoute({
    rules: [{ model: 'gpt-6', proxy: 'missing-name' }],
    proxies: {},
    model: 'gpt-6',
  })
  assert.equal(decision.kind, 'unrouted')
  assert.match(decision.from, /invalid/)
})

test('routing never looks at host, so unrelated traffic is out of scope', () => {
  // A decision is a pure function of model identity: passing a host-looking
  // value as the model must not turn it into a host match.
  const decision = decideRoute({
    rules: [{ model: 'api.example.com', proxy: 'local' }],
    proxies: { local: 'http://127.0.0.1:10808' },
    provider: 'command',
    model: 'gpt-6',
  })
  assert.equal(decision.kind, 'unrouted')
})

// --- config validation -------------------------------------------------------

test('a usable config has no problems', () => {
  const problems = validateConfig({
    proxies: { local: 'http://127.0.0.1:10808' },
    rules: [{ model: 'gpt-6', proxy: 'local' }],
  })
  assert.deepEqual(problems, [])
})

test('reports a bad proxy URL', () => {
  const problems = validateConfig({ proxies: { local: 'socks5://127.0.0.1:1080' }, rules: [] })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /proxies\.local/)
})

test('reports a rule with no matching field', () => {
  const problems = validateConfig({ proxies: {}, rules: [{ proxy: 'direct' }] })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /needs at least one of provider \/ model/)
})

test('reports a rule with no proxy', () => {
  const problems = validateConfig({ proxies: {}, rules: [{ model: 'gpt-6' }] })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /needs a proxy/)
})

test('reports a rule naming an unknown proxy', () => {
  const problems = validateConfig({ proxies: {}, rules: [{ model: 'gpt-6', proxy: 'nope' }] })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /not a valid URL|empty/)
})

test('reports rules that are not an array', () => {
  const problems = validateConfig({ proxies: {}, rules: { model: 'gpt-6' } })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /must be an array/)
})

// --- summary -----------------------------------------------------------------

if (failures.length > 0) {
  console.error(`${failures.length} failed, ${passed} passed`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exitCode = 1
} else {
  console.log(`${passed} passed`)
}
