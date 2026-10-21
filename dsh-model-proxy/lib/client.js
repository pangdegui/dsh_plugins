/**
 * dsh-model-proxy — browser half.
 *
 * A **Settings section** of its own (设置 → 模型代理). The page asks the two
 * questions the plugin actually answers:
 *
 *   1. **一个代理** — the address every routed request goes through.
 *   2. **哪些模型生效** — a tick list of the models this deployment offers.
 *
 * The stored shape is `{ proxy, models, log }` (see `lib/config.js`), and the
 * rules it compiles to stay an implementation detail. The page only reads JSON
 * from the Host routes and posts a new config back.
 *
 * Current client-plugin conventions this file follows:
 *
 *   - **Bundle protocol.** One lazy factory registered under the package name
 *     via `window.__ModuleLoader__.load`. React comes from the browser module
 *     table; the package needs no bundler and no CDN script.
 *   - **No Harness Client packages.** Controls are plain React elements that
 *     copy the host's markup, sizing and behavior (`role="switch"` with
 *     `aria-checked`, labelled inputs, focus-visible rings). Importing
 *     `@deepseek-ai/dsh-client-ui-primitives` is what the current guidance
 *     rules out: those packages change without notice and a throwing component
 *     blanks the slot entry.
 *   - **Theme tokens only.** The stylesheet below references the current
 *     `--dsw-alias-*` palette (`border-l1`, `bg-layer-1`, `brand-primary`,
 *     `state-*`), so the page follows light/dark and any re-themed deployment.
 *     The stylesheet is inserted from `apply` and removed by its disposer.
 *   - **Locale through the service.** Dictionaries are registered under the
 *     `modelProxy` namespace and the nav label is a thunk, so both follow a
 *     live language switch without re-registering the section.
 */

