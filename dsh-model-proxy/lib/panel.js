/**
 * `panel.js` — a script-free HTML panel at `/model-proxy`.
 *
 * No build step, no client bundle: the page is one document the Host renders,
 * and every action is an ordinary form POST. That keeps the plugin installable
 * from git without a compile step and keeps the panel working when the SPA
 * client cannot load.
 *
 * The panel is deliberately not in Settings → Plugins: `dsh-host-apiproxy`
 * serves settings namespaces from a hard-coded whitelist, so a third-party
 * namespace answers `settings-not-exposed`. A route of its own is the supported
 * way in.
 *
 * @module dsh-model-proxy/panel
 */

/** Escape text for HTML text and attribute positions. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const PAGE_CSS = `
:root { color-scheme: light dark; --line: color-mix(in srgb, currentColor 18%, transparent); --muted: color-mix(in srgb, currentColor 55%, transparent); }
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem 1rem; font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 60rem; margin: 0 auto; display: grid; gap: 1rem; }
h1 { font-size: 1.25rem; margin: 0; }
h2 { font-size: 1rem; margin: 0 0 .75rem; }
.card { border: 1px solid var(--line); border-radius: .5rem; padding: 1rem; }
label { display: block; font-size: .8rem; color: var(--muted); margin-bottom: .25rem; }
input[type=text], select, textarea { width: 100%; padding: .45rem .55rem; border: 1px solid var(--line); border-radius: .375rem; background: transparent; color: inherit; font: inherit; }
textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; min-height: 9rem; }
.row { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); }
.field { margin-bottom: .75rem; }
button { padding: .45rem .9rem; border-radius: .375rem; border: 1px solid var(--line); background: color-mix(in srgb, currentColor 8%, transparent); color: inherit; font: inherit; cursor: pointer; }
button:hover { background: color-mix(in srgb, currentColor 14%, transparent); }
.muted { color: var(--muted); }
.status { margin-top: .75rem; font-size: .85rem; }
.status.error { color: #d33; }
.status.ok { color: #2a8; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; margin: 0; font-size: .85rem; }
dt { color: var(--muted); }
dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
ul.problems { margin: .5rem 0 0; padding-left: 1.25rem; color: #d33; font-size: .85rem; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
`

/**
 * Render the panel.
 *
 * @param {object} state what the Host knows right now.
 * @param {object} state.config the current entry config.
 * @param {string} state.activeGlobal the installed global policy, as a phrase.
 * @param {string[]} state.problems configuration problems, already human-readable.
 * @param {string[]} state.recent the last few routing decisions.
 * @param {{ kind: string, text: string } | null} state.message the result of the last action.
 * @returns {string} a complete HTML document.
 */
export function renderPanel({ config, activeGlobal, problems = [], recent = [], message = null }) {
  const global = config?.global ?? {}
  const rulesText = (Array.isArray(config?.rules) ? config.rules : [])
    .map((rule) => {
      const field = (name) => (rule?.[name] === undefined ? '' : String(rule[name]))
      const parts = []
      if (field('provider') !== '') parts.push(`provider: ${field('provider')}`)
      if (field('model') !== '') parts.push(`model: ${field('model')}`)
      if (field('host') !== '') parts.push(`host: ${field('host')}`)
      parts.push(`proxy: ${field('proxy')}`)
      return parts.join('  ')
    })
    .join('\n')

  const proxiesText = Object.entries(config?.proxies ?? {})
    .map(([name, url]) => `${name}: ${url}`)
    .join('\n')

  const modeOptions = ['system', 'direct', 'proxy']
    .map((mode) => `<option value="${mode}"${String(global.mode ?? 'system') === mode ? ' selected' : ''}>${mode}</option>`)
    .join('')

  const recentList = recent.length === 0
    ? '<p class="muted">还没有请求。</p>'
    : `<ul class="muted">${recent.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`

  const problemsBlock = problems.length === 0
    ? ''
    : `<ul class="problems">${problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join('')}</ul>`

  const messageBlock = message === null
    ? ''
    : `<p class="status ${message.kind === 'error' ? 'error' : 'ok'}">${escapeHtml(message.text)}</p>`

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepSeek Harness · 模型代理</title>
<style>${PAGE_CSS}</style></head>
<body><main>
  <h1>模型代理</h1>
  <p class="muted">切换全局代理立即生效，无需重启；按模型规则优先于全局设置。</p>

  <section class="card">
    <h2>当前状态</h2>
    <dl>
      <dt>全局 dispatcher</dt><dd>${escapeHtml(activeGlobal)}</dd>
      <dt>undici</dt><dd>本插件自带（跨副本共享 globalThis dispatcher）</dd>
    </dl>
    ${problemsBlock}
  </section>

  <form method="post" action="/model-proxy/apply">
    <section class="card">
      <h2>全局代理</h2>
      <div class="row">
        <div class="field">
          <label for="globalMode">模式</label>
          <select id="globalMode" name="globalMode">
            ${modeOptions}
          </select>
        </div>
        <div class="field">
          <label for="globalUrl">代理地址（mode=proxy 时必填）</label>
          <input id="globalUrl" name="globalUrl" type="text"
                 value="${escapeHtml(global.url ?? '')}"
                 placeholder="http://127.0.0.1:10808">
        </div>
        <div class="field">
          <label for="noProxy">绕过列表（逗号或空格分隔）</label>
          <input id="noProxy" name="noProxy" type="text"
                 value="${escapeHtml(global.noProxy ?? '')}"
                 placeholder="*.internal, example.com">
        </div>
      </div>
      <p class="muted">loopback 始终绕过，这一条不可配置。</p>
    </section>

    <section class="card" style="margin-top:1rem">
      <h2>命名代理</h2>
      <div class="field">
        <label for="proxies">每行一个 <code>名字: 地址</code></label>
        <textarea id="proxies" name="proxies" spellcheck="false">${escapeHtml(proxiesText)}</textarea>
      </div>
    </section>

    <section class="card" style="margin-top:1rem">
      <h2>按模型规则</h2>
      <div class="field">
        <label for="rules">每行一条规则，字段用空格分隔，首个命中生效</label>
        <textarea id="rules" name="rules" spellcheck="false"
          placeholder="provider: command model: deepseek/deepseek-v4.1-flash proxy: local">${escapeHtml(rulesText)}</textarea>
      </div>
      <div class="row">
        <div class="field">
          <label for="defaultMode">未命中时</label>
          <select id="defaultMode" name="defaultMode">
            <option value="system"${String(config?.defaultMode ?? 'system') === 'system' ? ' selected' : ''}>system（跟随全局）</option>
            <option value="direct"${String(config?.defaultMode ?? 'system') === 'direct' ? ' selected' : ''}>direct（直连）</option>
          </select>
        </div>
        <div class="field">
          <label for="log">记录决策</label>
          <select id="log" name="log">
            <option value="off"${config?.log === true ? '' : ' selected'}>关</option>
            <option value="on"${config?.log === true ? ' selected' : ''}>开</option>
          </select>
        </div>
      </div>
      <p class="muted">规则字段：<code>provider</code> / <code>model</code> / <code>host</code>，至少写一个；
      代理值可以是命名代理名、<code>direct</code>、<code>system</code> 或完整 URL。</p>
    </section>

    <div style="margin-top:1rem; display:flex; gap:.5rem">
      <button type="submit" name="action" value="apply">保存并应用</button>
      <button type="submit" name="action" value="reset">直连（清空代理）</button>
    </div>
    ${messageBlock}
  </form>

  <section class="card">
    <h2>最近决策</h2>
    ${recentList}
  </section>
</main></body></html>`
}
