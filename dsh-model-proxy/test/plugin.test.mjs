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
 *
 * `configEditor` is optional: passing `editor` models a profile where the
 * plugin's own row can be written, and omitting it models one where it cannot,
 * which is how the "changes will not survive a restart" path is reached.
 */
function fakeContext({ editor, llm } = {}) {
  const routes = []
  const listeners = []
  const logs = []
  const writes = []
  const effects = []
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

  // The settings page's model list comes from the `llm` service; a profile
  // without one must render an empty list rather than fail, so `llm` stays
  // optional here too.
  if (llm !== undefined) services.set('llm', llm)

  if (editor !== 'absent') {
    services.set('configEditor', {
      // One addressable row, id `model-proxy`, as the bundle patch declares it.
      entries: () => [{ options: { id: 'model-proxy', name: 'dsh-model-proxy' } }],
      edit: async (entry, change) => {
        writes.push({ entry, next: change({}, {}) })
      },
    })
  }

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
      effects.push(disposer)
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

  return { ctx, routes, listeners, logs, writes, effects }
}

await test('exports the shape Cordis loads', () => {
  assert.equal(module.name, 'model-proxy')
  assert.equal(typeof module.apply, 'function')
  assert.ok(Array.isArray(module.inject))
})

await test('registers every route exactly once each', () => {
  const { ctx, routes } = fakeContext()
  module.apply(ctx, {})
  const paths = routes.map((route) => route.path).sort()
  assert.deepEqual(paths, [
    '/model-proxy',
    '/model-proxy/apply',
    '/model-proxy/models',
    '/model-proxy/status',
  ])
  assert.ok(routes.every((route) => route.kind === 'exact'))
})

await test('intercepts llm/stream and nothing else', () => {
  const { ctx, listeners } = fakeContext()
  module.apply(ctx, {})
  const events = listeners.map((entry) => entry.event)
  assert.deepEqual(events, ['llm/stream'])
})

await test('never installs a process-wide dispatcher', () => {
  const { ctx } = fakeContext()
  module.apply(ctx, {})
  // The claim behind "models only": if this plugin had called
  // setGlobalDispatcher, unrelated traffic would be affected. Check that the
  // global dispatcher still answers with whatever it answered before.
  const undiciModule = 'module' in resolved ? resolved.module : undefined
  if (undiciModule !== undefined) {
    const before = undiciModule.getGlobalDispatcher()
    const { ctx: other } = fakeContext()
    module.apply(other, { proxy: 'http://127.0.0.1:9', models: ['gpt-6'] })
    assert.equal(undiciModule.getGlobalDispatcher(), before, 'the global dispatcher must be untouched')
  }
})

await test('the bare panel path redirects to the settings page', async () => {
  const { ctx, routes } = fakeContext()
  module.apply(ctx, {})
  const panel = routes.find((route) => route.path === '/model-proxy')
  const response = await invoke(panel.handler, 'GET', '/model-proxy', '')
  // The form lives in Settings now (`lib/client.js`); a stale bookmark must not
  // land on a second, divergent copy of it.
  assert.equal(response.status, 303)
  assert.equal(response.headers.location, '/')
  assert.match(response.body, /设置/)
})

await test('the status route carries what the settings page renders', async () => {
  const { ctx, routes } = fakeContext()
  module.apply(ctx, {})
  const status = routes.find((route) => route.path === '/model-proxy/status')
  const response = await invoke(status.handler, 'GET', '/model-proxy/status', '')
  assert.equal(response.status, 200)
  // The browser half reads exactly these keys; a rename here silently blanks a
  // field in the UI, so hold the wire shape still.
  for (const key of ['transport', 'problems', 'active', 'proxy', 'models', 'log', 'ruleCount', 'recent']) {
    assert.ok(Object.hasOwn(JSON.parse(response.body), key), `status must expose ${key}`)
  }
})

await test('status reports the configured proxy and the models it covers', async () => {
  const { ctx, routes } = fakeContext()
  module.apply(ctx, {
    proxy: 'http://127.0.0.1:10808',
    models: ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash'],
  })
  const status = routes.find((route) => route.path === '/model-proxy/status')
  const response = await invoke(status.handler, 'GET', '/model-proxy/status', '')
  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.proxy, 'http://127.0.0.1:10808')
  assert.deepEqual(body.models, ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash'])
  assert.equal(body.ruleCount, 2, 'one compiled rule per ticked model')
  assert.equal(typeof body.log, 'boolean', 'the log flag is what the page renders')
})

