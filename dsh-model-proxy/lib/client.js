/**
 * dsh-model-proxy — browser half.
 *
 * A **Settings section** of its own (设置 → 模型代理), not a bare route. The
 * panel that shipped first was a routable page you had to know the URL for;
 * a proxy is ordinary configuration and belongs where configuration lives.
 *
 * The page asks the one question the plugin actually answers:
 *
 *   1. **一个代理** — the address every routed request goes through.
 *   2. **哪些模型生效** — a tick list of the models this deployment offers.
 *
 * The first version of this page exposed the whole rule language (named proxies,
 * provider/host selectors, a per-rule target) as two small textareas. That is a
 * configuration file wearing a form's clothes: it makes the common case — "send
 * these models through my proxy" — the hardest one to type. The stored shape is
 * now `{ proxy, models, log }` (see `lib/config.js`), and the rules it compiles
 * to stay an implementation detail.
 *
 * Two decisions worth knowing:
 *
 *   - **Own section, not a tab inside an existing one.** `settings.section` is
 *     an open `list` slot with `replaceRisk: none`, so a plugin may add a nav
 *     entry. The shipped "Models" and "Plugins" sections are single components
 *     owned by official packages: a third party can add a *tab* under Plugins
 *     but cannot contribute a form to Models, and Plugins is documented as the
 *     list of plugins the deployment *ships*, which this is not.
 *
 *   - **Plain factory, no build step.** The client module system loads this file
 *     through `window.__ModuleLoader__.load`, so requirements are the ones the
 *     composition already provides (`react`, `@deepseek-ai/dsh-client-ui-primitives`)
 *     and the package needs no bundler. That is what keeps the plugin
 *     installable straight from git.
 *
 * The page talks to this plugin's own Host routes rather than to
 * `remote.settings`: `settings/describe` only lists entries whose plugin exports
 * a `Config` schema, and a model list is not a scalar field a generated form can
 * edit. The Host routes already validate and persist through `configEditor`, so
 * the browser half only has to render fields and read JSON.
 */

