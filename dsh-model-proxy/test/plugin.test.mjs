/**
 * Smoke test for the plugin entry point.
 *
 * Imports `lib/index.js` and drives `apply()` with a fake Cordis context that
 * records every registration. This catches the failures that only show up at
 * load time — a bad export shape, a route registered twice, a listener with the
 * wrong signature — without needing the real Harness.
 *
 * Run with: node test/plugin.test.mjs
 */

import assert from 'node:assert/strict'
import http from 'node:http'

import { resolveUndici } from './undici.mjs'

const module = await import('../lib/index.js')
const { loadTransport } = await import('../lib/transport.js')

// The plugin resolves `undici` by bare specifier; point that at whatever copy
// this environment offers so the test exercises a real transport.
const resolved = await resolveUndici()
if ('module' in resolved) await loadTransport({ module: resolved.module })

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

/**
 * A Cordis context stand-in: enough surface for `apply()` to register its
 * effects, listeners and routes, and to be inspected afterwards.
 */
function fakeContext() {
  const routes = []
  const listeners = []
  const logs = []
  const services = new Map([
    ['webServer', {
      register: (route) => {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index !== -1) routes.splice(index, 1)
        }
      },
    }],
    // The fence is delegated to this service in production. Trusting every
    // call here keeps the tests about the plugin, not about the Host's
    // Host/Origin policy, which has its own suite.
    ['connection', { requestRejection: () => undefined }],
  ])

  const ctx = {
    logger: {
      info: (line) => logs.push(`info ${line}`),
      warn: (line) => logs.push(`warn ${line}`),
    },
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {
        const index = listeners.indexOf(listeners.find((entry) => entry.handler === handler))
        if (index !== -1) listeners.splice(index, 1)
      }
    },
    effect(fn) {
      const disposer = typeof fn === 'function' ? fn() : undefined
      return { dispose: disposer }
    },
    get(service) {
      return services.get(service)
    },
    inject(names, fn) {
      fn(ctx)
    },
  }

  // Real Cordis exposes an injected service as a plain property of the context
  // handed to the callback. Mirror that, or a plugin that writes
  // `webCtx.webServer.register(...)` would fail here and pass in production.
  for (const [service, value] of services) ctx[service] = value

  return { ctx, routes, listeners, logs }
}

await test('exports the shape Cordis loads', () => {
  assert.equal(module.name, 'model-proxy')
  assert.equal(typeof module.apply, 'function')
  assert.ok(Array.isArray(module.inject))
})

await test('registers the three panel routes exactly once each', () => {
  const { ctx, routes } = fakeContext()
  module.apply(ctx, {})
  const paths = routes.map((route) => route.path).sort()
  assert.deepEqual(paths, ['/model-proxy', '/model-proxy/apply', '/model-proxy/status'])
  for (const route of routes) assert.equal(route.kind, 'exact')
})

await test('subscribes to llm/stream as a prepended global listener', () => {
  const { ctx, listeners } = fakeContext()
  module.apply(ctx, {})
  const stream = listeners.find((entry) => entry.event === 'llm/stream')
  assert.ok(stream !== undefined, 'llm/stream must be intercepted')
  assert.equal(typeof stream.handler, 'function')
})

await test('a config with problems still loads the plugin', () => {
  const { ctx, routes } = fakeContext()
  module.apply(ctx, { global: { mode: 'nonsense' }, rules: [{ provider: 'x' }] })
  assert.equal(routes.length, 3, 'routes must be registered even when the config is wrong')
})

await test('the panel renders and reports the active policy', async () => {
  const { ctx, routes } = fakeContext()
  module.apply(ctx, {
    global: { mode: 'proxy', url: 'http://127.0.0.1:10808', noProxy: '' },
    proxies: { local: 'http://127.0.0.1:10808' },
    rules: [{ provider: 'command', model: 'deepseek/deepseek-v4.1-flash', proxy: 'local' }],
  })

  const panel = routes.find((route) => route.path === '/model-proxy')
  const response = await invoke(panel.handler, 'GET', '/model-proxy', '', {
    host: '127.0.0.1:3000',
  })

  assert.equal(response.status, 200)
  assert.match(response.body, /模型代理/)
  assert.match(response.body, /deepseek\/deepseek-v4\.1-flash/)
  assert.match(response.body, /http:\/\/127\.0\.0\.1:10808/)
})

