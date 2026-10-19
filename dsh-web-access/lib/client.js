/**
 * dsh-web-access — browser half.
 *
 * A first-class panel in the application chrome rather than a card buried in a
 * settings subpage:
 *
 *   - `sidebar.panellist` with id `web-access` and order 5 — the sidebar's
 *     global panel row, between the shipped `plugins` (order 0) and `schedules`
 *     (order 10) entries. The sidebar owns the button and reads its label from
 *     the list metadata, so the row costs one icon component.
 *   - `main` with key `web-access` — the central panel that entry addresses.
 *     A panellist id addresses the matching main key, so both registrations
 *     share one constant.
 *
 * Every value comes from this plugin's own Host routes, so the panel depends on
 * nothing but React and its own Host: no settings-form machinery, no other
 * plugin's composition. The artwork is drawn here and inherits `currentColor`,
 * so the sidebar's own active/hover styling reaches it without this package
 * reading another plugin's CSS.
 */

window.__ModuleLoader__.load({
  id: 'dsh-web-access',
  factory: (require) => {
    const React = require('react')
    /** Children are positional here, exactly as in React.createElement. */
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = null
    }
    const Button = primitives?.Button

    const inject = ['slots', 'locale']
    const NS = 'webAccess'
    const PANEL_ID = 'web-access'
    const CONFIG_PATH = '/dsh-access/config'
    const SETUP_PATH = '/dsh-access/setup'

    // --- copy ------------------------------------------------------------------

    const zh = {
      panel: 'Web 访问',
      title: 'Web 访问与连接验证',
      intro: '决定本机 Harness 对哪些设备可达,以及连接前是否需要动态验证码。保存后立即生效。',
      sectionAccess: '网络可达性',
      bind: '监听地址',
      bindLoopback: '127.0.0.1 — 仅本机',
      bindAll: '0.0.0.0 — 局域网(内置反向代理)',
      bindHint: '应用自身仍只监听 127.0.0.1;选中该项后,插件会在本机局域网地址的同一端口上开一个反向代理,把局域网请求转发进来。',
      lanAddress: '局域网地址',
      lanAddressHint: '留空自动选择(优先 192.168 网段);也可以固定填本机某个 IPv4。',
      lanEndpoint: '局域网入口',
      lanOff: '未启用',
      lanError: '局域网代理未监听:{error}',
      autoTrust: '信任本机局域网 IP',
      autoTrustHint: '开放监听时,自动把本机的非回环 IPv4 地址加入受信主机。关掉后只信任下面列出的地址。',
      trustedHosts: '额外受信主机',
      trustedHostsHint: '空格或逗号分隔,写 host 或 host:port。',
      save: '保存设置',
      saving: '保存中…',
      saved: '已保存,正在应用…',
      saveFailed: '保存失败:{error}',
      savePending: '已提交,但配置尚未生效。请稍候刷新;若一直不变,说明宿主写入失败,请查看宿主日志。',
      dirtyHint: '有未保存的改动',
      loadFailed: '读取配置失败:{error}',
      sectionStatus: '当前状态',
      liveBind: '实际监听',
      livePort: '端口',
      liveTrust: '受信主机',
      origins: '其他设备可访问的地址',
      loginUrl: '其他设备应打开的入口',
      tokenUrls: '带令牌的连接地址',
      tokenUrlsHint: '裸地址需要启动令牌才能登录(所以直接打开会提示 authentication required)。把下面的地址复制到另一台设备即可直接接入 —— 拿到它就等于拿到本机 Harness 的完整访问权,不要外传。',
      none: '(无)',
      refresh: '刷新',
      sectionTotp: '连接验证(TOTP)',
      totpEnabled: '启用动态验证码',
      totpEnabledHint: '开启后,登录入口要求输入验证器应用的 6 位动态码,验证通过才下发连接令牌。',
      totpGate: '验证范围',
      gateAll: '所有来源',
      gateRemote: '仅非本机来源',
      gateHint: '本机来源按 Host 是否为回环地址判断。',
      secret: '共享密钥',
      secretHint: '把密钥或 otpauth 链接录入验证器应用。密钥只保存在本机文件里,不在配置中。',
      showSecret: '显示密钥',
      rotate: '重新生成',
      rotateHint: '重新生成会让已录入的验证器立即失效。',
      copy: '复制',
      copied: '已复制',
      loading: '读取中…',
      notEnabled: '当前未启用。',
      enabledOn: '已启用(范围:{gate})',
      safety: '把监听地址开到 0.0.0.0 会让本网段任何设备都能访问这个端口;建议配合受信主机白名单与动态验证码。',
      managedError: '托管配置行写入失败:{error}',
    }

    const en = {
      panel: 'Web access',
      title: 'Web access and connection verification',
      intro: 'Choose which devices can reach this Harness, and whether a one-time code is required before connecting. Saves apply immediately.',
      sectionAccess: 'Reachability',
      bind: 'Listen address',
      bindLoopback: '127.0.0.1 — this machine only',
      bindAll: '0.0.0.0 — LAN (built-in reverse proxy)',
      bindHint: 'The application keeps listening on 127.0.0.1 only; this option makes the plugin accept LAN traffic on the same port at this machine\'s LAN address and forward it.',
      lanAddress: 'LAN address',
      lanAddressHint: 'Leave empty to pick automatically (192.168 addresses first), or pin one of this machine\'s IPv4 addresses.',
      lanEndpoint: 'LAN entry',
      lanOff: 'off',
      lanError: 'The LAN proxy is not listening: {error}',
      autoTrust: "Trust this machine's LAN IPs",
      autoTrustHint: 'While listening on all interfaces, add this machine\'s non-loopback IPv4 addresses to the trusted hosts. Off trusts only the list below.',
      trustedHosts: 'Additional trusted hosts',
      trustedHostsHint: 'Space or comma separated; host or host:port.',
      save: 'Save settings',
      saving: 'Saving…',
      saved: 'Saved, applying…',
      saveFailed: 'Save failed: {error}',
      savePending: 'Submitted, but the configuration has not taken effect. Refresh in a moment; if it never changes, the Host could not write it — check the Host log.',
      dirtyHint: 'Unsaved changes',
      loadFailed: 'Could not read settings: {error}',
      sectionStatus: 'Current status',
      liveBind: 'Listening on',
      livePort: 'Port',
      liveTrust: 'Trusted hosts',
      origins: 'Reachable from other devices',
      loginUrl: 'Entry another device should open',
      tokenUrls: 'Connection URLs carrying the launch token',
      tokenUrlsHint: 'A bare address needs the process launch token, which is why opening it directly reports "authentication required". Copy one of these to another device to connect — holding one grants full access to this Harness, so do not share it.',
      none: '(none)',
      refresh: 'Refresh',
      sectionTotp: 'Connection verification (TOTP)',
      totpEnabled: 'Require a one-time code',
      totpEnabledHint: 'The login entry then asks for the 6-digit code from your authenticator before it hands out the connection token.',
      totpGate: 'Verification scope',
      gateAll: 'Every caller',
      gateRemote: 'Non-loopback callers only',
      gateHint: 'A caller counts as local when its Host is a loopback address.',
      secret: 'Shared key',
      secretHint: 'Add the key or the otpauth link to your authenticator. The key lives in a local file, never in configuration.',
      showSecret: 'Show key',
      rotate: 'Regenerate',
      rotateHint: 'Regenerating invalidates every authenticator already enrolled.',
      copy: 'Copy',
      copied: 'Copied',
      loading: 'Loading…',
      notEnabled: 'Currently off.',
      enabledOn: 'On (scope: {gate})',
      safety: 'Listening on 0.0.0.0 exposes this port to every device on this network; pair it with a trusted-host allowlist and a one-time code.',
      managedError: 'The managed configuration rows could not be written: {error}',
    }

    const browserLanguage = () => {
      if (typeof navigator === 'undefined') return 'en'
      for (const tag of [...(navigator.languages ?? []), navigator.language]) {
        const primary = String(tag ?? '').toLowerCase().split('-')[0]
        if (primary === 'zh') return 'zh'
        if (primary === 'en') return 'en'
      }
      return 'en'
    }

    /** `t` from the slot seat when the locale service is composed, else a sniff. */
    const translator = (seat) => (key, params) => {
      const fromSeat = typeof seat === 'function' ? seat(key, params) : undefined
      const template = typeof fromSeat === 'string' && fromSeat !== key ? fromSeat : (browserLanguage() === 'zh' ? zh : en)[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match))
    }

    // --- styling ---------------------------------------------------------------

    const pageStyle = {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      maxWidth: 760,
      margin: '0 auto',
      boxSizing: 'border-box',
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-base)',
    }

    const innerStyle = {
      flex: '1 1 auto',
      minHeight: 0,
      overflowY: 'auto',
      boxSizing: 'border-box',
      padding: '28px 32px 48px',
    }

    const h1Style = { margin: '0 0 6px', fontSize: 20, fontWeight: 600 }
    const introStyle = { margin: '0 0 22px', fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }
    const sectionTitleStyle = { margin: '0 0 12px', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }

    const cardStyle = {
      marginBottom: 16,
      padding: '16px 18px',
      borderRadius: 12,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
    }

    const fieldRowStyle = { marginBottom: 14 }
    const labelStyle = { display: 'block', marginBottom: 5, fontSize: 13, fontWeight: 500 }
    const hintStyle = { margin: '5px 0 0', fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-label-secondary)' }

    const controlStyle = {
      boxSizing: 'border-box',
      padding: '6px 9px',
      borderRadius: 7,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: 13,
    }

    const checkRowStyle = { display: 'flex', gap: 9, alignItems: 'flex-start', marginBottom: 14, cursor: 'pointer' }

    const monoStyle = {
      display: 'block',
      marginTop: 6,
      padding: '9px 11px',
      borderRadius: 7,
      border: '1px dashed var(--dsw-alias-border-l2)',
      font: '12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace',
      overflowWrap: 'anywhere',
      color: 'var(--dsw-alias-label-primary)',
    }

    const kvStyle = { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', fontSize: 13, lineHeight: '20px' }
    const keyStyle = { color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' }

    const noticeStyle = (color) => ({ margin: '10px 0 0', fontSize: 12, lineHeight: '17px', color })

    const smallButtonStyle = {
      ...controlStyle,
      padding: '6px 12px',
      cursor: 'pointer',
      fontSize: 12,
    }

    // --- artwork ---------------------------------------------------------------
    // Drawn in `currentColor`, so the sidebar's own active/hover styling
    // reaches it without this package knowing any other plugin's CSS.

    function WebAccessIcon(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block' },
      }, [
        h('circle', { key: 'globe', cx: 6.6, cy: 9.4, r: 4.9, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { key: 'meridian', d: 'M1.9 9.4h9.4', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        h('path', { key: 'parallel', d: 'M3.2 6.3h6.8M3.2 12.5h6.8', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        h('path', { key: 'arc', d: 'M11.6 2.4a5.4 5.4 0 0 1 2.3 3', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('path', { key: 'arc2', d: 'M11.9 5.6a2.6 2.6 0 0 1 .9 1.4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
      ])
    }

    // --- helpers ---------------------------------------------------------------

    const readJson = async (url, init) => {
      const response = await fetch(url, init)
      let body = {}
      try {
        body = await response.json()
      } catch {
        body = {}
      }
      if (!response.ok || body.ok !== true) {
        throw new Error(typeof body.error === 'string' && body.error !== '' ? body.error : `HTTP ${String(response.status)}`)
      }
      return body
    }

    /** A save restarts this plugin, so a retry may be needed to observe it. */
    const loadConfig = async (tries = 3) => {
      let lastError
      for (let index = 0; index < tries; index += 1) {
        try {
          return await readJson(CONFIG_PATH)
        } catch (error) {
          lastError = error
          await new Promise((resolve) => { setTimeout(resolve, 350) })
        }
      }
      throw lastError
    }

    function CopyButton(props) {
      const t = props.t
      const [copied, setCopied] = useState(false)
      const copy = useCallback(() => {
        if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') return
        navigator.clipboard.writeText(props.text).then(() => {
          setCopied(true)
          setTimeout(() => { setCopied(false) }, 1600)
        }, () => { /* clipboard refusals are not worth surfacing */ })
      }, [props.text])
      return h('button', { type: 'button', style: smallButtonStyle, onClick: copy }, copied ? t('copied') : t('copy'))
    }

    function Field(props) {
      return h('div', { style: fieldRowStyle }, [
        h('label', { key: 'l', htmlFor: props.id, style: labelStyle }, props.label),
        props.children,
        props.hint === undefined ? null : h('p', { key: 'h', style: hintStyle }, props.hint),
      ])
    }

    function Check(props) {
      return h('label', { htmlFor: props.id, style: checkRowStyle }, [
        h('input', {
          key: 'i',
          id: props.id,
          type: 'checkbox',
          checked: props.checked === true,
          style: { marginTop: 2, flex: 'none' },
          onChange: (event) => { props.onChange(event.currentTarget.checked) },
        }),
        h('span', { key: 's' }, [
          h('span', { key: 'l', style: { fontSize: 13, fontWeight: 500 } }, props.label),
          props.hint === undefined ? null : h('span', { key: 'h', style: { ...hintStyle, display: 'block' } }, props.hint),
        ]),
      ])
    }

    // --- panel -----------------------------------------------------------------

    function WebAccessPanel(props) {
      const t = translator(props.t)
      const [draft, setDraft] = useState(null)
      const [status, setStatus] = useState(null)
      const [loadError, setLoadError] = useState(null)
      const [saveState, setSaveState] = useState('idle')
      const [saveError, setSaveError] = useState(null)
      const [secret, setSecret] = useState(null)
      const [secretBusy, setSecretBusy] = useState(false)

      const refresh = useCallback(() => {
        setLoadError(null)
        loadConfig().then(
          (body) => {
            setDraft(body.config)
            setStatus(body.status)
          },
          (error) => { setLoadError(error instanceof Error ? error.message : String(error)) },
        )
      }, [])

      useEffect(() => { refresh() }, [refresh])

      const patch = useCallback((changes) => {
        setDraft((current) => ({ ...(current ?? {}), ...changes }))
        setSaveState('dirty')
      }, [])

      const save = useCallback(() => {
        if (draft === null) return
        const wanted = { ...draft }
        setSaveState('saving')
        setSaveError(null)
        readJson(CONFIG_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(wanted),
        }).then(
          async () => {
            // The Host answers before persisting, because persisting restarts
            // its plugin fiber. So confirm against a fresh read: the saved
            // value must actually come back, and a failed write must surface
            // instead of looking like success.
            for (let attempt = 0; attempt < 14; attempt += 1) {
              await new Promise((resolve) => { setTimeout(resolve, 400) })
              let latest
              try {
                latest = await readJson(CONFIG_PATH)
              } catch {
                continue
              }
              const reported = latest.status?.lastSaveError
              if (typeof reported === 'string' && reported !== '') {
                setStatus(latest.status)
                setSaveState('idle')
                setSaveError(reported)
                return
              }
              const applied = latest.config ?? {}
              const same = ['bind', 'autoTrustLocalIps', 'totpEnabled', 'totpGate'].every((key) => applied[key] === wanted[key])
                && JSON.stringify(applied.trustedHosts ?? []) === JSON.stringify(wanted.trustedHosts ?? [])
              if (same) {
                setDraft(applied)
                setStatus(latest.status)
                setSaveState('saved')
                return
              }
            }
            setSaveState('idle')
            setSaveError(t('savePending'))
          },
          (error) => {
            setSaveState('idle')
            setSaveError(error instanceof Error ? error.message : String(error))
          },
        )
      }, [draft, t])

      const loadSecret = useCallback((rotate) => {
        setSecretBusy(true)
        readJson(SETUP_PATH, rotate
          ? { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'rotate=1' }
          : undefined).then(
          (body) => { setSecret(body) },
          (error) => { setSaveError(error instanceof Error ? error.message : String(error)) },
        ).finally(() => { setSecretBusy(false) })
      }, [])

      const bind = draft?.bind ?? '127.0.0.1'
      const gate = draft?.totpGate ?? 'all'
      const show = (value) => {
        if (value === undefined || value === null || value === '') return t('none')
        if (Array.isArray(value)) return value.length === 0 ? t('none') : value.join(' ')
        return String(value)
      }

      const saveControl = Button !== undefined
        ? h(Button, {
          key: 'save',
          variant: 'primary',
          size: 'sm',
          disabled: draft === null || saveState === 'saving',
          onClick: save,
        }, saveState === 'saving' ? t('saving') : t('save'))
        : h('button', {
          key: 'save',
          type: 'button',
          style: { ...smallButtonStyle, background: 'var(--dsw-alias-brand-primary)', color: '#fff', border: 'none' },
          disabled: draft === null || saveState === 'saving',
          onClick: save,
        }, saveState === 'saving' ? t('saving') : t('save'))

      return h('section', { 'aria-label': t('title'), style: pageStyle }, [
        h('div', { key: 'inner', style: innerStyle }, [
          h('h1', { key: 'h1', style: h1Style }, t('title')),
          h('p', { key: 'intro', style: introStyle }, t('intro')),

          loadError === null ? null : h('p', {
            key: 'loadError',
            style: noticeStyle('var(--dsw-alias-state-error-primary)'),
            role: 'alert',
          }, t('loadFailed', { error: loadError })),

          h('div', { key: 'access', style: cardStyle }, [
            h('h2', { key: 't', style: sectionTitleStyle }, t('sectionAccess')),
            h(Field, {
              key: 'bind',
              id: 'web-access-bind',
              label: t('bind'),
              hint: t('bindHint'),
              children: h('select', {
                id: 'web-access-bind',
                value: bind,
                disabled: draft === null,
                style: { ...controlStyle, minWidth: 300 },
                onChange: (event) => { patch({ bind: event.currentTarget.value }) },
              }, [
                h('option', { key: 'lo', value: '127.0.0.1' }, t('bindLoopback')),
                h('option', { key: 'all', value: '0.0.0.0' }, t('bindAll')),
              ]),
            }),
            h('Check', {
              key: 'auto',
              id: 'web-access-auto',
              label: t('autoTrust'),
              hint: t('autoTrustHint'),
              checked: draft?.autoTrustLocalIps !== false,
              onChange: (value) => { patch({ autoTrustLocalIps: value }) },
            }),
            h(Field, {
              key: 'lan',
              id: 'web-access-lan',
              label: t('lanAddress'),
              hint: t('lanAddressHint'),
              children: h('input', {
                id: 'web-access-lan',
                type: 'text',
                value: typeof draft?.lanAddress === 'string' ? draft.lanAddress : '',
                disabled: draft === null || bind === '127.0.0.1',
                placeholder: '192.168.88.17',
                style: { ...controlStyle, width: '100%' },
                onChange: (event) => { patch({ lanAddress: event.currentTarget.value.trim() }) },
              }),
            }),
            h(Field, {
              key: 'trust',
              id: 'web-access-trust',
              label: t('trustedHosts'),
              hint: t('trustedHostsHint'),
              children: h('input', {
                id: 'web-access-trust',
                type: 'text',
                value: Array.isArray(draft?.trustedHosts) ? draft.trustedHosts.join(' ') : '',
                disabled: draft === null,
                placeholder: '192.168.1.20:19387',
                style: { ...controlStyle, width: '100%' },
                onChange: (event) => {
                  const list = event.currentTarget.value
                    .split(/[\s,]+/u)
                    .map((entry) => entry.trim())
                    .filter((entry) => entry !== '')
                  patch({ trustedHosts: list })
                },
              }),
            }),
          ]),

          h('div', { key: 'status', style: cardStyle }, [
            h('div', { key: 'h', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 } }, [
              h('h2', { key: 't', style: sectionTitleStyle }, t('sectionStatus')),
              h('button', { key: 'r', type: 'button', style: smallButtonStyle, onClick: refresh }, t('refresh')),
            ]),
            h('div', { key: 'kv', style: kvStyle }, [
              h('span', { key: 'k1', style: keyStyle }, t('liveBind')),
              h('span', { key: 'v1' }, show(status?.host)),
              h('span', { key: 'k2', style: keyStyle }, t('livePort')),
              h('span', { key: 'v2' }, show(status?.port)),
              h('span', { key: 'k6', style: keyStyle }, t('lanEndpoint')),
              h('span', { key: 'v6' }, status?.lan?.listening
                ? `http://${status.lan.address}:${status.lan.port}`
                : t('lanOff')),
              h('span', { key: 'k3', style: keyStyle }, t('liveTrust')),
              h('span', { key: 'v3' }, show(status?.trustLive)),
              h('span', { key: 'k4', style: keyStyle }, t('origins')),
              h('span', { key: 'v4' }, show(status?.origins)),
              h('span', { key: 'k5', style: keyStyle }, t('loginUrl')),
              h('span', { key: 'v5' }, show(status?.loginUrl)),
            ]),
            status?.lan?.error ? h('p', { key: 'lanerr', style: hintStyle }, t('lanError', { error: status.lan.error })) : null,
            status?.managed?.error ? h('p', { key: 'managed', style: hintStyle }, t('managedError', { error: status.managed.error })) : null,
            (status?.tokenUrls ?? []).length === 0 ? null : h('div', { key: 'tokens', style: { marginTop: 14 } }, [
              h('span', { key: 'l', style: keyStyle }, t('tokenUrls')),
              h('p', { key: 'h', style: hintStyle }, t('tokenUrlsHint')),
              ...status.tokenUrls.map((url, index) => h('div', {
                key: `u${index}`,
                style: { marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
              }, [
                h('code', { key: 'c', style: { ...monoStyle, marginTop: 0, flex: '1 1 260px' } }, url),
                h(CopyButton, { key: 'b', text: url, t }),
              ])),
            ]),
          ]),

          h('div', { key: 'totp', style: cardStyle }, [
            h('h2', { key: 't', style: sectionTitleStyle }, t('sectionTotp')),
            h(Check, {
              key: 'enabled',
              id: 'web-access-totp',
              label: t('totpEnabled'),
              hint: t('totpEnabledHint'),
              checked: draft?.totpEnabled === true,
              onChange: (value) => { patch({ totpEnabled: value }) },
            }),
            h(Field, {
              key: 'gate',
              id: 'web-access-gate',
              label: t('totpGate'),
              hint: t('gateHint'),
              children: h('select', {
                id: 'web-access-gate',
                value: gate,
                disabled: draft === null,
                style: { ...controlStyle, minWidth: 220 },
                onChange: (event) => { patch({ totpGate: event.currentTarget.value }) },
              }, [
                h('option', { key: 'all', value: 'all' }, t('gateAll')),
                h('option', { key: 'remote', value: 'remote' }, t('gateRemote')),
              ]),
            }),
            h('div', { key: 'secretActions', style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } }, [
              h('button', {
                key: 'show',
                type: 'button',
                style: smallButtonStyle,
                disabled: secretBusy,
                onClick: () => { loadSecret(false) },
              }, secretBusy ? t('loading') : t('showSecret')),
              h('button', {
                key: 'rotate',
                type: 'button',
                style: { ...smallButtonStyle, borderColor: 'var(--dsw-alias-state-error-primary)' },
                disabled: secretBusy,
                onClick: () => { loadSecret(true) },
              }, t('rotate')),
              h('span', { key: 'rh', style: { ...hintStyle, margin: 0 } }, t('rotateHint')),
            ]),
            secret === null ? null : h('div', { key: 'secretBody', style: { marginTop: 12 } }, [
              h('p', { key: 'sh', style: hintStyle }, t('secretHint')),
              h('span', { key: 'sl', style: keyStyle }, t('secret')),
              h('code', { key: 'sv', style: monoStyle }, secret.secret ?? ''),
              h('div', { key: 'sc', style: { marginTop: 6 } }, h(CopyButton, { text: secret.secret ?? '', t })),
              h('code', { key: 'ov', style: { ...monoStyle, marginTop: 10 } }, secret.otpauth ?? ''),
              h('div', { key: 'oc', style: { marginTop: 6 } }, h(CopyButton, { text: secret.otpauth ?? '', t })),
              h('p', { key: 'state', style: hintStyle },
                secret.enabled === true
                  ? t('enabledOn', { gate: secret.gate === 'remote' ? t('gateRemote') : t('gateAll') })
                  : t('notEnabled')),
            ]),
            h('p', { key: 'safety', style: { ...hintStyle, marginTop: 14 } }, t('safety')),
          ]),

          // One save for the whole panel, at the bottom where the last change
          // was made — the earlier placement inside the first card forced a
          // scroll back up after editing the TOTP section.
          h('div', { key: 'saveCard', style: cardStyle }, [
            h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } }, [
              saveControl,
              saveState === 'saved'
                ? h('span', { key: 'saved', style: noticeStyle('var(--dsw-alias-state-success-primary)') }, t('saved'))
                : null,
              saveState === 'dirty'
                ? h('span', { key: 'dirty', style: { ...hintStyle, margin: 0 } }, t('dirtyHint'))
                : null,
              saveError === null
                ? null
                : h('span', { key: 'err', style: noticeStyle('var(--dsw-alias-state-error-primary)'), role: 'alert' }, t('saveFailed', { error: saveError })),
            ]),
          ]),
        ]),
      ])
    }

    // --- plugin ----------------------------------------------------------------

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-web-access: dictionaries')

      // One id addresses both rows: the sidebar button and its main panel.
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 5,
        locale: NS,
        label: () => t('panel'),
      }, WebAccessIcon))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, WebAccessPanel))
    }

    return { apply, inject, name: 'web-access' }
  },
})
