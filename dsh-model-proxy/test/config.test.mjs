/**
 * `config.js` — the stored shape and the rules it compiles to.
 *
 * These functions are the seam between what a user types on the settings page
 * and what `rules.js` matches at request time, so the cases that matter are the
 * degenerate ones: nothing configured, half configured, and a config written by
 * the previous release.
 *
 * Run with: node test/config.test.mjs
 */

import assert from 'node:assert/strict'

import {
  CONFIG_FIELDS,
  isActive,
  normalizeConfig,
  toRules,
  validateUserConfig,
} from '../lib/config.js'
import { decideRoute } from '../lib/rules.js'

const failures = []
let passed = 0

async function test(label, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// --- the stored shape --------------------------------------------------------

await test('declares exactly the fields it stores', () => {
  assert.deepEqual(CONFIG_FIELDS, ['proxy', 'models', 'log'])
})

await test('an empty config routes nothing', () => {
  const config = normalizeConfig(undefined)
  assert.deepEqual(config, { proxy: '', models: [], log: false })
  assert.deepEqual(toRules(config), [])
  assert.equal(isActive(config), false)
})

await test('trims the proxy and drops blank model ids', () => {
  const config = normalizeConfig({
    proxy: '  http://127.0.0.1:10808  ',
    models: [' a ', '', '   ', 'b'],
  })
  assert.equal(config.proxy, 'http://127.0.0.1:10808')
  assert.deepEqual(config.models, ['a', 'b'])
})

await test('de-duplicates model ids so one model is one rule', () => {
  const config = normalizeConfig({ proxy: 'http://p:1', models: ['a', 'a', 'b', 'a'] })
  assert.deepEqual(config.models, ['a', 'b'])
  assert.equal(toRules(config).length, 2)
})

await test('ignores fields of the wrong type instead of trusting them', () => {
  const config = normalizeConfig({ proxy: 42, models: 'not-an-array', log: 'yes' })
  assert.deepEqual(config, { proxy: '', models: [], log: false })
})

// --- legacy migration --------------------------------------------------------

await test('migrates a named-proxy rule from the first release', () => {
  const config = normalizeConfig({
    proxies: { local: 'http://127.0.0.1:10808' },
    rules: [
      { model: 'deepseek/v4', proxy: 'local' },
      { model: 'glm-5', proxy: 'local' },
    ],
  })
  assert.equal(config.proxy, 'http://127.0.0.1:10808')
  assert.deepEqual(config.models, ['deepseek/v4', 'glm-5'])
})

await test('migrates a rule that named its proxy as a literal URL', () => {
  const config = normalizeConfig({
    proxies: {},
    rules: [{ model: 'gpt-6', proxy: 'http://127.0.0.1:7890' }],
  })
  assert.equal(config.proxy, 'http://127.0.0.1:7890')
  assert.deepEqual(config.models, ['gpt-6'])
})

await test('a legacy rule forcing direct does not become the proxy', () => {
  const config = normalizeConfig({
    proxies: {},
    rules: [{ model: 'gpt-6', proxy: 'direct' }],
  })
  assert.equal(config.proxy, '', 'direct is not an address')
  assert.deepEqual(config.models, ['gpt-6'])
})

await test('a current config is never rewritten as legacy', () => {
  const config = normalizeConfig({ proxy: 'http://p:1', models: ['a'], proxies: { old: 'http://old:1' } })
  assert.equal(config.proxy, 'http://p:1')
  assert.deepEqual(config.models, ['a'])
})

// --- compiling to rules ------------------------------------------------------

await test('one rule per model, all pointing at the one proxy', () => {
  const rules = toRules({ proxy: 'http://127.0.0.1:10808', models: ['a', 'b'] })
  assert.deepEqual(rules, [
    { model: 'a', proxy: 'http://127.0.0.1:10808' },
    { model: 'b', proxy: 'http://127.0.0.1:10808' },
  ])
})

await test('a model list with no proxy compiles to no rules', () => {
  assert.deepEqual(toRules({ proxy: '', models: ['a'] }), [])
})

await test('a proxy with no models compiles to no rules', () => {
  assert.deepEqual(toRules({ proxy: 'http://p:1', models: [] }), [])
})

await test('the compiled rules route exactly the ticked models', () => {
  const config = { proxy: 'http://127.0.0.1:10808', models: ['deepseek/deepseek-v4.1-flash'] }
  const rules = toRules(config)

  const ticked = decideRoute({ rules, provider: 'command', model: 'deepseek/deepseek-v4.1-flash' })
  assert.equal(ticked.kind, 'proxy')
  assert.equal(ticked.url, 'http://127.0.0.1:10808')

  const unticked = decideRoute({ rules, provider: 'command', model: 'z-ai/glm-5.3-flash' })
  assert.equal(unticked.kind, 'unrouted', 'an unticked model is left completely alone')
})

// --- validation -------------------------------------------------------------

await test('an empty config is valid, because a fresh install looks like that', () => {
  assert.deepEqual(validateUserConfig({ proxy: '', models: [] }), [])
})

await test('models without a proxy is a problem worth reporting', () => {
  const problems = validateUserConfig({ proxy: '', models: ['a', 'b'] })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /2/)
})

await test('a SOCKS proxy is refused with a reason', () => {
  const problems = validateUserConfig({ proxy: 'socks5://127.0.0.1:1080', models: ['a'] })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /SOCKS/)
})

await test('a malformed proxy is refused', () => {
  const problems = validateUserConfig({ proxy: 'not a url', models: ['a'] })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /无效/)
})

await test('a usable config reports nothing', () => {
  assert.deepEqual(validateUserConfig({ proxy: 'http://127.0.0.1:10808', models: ['a'] }), [])
})

if (failures.length > 0) {
  console.error(`\n${failures.length} failed, ${passed} passed\n`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exitCode = 1
} else {
  console.log(`${passed} passed`)
}
