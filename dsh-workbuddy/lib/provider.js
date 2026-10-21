/**
 * Pure helpers that shape DSH's view of WorkBuddy: the pi-ai provider row and
 * token-expiry arithmetic. No Cordis, no filesystem, so they are cheap to test
 * and cannot accidentally reach a service during load.
 */
import { WORKBUDDY_MODELS } from './catalog.js'

/**
 * The `llm-pi-ai` provider entry this plugin installs.
 *
 * `api: openai-completions` selects pi-ai's OpenAI Chat Completions transport;
 * `baseURL` points at WorkBuddy's `/v2` root because that is where the app's
 * own client posts (`/v2/chat/completions`). The credential ref is resolved by
 * the credential seam per request, so a rotated token applies immediately.
 * @param config - resolved plugin config (`endpoint`, `displayName`, `credentialRef`).
 * @returns the provider row to merge into `providers[provider]`.
 */
export function providerConfig(config) {
  return {
    displayName: config.displayName,
    apiKeyEnv: config.credentialRef,
    api: 'openai-completions',
    baseURL: `${config.endpoint.replace(/\/+$/, '')}/v2`,
    models: WORKBUDDY_MODELS.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      input: [...model.input],
    })),
  }
}

/**
 * Whether the access token is missing or close enough to expiry to rotate.
 * A token without a known expiry is treated as usable: rotating blindly would
 * spend a refresh token on every check.
 * @param token - persisted token record.
 * @param skewMs - refresh this long before expiry.
 * @param now - clock injection for tests.
 */
export function needsRefresh(token, skewMs, now = Date.now()) {
  if (typeof token?.accessToken !== 'string') return true
  if (!Number.isFinite(token.expiresAt)) return false
  return token.expiresAt - now <= skewMs
}