await test('the status route answers JSON', async () => {
  const { ctx, routes } = fakeContext()
  module.apply(ctx, { global: { mode: 'direct' } })
  const status = routes.find((route) => route.path === '/model-proxy/status')
  const response = await invoke(status.handler, 'GET', '/model-proxy/status', '')

  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.ok, true)
  assert.equal(body.global.mode, 'direct')
})

await test('a form POST applies the new global policy', async () => {
  const { ctx, routes } = fakeContext()
  module.apply(ctx, { global: { mode: 'system' } })
  const apply = routes.find((route) => route.path === '/model-proxy/apply')

  const form = new URLSearchParams({
    action: 'apply',
    globalMode: 'proxy',
    globalUrl: 'http://127.0.0.1:19999',
    noProxy: '*.internal',
    proxies: 'local: http://127.0.0.1:10808',
    rules: 'provider: command model: deepseek/v4 proxy: local',
    defaultMode: 'system',
    log: 'off',
  }).toString()

  const response = await invoke(apply.handler, 'POST', '/model-proxy/apply', form, {
    'content-type': 'application/x-www-form-urlencoded',
  })

  assert.equal(response.status, 200)
  assert.match(response.body, /全局代理已应用/)
  assert.match(response.body, /http:\/\/127\.0\.0\.1:19999/)
})

await test('a POST with an invalid mode is refused and changes nothing', async () => {
  const { ctx, routes } = fakeContext()
  module.apply(ctx, { global: { mode: 'direct' } })
  const apply = routes.find((route) => route.path === '/model-proxy/apply')

  const form = new URLSearchParams({
    action: 'apply',
    globalMode: 'warp',
    globalUrl: '',
    noProxy: '',
    proxies: '',
    rules: '',
    defaultMode: 'system',
    log: 'off',
  }).toString()

  const response = await invoke(apply.handler, 'POST', '/model-proxy/apply', form)

  assert.equal(response.status, 400)
  assert.match(response.body, /global\.mode/)
})

await test('reset switches to direct', async () => {
  const { ctx, routes } = fakeContext()
  module.apply(ctx, { global: { mode: 'proxy', url: 'http://127.0.0.1:10808' } })
  const apply = routes.find((route) => route.path === '/model-proxy/apply')

  const response = await invoke(apply.handler, 'POST', '/model-proxy/apply', 'action=reset')
  assert.equal(response.status, 200)
  assert.match(response.body, /全局代理已应用：direct/)
})

await test('an unknown path answers 404', async () => {
  const { ctx, routes } = fakeContext()
  module.apply(ctx, {})
  const panel = routes.find((route) => route.path === '/model-proxy')
  const response = await invoke(panel.handler, 'GET', '/model-proxy/nope', '')
  assert.equal(response.status, 404)
})

// --- helpers -----------------------------------------------------------------

/**
 * Call one route handler with a minimal request and capture the response.
 *
 * The Host's `req` is a real `IncomingMessage`, but the handler only reads
 * headers, method, url and (for POSTs) the body stream, so a stand-in is enough.
 */
function invoke(handler, method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = new (class extends http.IncomingMessage {
      constructor() {
        super({ method, url, headers, socket: { encrypted: false } })
      }
    })()
    req.method = method
    req.url = url
    req.headers = { host: '127.0.0.1:3000', ...headers }

    /** Feed the body then end, on the next tick so listeners attach first. */
    setImmediate(() => {
      if (body !== '') req.push(Buffer.from(body, 'utf8'))
      req.push(null)
    })

    const response = {
      status: undefined,
      headers: {},
      body: '',
      writeHead(status, headers) {
        this.status = status
        Object.assign(this.headers, headers ?? {})
        return this
      },
      end(chunk) {
        if (chunk !== undefined) this.body += String(chunk)
        resolve(this)
      },
      write(chunk) {
        this.body += String(chunk)
      },
    }

    Promise.resolve()
      .then(() => handler(req, response))
      .catch(reject)
  })
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed, ${passed} passed\n`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exitCode = 1
} else {
  console.log(`${passed} passed`)
}
