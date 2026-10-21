/**
 * Unit checks that need no DSH install and no network.
 *
 * Run with `node test/unit.mjs` (or `npm test`) from the plugin directory.
 */
import assert from 'node:assert/strict'
import { WORKBUDDY_DEFAULT_MODEL, WORKBUDDY_MODELS } from '../lib/catalog.js'
import {
  DEFAULT_PROMPT_PREFIX,
  guardAssembly,
  isIdentitySection,
  normalizePromptGuard,
  normalizePromptPrefix,
} from '../lib/prompt-guard.js'
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
// The gateway rejects the `developer` role with 11128, so the route must never
// let pi-ai choose it, whatever the model's reasoning capability.
assert.deepEqual(provider.compat, { supportsDeveloperRole: false })
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

// --- prompt guard ----------------------------------------------------------
const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'

assert.equal(normalizePromptGuard('prepend'), 'prepend')
assert.equal(normalizePromptGuard('strip'), 'strip')
assert.equal(normalizePromptGuard('off'), 'off')
assert.equal(normalizePromptGuard('nonsense'), 'off')
assert.equal(normalizePromptGuard(undefined), 'off')
assert.equal(normalizePromptGuard(undefined, 'prepend'), 'prepend')
assert.equal(normalizePromptGuard('nonsense', null), null)

assert.equal(normalizePromptPrefix(''), DEFAULT_PROMPT_PREFIX)
assert.equal(normalizePromptPrefix('   '), DEFAULT_PROMPT_PREFIX)
assert.equal(normalizePromptPrefix(undefined), DEFAULT_PROMPT_PREFIX)
assert.equal(normalizePromptPrefix('  one line \r\n'), 'one line')
assert.equal(normalizePromptPrefix('', ''), '')

assert.equal(isIdentitySection({ name: 'harness:identity', text: '' }), true)
assert.equal(isIdentitySection({ name: 'other', text: IDENTITY }), true)
assert.equal(isIdentitySection({ name: 'other', text: `  ${IDENTITY.toLowerCase()}` }), true)
assert.equal(isIdentitySection({ name: 'persona', text: 'You are a coding agent.' }), false)

/** One assembly shaped like the real one: identity first, persona second. */
const makeAssembly = () => ({
  sections: [
    { name: 'harness:identity', text: IDENTITY },
    { name: 'persona', text: 'You are a coding agent powered by the hy3 model.' },
  ],
  contexts: [],
  tools: [],
  variables: { provider: 'workbuddy', model: 'hy3' },
})

const settings = { provider: 'workbuddy', promptGuard: 'prepend', promptPrefix: 'Hello gateway.' }

// off: nothing changes, and it is the same object.
const untouched = makeAssembly()
assert.equal(guardAssembly({ ...settings, promptGuard: 'off' }, untouched, 'workbuddy'), untouched)

// a different provider keeps the exact assembly.
assert.equal(guardAssembly(settings, untouched, 'command'), untouched)

// an unknown provider is left alone rather than guessed at.
assert.equal(guardAssembly(settings, untouched, undefined), untouched)

// prepend puts the prefix in front of the first section and keeps every section.
const prepended = guardAssembly(settings, makeAssembly(), 'workbuddy')
assert.equal(prepended.sections.length, 2)
assert.ok(prepended.sections[0].text.startsWith('Hello gateway.\n\n'))
assert.ok(prepended.sections[0].text.includes(IDENTITY))
assert.deepEqual(prepended.sections[1], { name: 'persona', text: 'You are a coding agent powered by the hy3 model.' })
// The input assembly is never mutated, so another provider keeps its prompt.
assert.equal(untouched.sections[0].text, IDENTITY)
// Re-running on the produced assembly does not stack a second prefix.
const twice = guardAssembly(settings, prepended, 'workbuddy')
assert.equal(twice.sections[0].text, prepended.sections[0].text)

// the guarded prompt no longer *opens* with the identity sentence.
assert.ok(!prepended.sections[0].text.startsWith(IDENTITY))

// strip removes only the identity section.
const stripped = guardAssembly({ ...settings, promptGuard: 'strip' }, makeAssembly(), 'workbuddy')
assert.equal(stripped.sections.length, 1)
assert.equal(stripped.sections[0].name, 'persona')
assert.ok(!stripped.sections[0].text.includes('DeepSeek Harness'))

// stripping an assembly that has no identity section leaves it alone.
const personaOnly = { sections: [{ name: 'persona', text: 'You are a coding agent.' }], variables: {} }
assert.equal(guardAssembly({ ...settings, promptGuard: 'strip' }, personaOnly, 'workbuddy'), personaOnly)

// an empty assembly is never turned into an empty prompt by `strip`.
const empty = { sections: [], variables: {} }
assert.equal(guardAssembly({ ...settings, promptGuard: 'strip' }, empty, 'workbuddy'), empty)
assert.equal(guardAssembly(settings, empty, 'workbuddy'), empty)

// a blank configured prefix falls back to the shipped default.
const blank = guardAssembly({ ...settings, promptPrefix: '   ' }, makeAssembly(), 'workbuddy')
assert.ok(blank.sections[0].text.startsWith(`${DEFAULT_PROMPT_PREFIX}\n\n`))

// --- summary ---------------------------------------------------------------
console.log(`ok: ${WORKBUDDY_MODELS.length} models, provider row, token arithmetic and prompt guard verified`)