window.__ModuleLoader__.load({
  id: 'dsh-model-proxy',
  factory: (require) => {
    const React = require('react')
    /** Children are positional here, exactly as in React.createElement. */
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = null
    }
    const Button = primitives?.Button
    const Checkbox = primitives?.Checkbox
    const Input = primitives?.Input
    const Switch = primitives?.Switch
    const StateDot = primitives?.StateDot

    const inject = ['slots', 'locale']

    /** Nav identity: one id for the settings section and its dictionary. */
    const SECTION_ID = 'model-proxy'
    const NS = 'modelProxy'

    const STATUS_PATH = '/model-proxy/status'
    const APPLY_PATH = '/model-proxy/apply'
    const MODELS_PATH = '/model-proxy/models'

    /** Matches the `--dsw-radius-*` scale the rest of Settings uses. */
    const RADIUS = 'var(--dsw-radius-md)'
    const LINE = 'var(--dsw-alias-line-secondary)'
    const LABEL = 'var(--dsw-alias-label-primary)'
    const MUTED = 'var(--dsw-alias-label-secondary)'
    const ERROR = 'var(--dsw-alias-state-error-primary)'
    const SUCCESS = 'var(--dsw-alias-state-success-primary)'
    const HOVER = 'var(--dsw-alias-interactive-bg-hover)'

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
      sectionRecent: '最近决策',
      noRecent: '还没有请求。',
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
      sectionRecent: 'Recent decisions',
      noRecent: 'No requests yet.',
      problems: 'Configuration problems',
    }

    // --- styling ---------------------------------------------------------------
    // Inline styles rather than a stylesheet: this file is loaded as a plain
    // factory with no CSS pipeline, and the handful of rules here are not worth
    // injecting a <style> tag for. Colours come from the `--dsw-*` tokens so the
    // page follows the user's theme without knowing what the theme is.

    const pageStyle = { display: 'flex', flexDirection: 'column', gap: 24 }
    const titleStyle = { margin: 0, fontSize: 17, fontWeight: 600, color: LABEL }
    const introStyle = { margin: '8px 0 0', fontSize: 13, lineHeight: '20px', color: MUTED }
    const groupStyle = { display: 'flex', flexDirection: 'column', gap: 10 }
    const groupTitleStyle = { margin: 0, fontSize: 13, fontWeight: 600, color: LABEL }
    const hintStyle = { margin: 0, fontSize: 12, lineHeight: '18px', color: MUTED }
    const errorStyle = { margin: 0, fontSize: 12, lineHeight: '18px', color: ERROR }
    const successStyle = { margin: 0, fontSize: 12, lineHeight: '18px', color: SUCCESS }

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '7px 10px',
      font: 'inherit',
      fontSize: 13,
      color: LABEL,
      background: 'var(--dsw-alias-bg-base)',
      border: `1px solid ${LINE}`,
      borderRadius: RADIUS,
    }

    /** One tickable row; the whole row is the hit target, not just the box. */
    const modelRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '7px 8px',
      margin: '0 -8px',
      borderRadius: RADIUS,
      cursor: 'pointer',
      fontSize: 13,
      color: LABEL,
    }

    const modelListStyle = {
      display: 'flex',
      flexDirection: 'column',
      maxHeight: 260,
      overflowY: 'auto',
      border: `1px solid ${LINE}`,
      borderRadius: RADIUS,
      padding: '6px 8px',
    }

    const groupHeadingStyle = {
      margin: '10px 0 2px',
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      color: MUTED,
    }

    const modelIdStyle = { fontSize: 12, color: MUTED }

    const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
    const metaRowStyle = { display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: MUTED }
    const metaItemStyle = { display: 'inline-flex', alignItems: 'center', gap: 6 }
    const actionRowStyle = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }

    const textButtonStyle = {
      padding: '3px 8px',
      font: 'inherit',
      fontSize: 12,
      color: 'var(--dsw-alias-link)',
      background: 'transparent',
      border: 'none',
      borderRadius: 'var(--dsw-radius-sm)',
      cursor: 'pointer',
    }

    const fallbackButtonStyle = {
      padding: '6px 14px',
      font: 'inherit',
      fontSize: 13,
      color: LABEL,
      background: 'var(--dsw-alias-bg-base)',
      border: `1px solid ${LINE}`,
      borderRadius: RADIUS,
      cursor: 'pointer',
    }

    const plainButtonStyle = {
      padding: '6px 14px',
      font: 'inherit',
      fontSize: 13,
      color: LABEL,
      background: 'transparent',
      border: `1px solid ${LINE}`,
      borderRadius: RADIUS,
      cursor: 'pointer',
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
      const t = props.t
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
        return h('div', { style: pageStyle }, [
          h('h2', { key: 'title', style: titleStyle }, t('title')),
          h('p', { key: 'err', style: errorStyle, role: 'alert' }, t('modelsFailed', { error: loadError })),
          h(
            'button',
            { key: 'reload', type: 'button', style: plainButtonStyle, onClick: () => void refresh() },
            t('reload'),
          ),
        ])
      }

      const problems = Array.isArray(status?.problems) ? status.problems : []
      const recent = Array.isArray(status?.recent) ? status.recent : []
      const routed = typeof status?.ruleCount === 'number' ? status.ruleCount : 0

      const SaveButton =
        Button !== undefined
          ? h(Button, { key: 'save', onClick: () => void submit(), disabled: saving || !dirty }, saving ? t('saving') : t('save'))
          : h(
              'button',
              { key: 'save', type: 'button', style: fallbackButtonStyle, onClick: () => void submit(), disabled: saving || !dirty },
              saving ? t('saving') : t('save'),
            )

      const visibleIds = groups.flatMap((group) => group.models.map((model) => model.id))
      const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => models.includes(id))

      return h('div', { style: pageStyle }, [
        h('header', { key: 'head' }, [
          h('h2', { key: 'title', style: titleStyle }, t('title')),
          h('p', { key: 'intro', style: introStyle }, t('intro')),
        ]),

        // 1. the one proxy
        h('section', { key: 'proxy', style: groupStyle }, [
          h('h3', { key: 'h', style: groupTitleStyle }, t('proxyLabel')),
          Input !== undefined
            ? h(Input, {
                key: 'i',
                type: 'text',
                spellCheck: false,
                placeholder: t('proxyPlaceholder'),
                value: proxy,
                'aria-label': t('proxyLabel'),
                onChange: (event) => {
                  setProxy(event.target.value)
                },
              })
            : h('input', {
                key: 'i',
                type: 'text',
                style: inputStyle,
                spellCheck: false,
                placeholder: t('proxyPlaceholder'),
                value: proxy,
                'aria-label': t('proxyLabel'),
                onChange: (event) => {
                  setProxy(event.target.value)
                },
              }),
          h('p', { key: 'hint', style: hintStyle }, t('proxyHint')),
        ]),

        // 2. which models it applies to
        h('section', { key: 'models', style: groupStyle }, [
          h('div', { key: 'head', style: { ...rowStyle, justifyContent: 'space-between' } }, [
            h('h3', { key: 'h', style: groupTitleStyle }, t('modelsLabel')),
            h('span', { key: 'count', style: hintStyle }, t('modelsSelected', { count: String(models.length) })),
          ]),
          h('p', { key: 'hint', style: hintStyle }, t('modelsHint')),

          modelsLoading
            ? h('p', { key: 'loading', style: hintStyle }, t('modelsLoading'))
            : null,
          modelsError !== null ? h('p', { key: 'err', style: errorStyle }, t('modelsFailed', { error: modelsError })) : null,

          h('div', { key: 'tools', style: rowStyle }, [
            h(
              'button',
              {
                key: 'all',
                type: 'button',
                style: textButtonStyle,
                onClick: () => {
                  setModels(allVisibleSelected ? models.filter((id) => !visibleIds.includes(id)) : [...new Set([...models, ...visibleIds])])
                },
                disabled: visibleIds.length === 0,
              },
              allVisibleSelected ? t('modelsSelectNone') : t('modelsSelectAll'),
            ),
          ]),

          providers !== null && allModelIds(providers).length > 6
            ? Input !== undefined
              ? h(Input, {
                  key: 'q',
                  type: 'text',
                  placeholder: t('modelsSearch'),
                  'aria-label': t('modelsSearch'),
                  value: query,
                  onChange: (event) => {
                    setQuery(event.target.value)
                  },
                })
              : h('input', {
                  key: 'q',
                  type: 'text',
                  style: inputStyle,
                  placeholder: t('modelsSearch'),
                  'aria-label': t('modelsSearch'),
                  value: query,
                  onChange: (event) => {
                    setQuery(event.target.value)
                  },
                })
            : null,

          h(
            'div',
            { key: 'list', style: modelListStyle, role: 'group', 'aria-label': t('modelsLabel') },
            groups.length === 0
              ? [h('p', { key: 'empty', style: hintStyle }, t('modelsEmpty'))]
              : groups.flatMap((group) => [
                  h('p', { key: `g-${group.provider}`, style: groupHeadingStyle }, group.name),
                  ...group.models.map((model) =>
                    Checkbox !== undefined
                      ? h(
                          'label',
                          { key: `${group.provider}/${model.id}`, style: modelRowStyle },
                          [
                            h(Checkbox, {
                              key: 'c',
                              checked: models.includes(model.id),
                              label: '',
                              onChange: (checked) => {
                                toggle(model.id, checked)
                              },
                            }),
                            h('span', { key: 'n' }, model.name === model.id ? model.id : model.name),
                            model.name === model.id ? null : h('span', { key: 'id', style: modelIdStyle }, model.id),
                          ],
                        )
                      : h('label', { key: `${group.provider}/${model.id}`, style: modelRowStyle }, [
                          h('input', {
                            key: 'c',
                            type: 'checkbox',
                            checked: models.includes(model.id),
                            onChange: (event) => {
                              toggle(model.id, event.target.checked)
                            },
                          }),
                          h('span', { key: 'n' }, model.name === model.id ? model.id : model.name),
                          model.name === model.id ? null : h('span', { key: 'id', style: modelIdStyle }, model.id),
                        ]),
                  ),
                ]),
          ),
        ]),

        // 3. diagnostics, kept quiet and last
        h('section', { key: 'log', style: { ...rowStyle, justifyContent: 'space-between' } }, [
          h('div', { key: 'text', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
            h('span', { key: 'l', style: { fontSize: 13, color: LABEL } }, t('logLabel')),
            h('span', { key: 'h', style: hintStyle }, t('logHint')),
          ]),
          Switch !== undefined
            ? h(Switch, {
                key: 's',
                checked: log,
                label: t('logLabel'),
                onChange: (checked) => {
                  setLog(checked)
                },
              })
            : h('input', {
                key: 's',
                type: 'checkbox',
                checked: log,
                onChange: (event) => {
                  setLog(event.target.checked)
                },
              }),
        ]),

        h('div', { key: 'actions', style: actionRowStyle }, [
          SaveButton,
          h(
            'button',
            { key: 'reload', type: 'button', style: plainButtonStyle, onClick: () => void refresh(), disabled: saving },
            t('reload'),
          ),
          h('span', { key: 'state', style: hintStyle }, dirty ? t('dirty') : t('unchanged')),
        ]),

        notice === null
          ? null
          : h('p', { key: 'notice', style: notice.kind === 'ok' ? successStyle : errorStyle }, notice.text),

        problems.length > 0
          ? h('section', { key: 'problems', style: groupStyle }, [
              h('h3', { key: 'h', style: groupTitleStyle }, t('problems')),
              ...problems.map((line, index) => h('p', { key: index, style: errorStyle }, line)),
            ])
          : null,

        h('p', { key: 'scope', style: hintStyle }, t('scopeNote')),

        h('section', { key: 'status', style: groupStyle }, [
          h('h3', { key: 'h', style: groupTitleStyle }, t('sectionStatus')),
          h('div', { key: 'meta', style: metaRowStyle }, [
            h('span', { key: 't', style: metaItemStyle }, [
              StateDot !== undefined ? h(StateDot, { key: 'd', tone: status?.transport === true ? 'success' : 'error' }) : null,
              `${t('statusTransport')}: ${status?.transport === true ? t('statusReady') : t('statusNotReady')}`,
            ]),
            h('span', { key: 'a', style: metaItemStyle }, `${t('statusActive')}: ${status?.active ?? t('statusNone')}`),
            h(
              'span',
              { key: 'r', style: metaItemStyle },
              `${t('statusRouting')}: ${routed === 0 ? t('statusRoutingNone') : t('statusRoutingCount', { count: String(routed) })}`,
            ),
          ]),
        ]),

        h('section', { key: 'recent', style: groupStyle }, [
          h('h3', { key: 'h', style: groupTitleStyle }, t('sectionRecent')),
          recent.length === 0
            ? h('p', { key: 'none', style: hintStyle }, t('noRecent'))
            : h(
                'ul',
                { key: 'list', style: { margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: '18px', color: MUTED } },
                recent.map((line, index) => h('li', { key: index }, line)),
              ),
        ]),
      ])
    }

    // --- plugin ----------------------------------------------------------------

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-model-proxy: dictionaries')

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
