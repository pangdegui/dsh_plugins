/**
 * Unit checks that need no DSH install and no network.
 *
 * Run with `node test/unit.mjs` (or `npm test`) from the plugin directory.
 */
import assert from 'node:assert/strict'
import { WORKBUDDY_DEFAULT_MODEL, WORKBUDDY_MODELS } from '../lib/catalog.js'
import { needsRefresh, providerConfig } from '../lib/provider.js'
import { normalizeToken } from '../lib/wb.js'

// --- catalog ---------------------------------------------------------------
assert.ok(WORKBUDDY_MODELS.length > 0, 'catalog must not be empty')
const ids = new Set()
for (const model of WORKBUDDY_MODELS) {
  assert.equal(typeof model.id, 'string')
  assert.ok(model.id.length > 0)
  assert.ok(!ids.has(model.id), `duplicate model id: ${model.id}`)
  ids.add(model.id)
  assert.ok(Number.isInteger(model.contextWindow) && model.contextWindow > 0, `bad contextWindow for ${model.id}`)
  assert.ok(Array.isArray(model.input) && model.input.length > 0, `bad input for ${model.id}`)
  for (const modality of model.input) assert.ok(modality === 'text' || modality === 'image')
  if (model.maxTokens !== undefined) assert.ok(Number.isInteger(model.maxTokens) && model.maxTokens > 0)
}
assert.ok(ids.has(WORKBUDDY_DEFAULT_MODEL), 'default model must be part of the catalog')

// --- provider row ----------------------------------------------------------
const config = { endpoint: 'https://www.workbuddy.cn/', displayName: 'WorkBuddy', credentialRef: 'WORKBUDDY_ACCESS_TOKEN' }
const provider = providerConfig(config)
assert.equal(provider.api, 'openai-completions')
assert.equal(provider.baseURL, 'https://www.workbuddy.cn/v2')
assert.equal(provider.apiKeyEnv, 'WORKBUDDY_ACCESS_TOKEN')
assert.equal(provider.displayName, 'WorkBuddy')
assert.equal(provider.models.length, WORKBUDDY_MODELS.length)
assert.deepEqual(provider.models[0], {
  id: 'fast-model',
  name: '快速',
  contextWindow: 300000,
  maxTokens: 48000,
  input: ['text', 'image'],
})

// --- token expiry ----------------------------------------------------------
const now = 1_000_000
assert.equal(needsRefresh(undefined, 60_000, now), true)
assert.equal(needsRefresh({}, 60_000, now), true)
assert.equal(needsRefresh({ accessToken: 'x' }, 60_000, now), false)
assert.equal(needsRefresh({ accessToken: 'x', expiresAt: now + 30_000 }, 60_000, now), true)
assert.equal(needsRefresh({ accessToken: 'x', expiresAt: now + 600_000 }, 60_000, now), false)

// --- login token normalization --------------------------------------------
const token = normalizeToken({ accessToken: 'a', refreshToken: 'r', expiresIn: 60, refreshExpiresIn: 120, tokenType: 'Bearer' }, now)
assert.equal(token.accessToken, 'a')
assert.equal(token.refreshToken, 'r')
assert.equal(token.expiresAt, now + 60_000)
assert.equal(token.refreshExpiresAt, now + 120_000)
assert.equal(token.tokenType, 'Bearer')
assert.throws(() => normalizeToken({ refreshToken: 'r' }), /no access token/)

console.log(`ok: ${WORKBUDDY_MODELS.length} models, provider row and token arithmetic verified`)
