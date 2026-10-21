/**
 * WorkBuddy protocol client (pure Node, no Cordis).
 *
 * WorkBuddy is Tencent's agent desktop app. Its account plane is an
 * "account-scoped external link" login:
 *
 *   1. POST {endpoint}/v2/plugin/auth/state?platform=workbuddy
 *      -> { state, authUrl }  (no credentials)
 *   2. The user opens `authUrl` in a browser and signs in with a Tencent
 *      account; the backend attaches the resulting token to `state`.
 *   3. GET {endpoint}/v2/plugin/auth/token?state=...
 *      -> { accessToken, refreshToken, expiresIn, refreshExpiresIn, ... }
 *      (pending is reported as a non-zero business code, so polling repeats)
 *   4. GET {endpoint}/v2/plugin/account  with `Authorization: Bearer <token>`
 *
 * The model plane is OpenAI Chat Completions shaped:
 *
 *   POST {endpoint}/v2/chat/completions   (streaming only; non-stream is
 *   rejected with code 11101) with `Authorization: Bearer <accessToken>`.
 *
 * Tokens are slides: POST {endpoint}/v2/plugin/auth/token/refresh with
 * `X-Refresh-Token` returns a fresh token set without a browser round-trip.
 */

/** Headers that tell the account plane "this request carries no identity". */
export const ANONYMOUS_HEADERS = Object.freeze({
  'X-No-Authorization': 'true',
  'X-No-User-Id': 'true',
  'X-No-Enterprise-Id': 'true',
  'X-No-Department-Info': 'true',
})

/** Business codes that mean "the browser has not completed login yet". */
const PENDING_CODES = new Set([11217, 11251, 11252, 11253])

const DEFAULT_POLL_INTERVAL_MS = 1500
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/** Turn a non-2xx JSON answer into an Error carrying the provider fields. */
async function readJson(response, label) {
  const text = await response.text()
  let body
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    throw new Error(`${label}: expected JSON, got ${text.slice(0, 200)}`)
  }
  if (!response.ok) {
    const code = body?.code ?? response.status
    const message = body?.msg ?? body?.message ?? response.statusText
    const error = new Error(`${label} failed (HTTP ${response.status}, code ${code}): ${message}`)
    error.status = response.status
    error.code = code
    error.body = body
    throw error
  }
  return body
}

/** Normalize one token payload into the shape this plugin persists. */
export function normalizeToken(payload, now = Date.now()) {
  if (payload === undefined || payload === null || typeof payload.accessToken !== 'string') {
    throw new Error('WorkBuddy returned no access token')
  }
  const expiresAt = payload.expiresAt ?? (payload.expiresIn ? now + payload.expiresIn * 1000 : undefined)
  const refreshExpiresAt =
    payload.refreshExpiresAt ?? (payload.refreshExpiresIn ? now + payload.refreshExpiresIn * 1000 : undefined)
  return {
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    tokenType: payload.tokenType ?? 'Bearer',
    scope: payload.scope,
    domain: payload.domain,
    sessionState: payload.sessionState,
    expiresAt,
    refreshExpiresAt,
    lastRefreshAt: now,
  }
}

/**
 * A WorkBuddy account-plane/model-plane client bound to one endpoint.
 *
 * Every method is a single HTTP call: retries, polling cadence and persistence
 * belong to the caller, so this stays testable without a scheduler.
 */
export class WorkBuddyClient {
  constructor({ endpoint = 'https://www.workbuddy.cn', fetchImpl = globalThis.fetch, platform = 'workbuddy' } = {}) {
    this.endpoint = endpoint.replace(/\/+$/, '')
    this.platform = platform
    this.fetch = fetchImpl
  }

  url(path) {
    return `${this.endpoint}${path}`
  }

  /** Ask the account plane for a fresh login state and its browser URL. */
  async createLoginState(signal) {
    const response = await this.fetch(this.url(`/v2/plugin/auth/state?platform=${encodeURIComponent(this.platform)}`), {
      method: 'POST',
      headers: { ...ANONYMOUS_HEADERS, 'content-type': 'application/json' },
      body: '{}',
      signal,
    })
    const body = await readJson(response, 'workbuddy auth/state')
    const data = body?.data
    if (data === undefined || typeof data.state !== 'string' || typeof data.authUrl !== 'string') {
      throw new Error(`workbuddy auth/state returned an unusable payload: ${JSON.stringify(body).slice(0, 300)}`)
    }
    return data
  }

  /** One token poll. Returns `undefined` while the browser login is pending. */
  async pollLoginToken(state, signal) {
    const response = await this.fetch(
      this.url(`/v2/plugin/auth/token?state=${encodeURIComponent(state)}&platform=${encodeURIComponent(this.platform)}`),
      { headers: { ...ANONYMOUS_HEADERS }, signal },
    )
    if (response.status === 401 || response.status === 403) {
      const body = await response.text()
      throw new Error(`workbuddy auth/token rejected (HTTP ${response.status}): ${body.slice(0, 200)}`)
    }
    const text = await response.text()
    let body
    try {
      body = text === '' ? undefined : JSON.parse(text)
    } catch {
      return undefined
    }
    if (body?.code === 0 && body?.data?.accessToken) return normalizeToken(body.data)
    if (PENDING_CODES.has(body?.code)) return undefined
    if (!response.ok) {
      const error = new Error(`workbuddy auth/token failed (HTTP ${response.status}, code ${body?.code}): ${body?.msg ?? ''}`)
      error.status = response.status
      error.code = body?.code
      throw error
    }
    // An OK answer without a token is still "not ready yet".
    return undefined
  }

  /** Poll until the browser login completes, the timeout expires or the signal aborts. */
  async waitForLogin(state, { signal, intervalMs = DEFAULT_POLL_INTERVAL_MS, timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      await sleep(intervalMs, signal)
      const token = await this.pollLoginToken(state, signal)
      if (token !== undefined) return token
      if (Date.now() >= deadline) throw new Error('WorkBuddy login timed out; open the login URL again')
    }
  }

  /** Exchange a refresh token for a new token set. */
  async refreshToken(refreshToken, signal) {
    if (typeof refreshToken !== 'string' || refreshToken === '') throw new Error('WorkBuddy refresh token is missing')
    let host = 'www.workbuddy.cn'
    try {
      host = new URL(this.endpoint).host
    } catch {
      /* keep the fallback host */
    }
    const response = await this.fetch(this.url('/v2/plugin/auth/token/refresh'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Refresh-Token': refreshToken,
        'X-Auth-Refresh-Source': 'plugin',
        'X-Domain': host,
      },
      body: '{}',
      signal,
    })
    const body = await readJson(response, 'workbuddy auth/token/refresh')
    if (body?.code !== 0 || body?.data === undefined) {
      const error = new Error(`workbuddy token refresh rejected (code ${body?.code}): ${body?.msg ?? ''}`)
      error.code = body?.code
      throw error
    }
    return normalizeToken(body.data)
  }

  /** Read the account bound to an access token. */
  async fetchAccount(accessToken, signal) {
    const response = await this.fetch(this.url('/v2/plugin/account'), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-No-Enterprise-Id': 'true',
        'X-No-Department-Info': 'true',
      },
      signal,
    })
    const body = await readJson(response, 'workbuddy account')
    return body?.data
  }
}