window.__ModuleLoader__.load({
  id: 'dsh-model-proxy',
  factory: (require) => {
    const React = require('react')
    /** Children are positional here, exactly as in React.createElement. */
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const inject = ['slots', 'locale']

    /** Nav identity: one id for the settings section and its dictionaries. */
    const SECTION_ID = 'model-proxy'
    const NS = 'modelProxy'

    const STATUS_PATH = '/model-proxy/status'
    const APPLY_PATH = '/model-proxy/apply'
    const MODELS_PATH = '/model-proxy/models'

    /** Marks the one stylesheet this module owns, so a reload never stacks. */
    const STYLE_ID = 'dsh-model-proxy'

    // --- copy ------------------------------------------------------------------

    const zh = {
      nav: '模型代理',
      title: '模型代理',
      intro: '填写一个代理地址，然后勾选要走这个代理的模型。未勾选的模型完全不受影响，保持原有的网络路径。',

      proxyLabel: '代理地址',
      proxyPlaceholder: 'http://127.0.0.1:10808',
      proxyHint: '只支持 http:// 和 https://。SOCKS 代理不被支持。',
      proxyUnset: '尚未填写',

      modelsLabel: '生效的模型',
      modelsHint: '勾选的模型请求会走上面的代理；其余模型不受影响。',
      modelsEmpty: '没有可选的模型：当前部署没有报告任何 provider。',
      modelsLoading: '正在读取模型列表…',
      modelsFailed: '读取模型列表失败：{error}',
      modelsSelectAll: '全选',
      modelsSelectNone: '全不选',
      modelsSelected: '已选 {count} 个',
      modelsSearch: '搜索模型',
      modelsGroupOther: '其他',

      logLabel: '记录路由决策',
      logHint: '开启后每个决策在 Host 日志里输出一行，排查连接问题时有用。',

      save: '保存',
      saving: '保存中…',
      saved: '已保存，正在应用…',
      saveFailed: '保存失败：{error}',
      reload: '重新读取',
      dirty: '有未保存的改动',
      unchanged: '没有改动',

      loadFailed: '读取配置失败：{error}',
      scopeNote: '作用范围仅限模型对话。模型发现、网页抓取、插件安装与子进程都不经此代理。',

      sectionStatus: '状态',
      statusTransport: '传输层',
      statusReady: '就绪',
      statusNotReady: '未就绪',
      statusActive: '连接',
      statusNone: '尚未建立连接',
      statusRouting: '生效模型',
      statusRoutingCount: '{count} 个',
      statusRoutingNone: '无',
      problems: '配置问题',
    }

    const en = {
      nav: 'Model proxy',
      title: 'Model proxy',
      intro:
        'Enter one proxy address, then tick the models that should use it. Unticked models are left completely alone and keep their original network path.',

      proxyLabel: 'Proxy address',
      proxyPlaceholder: 'http://127.0.0.1:10808',
      proxyHint: 'Only http:// and https:// are supported. SOCKS proxies are not.',
      proxyUnset: 'Not set',

      modelsLabel: 'Models that use it',
      modelsHint: 'Ticked models are sent through the proxy above; every other model is unaffected.',
      modelsEmpty: 'No models to choose from: this deployment reports no provider.',
      modelsLoading: 'Loading models…',
      modelsFailed: 'Could not load models: {error}',
      modelsSelectAll: 'Select all',
      modelsSelectNone: 'Select none',
      modelsSelected: '{count} selected',
      modelsSearch: 'Search models',
      modelsGroupOther: 'Other',

      logLabel: 'Log routing decisions',
      logHint: 'Logs one line per decision to the Host log, which helps when a connection fails.',

      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved, applying…',
      saveFailed: 'Save failed: {error}',
      reload: 'Reload',
      dirty: 'Unsaved changes',
      unchanged: 'No changes',

      loadFailed: 'Could not load the configuration: {error}',
      scopeNote:
        'Scope is model conversations only. Model discovery, web fetch, plugin installs and subprocesses do not use this proxy.',

      sectionStatus: 'Status',
      statusTransport: 'Transport',
      statusReady: 'ready',
      statusNotReady: 'not ready',
      statusActive: 'Connection',
      statusNone: 'none yet',
      statusRouting: 'Models routed',
      statusRoutingCount: '{count}',
      statusRoutingNone: 'none',
      problems: 'Configuration problems',
    }

    // --- styles ----------------------------------------------------------------
    // One plugin-owned sheet, keyed to the current theme tokens. Class names are
    // prefixed so they cannot collide with the host or another plugin.

    const CSS = `
.dmp_page { display:flex; flex-direction:column; gap:24px; color:var(--dsw-alias-label-primary); font-size:13px; line-height:20px; }
.dmp_header { display:flex; flex-direction:column; gap:6px; }
.dmp_title { margin:0; font-size:16px; font-weight:600; line-height:24px; }
.dmp_section { display:flex; flex-direction:column; gap:10px; }
.dmp_sectionHead { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
.dmp_label { margin:0; font-size:13px; font-weight:600; line-height:20px; }
.dmp_hint { margin:0; font-size:12px; line-height:18px; color:var(--dsw-alias-label-secondary); }
.dmp_error { margin:0; font-size:12px; line-height:18px; color:var(--dsw-alias-state-error-primary); }
.dmp_success { margin:0; font-size:12px; line-height:18px; color:var(--dsw-alias-state-success-primary); }
.dmp_input { box-sizing:border-box; width:100%; height:32px; padding:0 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; }
.dmp_input::placeholder { color:var(--dsw-alias-label-secondary); }
.dmp_input:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:-1px; border-color:transparent; }
.dmp_tools { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dmp_tools .dmp_input { flex:1 1 220px; width:auto; }
.dmp_textButton { padding:3px 8px; border:none; border-radius:var(--dsw-radius-md); background:transparent; color:var(--dsw-alias-brand-primary); font:inherit; font-size:12px; cursor:pointer; }
.dmp_textButton:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); }
.dmp_textButton:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.dmp_textButton:disabled { opacity:.5; cursor:default; }
.dmp_list { display:flex; flex-direction:column; max-height:260px; overflow-y:auto; border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md); padding:6px 8px; background:var(--dsw-alias-bg-layer-1); }
.dmp_group { margin:10px 0 2px; font-size:11px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--dsw-alias-label-secondary); }
.dmp_modelRow { display:flex; align-items:center; gap:10px; margin:0 -8px; padding:6px 8px; border-radius:var(--dsw-radius-md); cursor:pointer; font-size:13px; }
.dmp_modelRow:hover { background:var(--dsw-alias-bg-layer-2); }
.dmp_check { flex:none; width:14px; height:14px; margin:0; accent-color:var(--dsw-alias-brand-primary); }
.dmp_modelName { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dmp_modelId { font-size:12px; color:var(--dsw-alias-label-secondary); }
.dmp_rowBetween { display:flex; align-items:center; justify-content:space-between; gap:16px; }
.dmp_stack { display:flex; flex-direction:column; gap:4px; min-width:0; }
.dmp_switch { position:relative; flex:none; width:34px; height:20px; padding:0; border:1px solid var(--dsw-alias-border-l2); border-radius:999px; background:var(--dsw-alias-bg-layer-2); cursor:pointer; transition:background-color .15s ease, border-color .15s ease; }
.dmp_switch[aria-checked="true"] { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.dmp_switch:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.dmp_knob { position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%; background:#fff; box-shadow:0 1px 2px rgb(0 0 0 / .25); transition:transform .15s ease; }
.dmp_switch[aria-checked="true"] .dmp_knob { transform:translateX(14px); }
.dmp_actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.dmp_button { height:32px; padding:0 14px; border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md); background:transparent; color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; cursor:pointer; }
.dmp_button:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); }
.dmp_button:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.dmp_button:disabled { opacity:.5; cursor:default; }
.dmp_primary { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); color:#fff; }
.dmp_primary:hover:not(:disabled) { background:var(--dsw-alias-brand-primary); filter:brightness(1.06); }
.dmp_meta { display:flex; gap:16px; flex-wrap:wrap; font-size:12px; color:var(--dsw-alias-label-secondary); }
.dmp_metaItem { display:inline-flex; align-items:center; gap:6px; }
.dmp_dot { flex:none; width:6px; height:6px; border-radius:50%; }
.dmp_dotOk { background:var(--dsw-alias-state-success-primary); }
.dmp_dotBad { background:var(--dsw-alias-state-error-primary); }
@media (prefers-reduced-motion: reduce) { .dmp_switch, .dmp_knob { transition:none; } }
`

    /**
     * Insert the plugin stylesheet, replacing one this module left behind.
     *
     * Guarded for a non-DOM load (self-tests evaluate the factory without a
     * `document`) and idempotent across reloads.
     *
     * @returns {() => void} the disposer that removes this sheet.
     */
    function installStyles() {
      if (typeof document === 'undefined' || document.head === null) return () => {}
      for (const old of document.querySelectorAll(`style[data-plugin-css="${STYLE_ID}"]`)) old.remove()
      const tag = document.createElement('style')
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    // --- transport -------------------------------------------------------------

    const readJson = async (url, init) => {
      const response = await fetch(url, init)
      let body = {}
      try {
        body = await response.json()
      } catch {
        body = {}
      }
      if (!response.ok || body.ok !== true) {
        throw new Error(
          typeof body.error === 'string' && body.error !== '' ? body.error : `HTTP ${String(response.status)}`,
        )
      }
      return body
    }

    /** Every model id the Host reported, flattened. */
    const allModelIds = (providers) =>
      (Array.isArray(providers) ? providers : []).flatMap((group) =>
        (Array.isArray(group?.models) ? group.models : []).map((model) => model.id),
      )

    // --- the page ---------------------------------------------------------------

    function ModelProxySection(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const [status, setStatus] = useState(null)
      const [providers, setProviders] = useState(null)
      const [modelsError, setModelsError] = useState(null)
      const [modelsLoading, setModelsLoading] = useState(true)

      const [proxy, setProxy] = useState('')
      const [models, setModels] = useState([])
      const [log, setLog] = useState(false)
      const [query, setQuery] = useState('')

      const [loadError, setLoadError] = useState(null)
      const [saving, setSaving] = useState(false)
      const [notice, setNotice] = useState(null)

      /** The state the file has, which is what "dirty" compares against. */
      const [baseline, setBaseline] = useState({ proxy: '', models: [], log: false })

      const adopt = useCallback((body) => {
        const next = {
          proxy: typeof body.proxy === 'string' ? body.proxy : '',
          models: Array.isArray(body.models) ? body.models : [],
          log: body.log === true,
        }
        setStatus(body)
        setBaseline(next)
        setProxy(next.proxy)
        setModels(next.models)
        setLog(next.log)
      }, [])

      const refresh = useCallback(async () => {
        try {
          adopt(await readJson(STATUS_PATH))
          setLoadError(null)
        } catch (cause) {
          setLoadError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [adopt])

      const loadModels = useCallback(async () => {
        setModelsLoading(true)
        try {
          const body = await readJson(MODELS_PATH)
          setProviders(Array.isArray(body.providers) ? body.providers : [])
          setModelsError(null)
        } catch (cause) {
          setProviders([])
          setModelsError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setModelsLoading(false)
        }
      }, [])

      useEffect(() => {
        void refresh()
        void loadModels()
      }, [refresh, loadModels])

      const dirty = useMemo(() => {
        const same =
          proxy === baseline.proxy &&
          log === baseline.log &&
          models.length === baseline.models.length &&
          models.every((id) => baseline.models.includes(id))
        return !same
      }, [proxy, models, log, baseline])

      /** A model ticked in the file but no longer offered still shows, or it could never be unticked. */
      const groups = useMemo(() => {
        const reported = Array.isArray(providers) ? providers : []
        const known = new Set(allModelIds(reported))
        const orphans = models.filter((id) => !known.has(id))
        const list = reported.map((group) => ({
          provider: group.provider,
          name: group.name,
          models: (Array.isArray(group.models) ? group.models : []).filter((model) =>
            query === '' ? true : `${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase()),
          ),
        }))
        if (orphans.length > 0) {
          list.push({
            provider: '__stale__',
            name: t('modelsGroupOther'),
            models: orphans
              .filter((id) => (query === '' ? true : id.toLowerCase().includes(query.toLowerCase())))
              .map((id) => ({ id, name: id })),
          })
        }
        return list.filter((group) => group.models.length > 0)
      }, [providers, models, query, t])

      const toggle = useCallback((id, checked) => {
        setModels((current) => {
          if (checked) return current.includes(id) ? current : [...current, id]
          return current.filter((candidate) => candidate !== id)
        })
      }, [])

      const submit = useCallback(async () => {
        setSaving(true)
        setNotice(null)
        try {
          await readJson(APPLY_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ proxy, models, log }),
          })
          setNotice({ kind: 'ok', text: t('saved') })
          // A persisted write reloads the plugin; give it a moment to settle.
          await new Promise((resolve) => setTimeout(resolve, 1200))
          await refresh()
        } catch (cause) {
          setNotice({
            kind: 'error',
            text: t('saveFailed', { error: cause instanceof Error ? cause.message : String(cause) }),
          })
        } finally {
          setSaving(false)
        }
      }, [proxy, models, log, refresh, t])

      if (loadError !== null) {
        return h('div', { className: 'dmp_page' }, [
          h('h2', { key: 'title', className: 'dmp_title' }, t('title')),
          h('p', { key: 'err', className: 'dmp_error', role: 'alert' }, t('loadFailed', { error: loadError })),
          h(
            'button',
            { key: 'reload', type: 'button', className: 'dmp_button', onClick: () => void refresh() },
            t('reload'),
          ),
        ])
      }

      const problems = Array.isArray(status?.problems) ? status.problems : []
      const routed = typeof status?.ruleCount === 'number' ? status.ruleCount : 0

      const visibleIds = groups.flatMap((group) => group.models.map((model) => model.id))
      const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => models.includes(id))

      const modelRows =
        groups.length === 0
          ? [h('p', { key: 'empty', className: 'dmp_hint' }, t('modelsEmpty'))]
          : groups.flatMap((group) => [
              h('p', { key: `g-${group.provider}`, className: 'dmp_group' }, group.name),
              ...group.models.map((model) =>
                h('label', { key: `${group.provider}/${model.id}`, className: 'dmp_modelRow' }, [
                  h('input', {
                    key: 'c',
                    type: 'checkbox',
                    className: 'dmp_check',
                    checked: models.includes(model.id),
                    onChange: (event) => {
                      toggle(model.id, event.target.checked)
                    },
                  }),
                  h('span', { key: 'n', className: 'dmp_modelName' }, model.name === model.id ? model.id : model.name),
                  model.name === model.id ? null : h('span', { key: 'id', className: 'dmp_modelId' }, model.id),
                ]),
              ),
            ])

      return h('div', { className: 'dmp_page' }, [
        h('header', { key: 'head', className: 'dmp_header' }, [
          h('h2', { key: 'title', className: 'dmp_title' }, t('title')),
          h('p', { key: 'intro', className: 'dmp_hint' }, t('intro')),
        ]),

        // 1. the one proxy
        h('section', { key: 'proxy', className: 'dmp_section' }, [
          h('h3', { key: 'h', className: 'dmp_label' }, t('proxyLabel')),
          h('input', {
            key: 'i',
            type: 'text',
            className: 'dmp_input',
            spellCheck: false,
            placeholder: t('proxyPlaceholder'),
            value: proxy,
            'aria-label': t('proxyLabel'),
            onChange: (event) => {
              setProxy(event.target.value)
            },
          }),
          h('p', { key: 'hint', className: 'dmp_hint' }, t('proxyHint')),
        ]),

        // 2. which models it applies to
        h('section', { key: 'models', className: 'dmp_section' }, [
          h('div', { key: 'head', className: 'dmp_sectionHead' }, [
            h('h3', { key: 'h', className: 'dmp_label' }, t('modelsLabel')),
            h('span', { key: 'count', className: 'dmp_hint' }, t('modelsSelected', { count: String(models.length) })),
          ]),
          h('p', { key: 'hint', className: 'dmp_hint' }, t('modelsHint')),

          modelsLoading ? h('p', { key: 'loading', className: 'dmp_hint' }, t('modelsLoading')) : null,
          modelsError !== null ? h('p', { key: 'err', className: 'dmp_error' }, t('modelsFailed', { error: modelsError })) : null,

          h('div', { key: 'tools', className: 'dmp_tools' }, [
            h(
              'button',
              {
                key: 'all',
                type: 'button',
                className: 'dmp_textButton',
                onClick: () => {
                  setModels(
                    allVisibleSelected
                      ? models.filter((id) => !visibleIds.includes(id))
                      : [...new Set([...models, ...visibleIds])],
                  )
                },
                disabled: visibleIds.length === 0,
              },
              allVisibleSelected ? t('modelsSelectNone') : t('modelsSelectAll'),
            ),
            allModelIds(providers).length > 6
              ? h('input', {
                  key: 'q',
                  type: 'text',
                  className: 'dmp_input',
                  placeholder: t('modelsSearch'),
                  'aria-label': t('modelsSearch'),
                  value: query,
                  onChange: (event) => {
                    setQuery(event.target.value)
                  },
                })
              : null,
          ]),

          h(
            'div',
            { key: 'list', className: 'dmp_list', role: 'group', 'aria-label': t('modelsLabel') },
            modelRows,
          ),
        ]),

        // 3. diagnostics, kept quiet and last
        h('section', { key: 'log', className: 'dmp_rowBetween' }, [
          h('div', { key: 'text', className: 'dmp_stack' }, [
            h('span', { key: 'l', className: 'dmp_label' }, t('logLabel')),
            h('span', { key: 'h', className: 'dmp_hint' }, t('logHint')),
          ]),
          h(
            'button',
            {
              key: 's',
              type: 'button',
              role: 'switch',
              'aria-checked': log,
              'aria-label': t('logLabel'),
              className: 'dmp_switch',
              onClick: () => {
                setLog(!log)
              },
            },
            h('span', { key: 'k', className: 'dmp_knob' }),
          ),
        ]),

        h('div', { key: 'actions', className: 'dmp_actions' }, [
          h(
            'button',
            {
              key: 'save',
              type: 'button',
              className: 'dmp_button dmp_primary',
              onClick: () => void submit(),
              disabled: saving || !dirty,
            },
            saving ? t('saving') : t('save'),
          ),
          h(
            'button',
            { key: 'reload', type: 'button', className: 'dmp_button', onClick: () => void refresh(), disabled: saving },
            t('reload'),
          ),
          h('span', { key: 'state', className: 'dmp_hint' }, dirty ? t('dirty') : t('unchanged')),
        ]),

        notice === null
          ? null
          : h(
              'p',
              { key: 'notice', className: notice.kind === 'ok' ? 'dmp_success' : 'dmp_error', role: 'status' },
              notice.text,
            ),

        problems.length > 0
          ? h('section', { key: 'problems', className: 'dmp_section' }, [
              h('h3', { key: 'h', className: 'dmp_label' }, t('problems')),
              ...problems.map((line, index) => h('p', { key: index, className: 'dmp_error' }, line)),
            ])
          : null,

        h('p', { key: 'scope', className: 'dmp_hint' }, t('scopeNote')),

        h('section', { key: 'status', className: 'dmp_section' }, [
          h('h3', { key: 'h', className: 'dmp_label' }, t('sectionStatus')),
          h('div', { key: 'meta', className: 'dmp_meta' }, [
            h('span', { key: 't', className: 'dmp_metaItem' }, [
              h('span', {
                key: 'd',
                className: `dmp_dot ${status?.transport === true ? 'dmp_dotOk' : 'dmp_dotBad'}`,
                'aria-hidden': true,
              }),
              `${t('statusTransport')}: ${status?.transport === true ? t('statusReady') : t('statusNotReady')}`,
            ]),
            h('span', { key: 'a', className: 'dmp_metaItem' }, `${t('statusActive')}: ${status?.active ?? t('statusNone')}`),
            h(
              'span',
              { key: 'r', className: 'dmp_metaItem' },
              `${t('statusRouting')}: ${routed === 0 ? t('statusRoutingNone') : t('statusRoutingCount', { count: String(routed) })}`,
            ),
          ]),
        ]),
      ])
    }

    // --- plugin ----------------------------------------------------------------

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-model-proxy: dictionaries')
      ctx.effect(installStyles, 'dsh-model-proxy: styles')

      // One section of its own, ordered after the shipped ones so it reads as an
      // addition rather than displacing a built-in page.
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: SECTION_ID,
            order: 60,
            label: () => t('nav'),
            locale: NS,
          },
          (slotProps) => h(ModelProxySection, { ...slotProps, t }),
        ),
      )
    }

    return { apply, inject, name: 'model-proxy' }
  },
})