await test('the models route lists what the deployment offers', async () => {
  const { ctx, routes } = fakeContext({
    llm: {
      listProviders: () => [
        { id: 'command', name: 'Command' },
        { id: 'broken', name: 'Broken' },
      ],
      listModels: async (provider) => {
        if (provider === 'broken') throw new Error('adapter is down')
        return [
          { provider, id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash command' },
        ]
      },
    },
  })
  module.apply(ctx, {})
  const models = routes.find((route) => route.path === '/model-proxy/models')
  const response = await invoke(models.handler, 'GET', '/model-proxy/models', '')
  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.ok, true)
  assert.equal(body.providers.length, 2)
  assert.deepEqual(body.providers[0].models, [
    { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash command' },
  ])
  // One broken provider must not hide the others.
  assert.deepEqual(body.providers[1].models, [])
})

await test('the models route answers empty when no model service exists', async () => {
  const { ctx, routes } = fakeContext()
  module.apply(ctx, {})
  const models = routes.find((route) => route.path === '/model-proxy/models')
  const body = JSON.parse((await invoke(models.handler, 'GET', '/model-proxy/models', '')).body)
  assert.equal(body.ok, true)
  assert.deepEqual(body.providers, [])
})

await test('a JSON POST persists through the config editor', async () => {
  const { ctx, routes, writes } = fakeContext()
  module.apply(ctx, {})
  const apply = routes.find((route) => route.path === '/model-proxy/apply')

  const body = JSON.stringify({
    proxy: 'http://127.0.0.1:10808',
    models: ['deepseek/deepseek-v4.1-flash'],
    log: false,
  })

  const response = await invoke(apply.handler, 'POST', '/model-proxy/apply', body, {
    'content-type': 'application/json',
  })

  assert.equal(response.status, 202, 'a persisted write asks the page to reload')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].next.proxy, 'http://127.0.0.1:10808')
  assert.deepEqual(writes[0].next.models, ['deepseek/deepseek-v4.1-flash'])
  assert.equal(writes[0].next.log, false)
  assert.match(response.body, /已保存到配置文件/)
})

await test('a POST without a config editor applies in memory and says so', async () => {
  const { ctx, routes } = fakeContext({ editor: 'absent' })
  module.apply(ctx, {})
  const apply = routes.find((route) => route.path === '/model-proxy/apply')

  const body = JSON.stringify({ proxy: 'http://127.0.0.1:10808', models: ['gpt-6'], log: false })
  const response = await invoke(apply.handler, 'POST', '/model-proxy/apply', body)
  assert.equal(response.status, 200)
  assert.match(response.body, /配置编辑器不可用/)

  const status = routes.find((route) => route.path === '/model-proxy/status')
  const view = JSON.parse((await invoke(status.handler, 'GET', '/model-proxy/status', '')).body)
  assert.equal(view.ruleCount, 1, 'the change still applies for this run')
})

await test('a POST with an invalid proxy is refused and changes nothing', async () => {
  const { ctx, routes, writes } = fakeContext()
  module.apply(ctx, {})
  const apply = routes.find((route) => route.path === '/model-proxy/apply')

  const body = JSON.stringify({ proxy: 'socks5://127.0.0.1:1080', models: ['gpt-6'] })
  const response = await invoke(apply.handler, 'POST', '/model-proxy/apply', body)

  assert.equal(response.status, 400)
  assert.match(response.body, /SOCKS/)
  assert.equal(writes.length, 0, 'nothing may be written for an invalid config')
})

await test('a POST with models but no proxy is refused', async () => {
  const { ctx, routes, writes } = fakeContext()
  module.apply(ctx, {})
  const apply = routes.find((route) => route.path === '/model-proxy/apply')
  const response = await invoke(apply.handler, 'POST', '/model-proxy/apply', JSON.stringify({
    proxy: '',
    models: ['gpt-6'],
  }))
  assert.equal(response.status, 400)
  assert.equal(writes.length, 0)
})

await test('a malformed body is refused, not applied', async () => {
  const { ctx, routes, writes } = fakeContext()
  module.apply(ctx, {})
  const apply = routes.find((route) => route.path === '/model-proxy/apply')
  const response = await invoke(apply.handler, 'POST', '/model-proxy/apply', '{not json')
  assert.equal(response.status, 400)
  assert.equal(writes.length, 0)
})

await test('clearing the models stops routing without touching the proxy', async () => {
  const { ctx, routes, writes } = fakeContext()
  module.apply(ctx, { proxy: 'http://127.0.0.1:10808', models: ['gpt-6'] })
  const apply = routes.find((route) => route.path === '/model-proxy/apply')

  const response = await invoke(
    apply.handler,
    'POST',
    '/model-proxy/apply',
    JSON.stringify({ proxy: 'http://127.0.0.1:10808', models: [], log: false }),
  )
  assert.equal(response.status, 202)
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].next.models, [])
  const body = JSON.parse(response.body)
  assert.equal(body.ruleCount, 0, 'no ticked model means no routing')
})

await test('a legacy { proxies, rules } config is migrated, not dropped', async () => {
  const { ctx, routes } = fakeContext()
  module.apply(ctx, {
    proxies: { local: 'http://127.0.0.1:10808' },
    rules: [{ model: 'deepseek/v4', proxy: 'local' }],
  })
  const status = routes.find((route) => route.path === '/model-proxy/status')
  const body = JSON.parse((await invoke(status.handler, 'GET', '/model-proxy/status', '')).body)
  assert.equal(body.proxy, 'http://127.0.0.1:10808')
  assert.deepEqual(body.models, ['deepseek/v4'])
  assert.equal(body.ruleCount, 1)
})

await test('the Host fence is honoured', async () => {
  const { ctx, routes } = fakeContext()
  ctx.connection.requestRejection = () => 403
  module.apply(ctx, {})
  const panel = routes.find((route) => route.path === '/model-proxy')
  const response = await invoke(panel.handler, 'GET', '/model-proxy', '')
  assert.equal(response.status, 403)
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
