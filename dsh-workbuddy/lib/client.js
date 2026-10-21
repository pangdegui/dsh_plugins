/**
 * dsh-workbuddy — browser half.
 *
 * A **Settings section** of its own (设置 → WorkBuddy). The account plane is the
 * only thing a user needs to touch: sign in, watch the token, sign out. The
 * model route itself is ordinary plugin configuration and stays in the profile.
 *
 * The sign-in flow is deliberately in-page:
 *
 *   1. **登录 / 重新登录** asks the Host for a fresh WorkBuddy auth URL.
 *   2. The Host also returns that URL already rendered as a QR image, so the
 *      page shows one dialog with the code and the raw link. Nothing is fetched
 *      from a third-party QR service.
 *   3. While the dialog is open the page polls the status route; the Host's
 *      login poll completes the moment the phone finishes signing in, and the
 *      page closes the dialog on its own.
 *
 * Current client-plugin conventions this file follows: one lazy factory under
 * the package name, React from the browser module table, no Harness Client
 * package imports (controls copy the host's markup and behavior), theme tokens
 * only, and all copy through the locale service.
 */

window.__ModuleLoader__.load({
  id: 'dsh-workbuddy',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const inject = ['slots', 'locale']

    const SECTION_ID = 'workbuddy'
    const NS = 'workbuddy'

    const STATUS_PATH = '/workbuddy/status'
    const LOGIN_PATH = '/workbuddy/login?format=json'
    const LOGOUT_PATH = '/workbuddy/logout'
    const GUARD_PATH = '/workbuddy/prompt'

    const STYLE_ID = 'dsh-workbuddy'

    /**
     * Mirrors the Host default so the field is never empty before the status
     * fetch resolves; whatever `promptGuard.prefix` reports is authoritative.
     */
    const DEFAULT_GUARD_PREFIX = 'This session is served through WorkBuddy.'

    /** How often the open login dialog checks whether the phone finished. */
    const POLL_MS = 1500

    // --- copy ------------------------------------------------------------------

    const zh = {
      nav: 'WorkBuddy',
      title: 'WorkBuddy 模型接入',
      intro: '登录 WorkBuddy 账号，把它提供的聊天模型接入 DSH。登录状态与 token 到期时间都在这里显示，临近到期会自动刷新；提示词守卫负责通过网关的 11128 渠道校验。',

      sectionAccount: '账号',
      loggedIn: '已登录',
      loggedOut: '未登录',
      accountName: '昵称',
      accountId: 'UID',
      expiry: 'Access token 到期',
      expiryUnknown: '未知',
      expiryExpired: '已过期',
      refresh: '刷新状态',
      login: '登录 / 重新登录',
      logout: '退出登录',
      busy: '处理中…',

      sectionRoute: '模型路由',
      routeProvider: 'Provider',
      routeEndpoint: '端点',
      routeModels: '模型目录',
      routeModelsCount: '{count} 个模型',
      routeHint: '登录后即可在 DSH 的模型选择器里选择这些模型；未登录时请求会以 MISSING_CREDENTIAL 失败。',

      sectionGuard: '提示词守卫',
      guardHint: 'WorkBuddy 网关会拒绝以 DSH 身份句开头的系统提示词（400 / 11128）。这里决定发送前怎么处理：前置一句只会改变开头，身份句仍然保留；删除身份行则让提示词从部署人设开始。只影响 WorkBuddy 路由。',
      guardMode: '处理方式',
      guardModeOff: '关闭（原样发送）',
      guardModePrepend: '在开头增加一句',
      guardModeStrip: '删除身份行',
      guardPrefix: '前置文本',
      guardPrefixHint: '只在「在开头增加一句」时使用；留空会恢复默认文本。',
      guardSave: '保存',
      guardSaved: '已保存，下一次请求立即生效。',
      guardSaveFailed: '保存失败：{error}',

      loginTitle: '扫码登录 WorkBuddy',
      loginHint: '用手机 WorkBuddy 或微信扫描二维码，也可以点下面的链接在浏览器中打开。登录完成后本窗口会自动关闭。',
      loginWaiting: '等待扫码…',
      loginOpen: '在浏览器中打开登录页',
      loginCancel: '取消',
      loginDone: '登录成功。',
      loginFailed: '无法开始登录：{error}',
      qrAlt: 'WorkBuddy 登录二维码',

      loggedOutNotice: '已退出登录。',
      logoutFailed: '退出失败：{error}',
      loadFailed: '读取状态失败：{error}',

      sectionHelp: '说明',
      help: 'endpoint、provider、凭据名和是否自动注册模型路由由 profile 的插件配置决定；这个页面管理账号和提示词守卫。',
    }

    const en = {
      nav: 'WorkBuddy',
      title: 'WorkBuddy models',
      intro: 'Sign in to WorkBuddy to make its chat models available in DSH. The login state and token expiry live here, and the token refreshes before it expires; the prompt guard below gets requests past the gateway\'s 11128 channel check.',

      sectionAccount: 'Account',
      loggedIn: 'Signed in',
      loggedOut: 'Not signed in',
      accountName: 'Name',
      accountId: 'UID',
      expiry: 'Access token expires',
      expiryUnknown: 'unknown',
      expiryExpired: 'expired',
      refresh: 'Refresh',
      login: 'Sign in / sign in again',
      logout: 'Sign out',
      busy: 'Working…',

      sectionRoute: 'Model route',
      routeProvider: 'Provider',
      routeEndpoint: 'Endpoint',
      routeModels: 'Model catalog',
      routeModelsCount: '{count} models',
      routeHint: 'After signing in, pick these models in the DSH model picker. Without a login, requests fail with MISSING_CREDENTIAL.',

      sectionGuard: 'Prompt guard',
      guardHint: 'The WorkBuddy gateway rejects a system prompt that opens with the DSH identity sentence (400 / 11128). This decides what the plugin sends instead: prepending one line only moves the opening, keeping the identity sentence; removing it starts the prompt at the deployment persona. The WorkBuddy route only.',
      guardMode: 'Handling',
      guardModeOff: 'Off (send as is)',
      guardModePrepend: 'Add one line in front',
      guardModeStrip: 'Remove the identity line',
      guardPrefix: 'Prefix text',
      guardPrefixHint: 'Used only by “Add one line in front”; clearing it restores the default.',
      guardSave: 'Save',
      guardSaved: 'Saved; the next request uses it.',
      guardSaveFailed: 'Could not save: {error}',

      loginTitle: 'Sign in to WorkBuddy',
      loginHint: 'Scan the code with the WorkBuddy app or WeChat on your phone, or open the link below in a browser. This dialog closes by itself once the sign-in completes.',
      loginWaiting: 'Waiting for the scan…',
      loginOpen: 'Open the sign-in page in a browser',
      loginCancel: 'Cancel',
      loginDone: 'Signed in.',
      loginFailed: 'Could not start the sign-in: {error}',
      qrAlt: 'WorkBuddy sign-in QR code',

      loggedOutNotice: 'Signed out.',
      logoutFailed: 'Sign-out failed: {error}',
      loadFailed: 'Could not read the state: {error}',

      sectionHelp: 'Note',
      help: 'The endpoint, provider, credential name and automatic route registration come from the plugin config in the profile; this page manages the account and the prompt guard.',
    }

    // --- styles ----------------------------------------------------------------

    const CSS = `
.wb_page { display:flex; flex-direction:column; gap:24px; color:var(--dsw-alias-label-primary); font-size:13px; line-height:20px; }
.wb_header { display:flex; flex-direction:column; gap:6px; }
.wb_title { margin:0; font-size:16px; font-weight:600; line-height:24px; }
.wb_section { display:flex; flex-direction:column; gap:10px; }
.wb_sectionHead { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.wb_label { margin:0; font-size:13px; font-weight:600; line-height:20px; }
.wb_hint { margin:0; font-size:12px; line-height:18px; color:var(--dsw-alias-label-secondary); }
.wb_error { margin:0; font-size:12px; line-height:18px; color:var(--dsw-alias-state-error-primary); }
.wb_success { margin:0; font-size:12px; line-height:18px; color:var(--dsw-alias-state-success-primary); }
.wb_card { display:flex; flex-direction:column; gap:10px; padding:16px; border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md); background:var(--dsw-alias-bg-layer-1); }
.wb_row { display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; }
.wb_stack { display:flex; flex-direction:column; gap:4px; min-width:0; }
.wb_value { display:inline-flex; align-items:center; gap:6px; min-width:0; font-size:12px; color:var(--dsw-alias-label-secondary); }
.wb_mono { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:12px; }
.wb_dot { flex:none; width:6px; height:6px; border-radius:50%; }
.wb_dotOk { background:var(--dsw-alias-state-success-primary); }
.wb_dotBad { background:var(--dsw-alias-state-idle-primary); }
.wb_actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.wb_field { display:flex; flex-direction:column; gap:6px; }
.wb_select, .wb_input { height:32px; padding:0 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; min-width:0; }
.wb_select:focus-visible, .wb_input:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.wb_select:disabled, .wb_input:disabled { opacity:.5; }
.wb_button { height:32px; padding:0 14px; border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md); background:transparent; color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; cursor:pointer; }
.wb_button:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); }
.wb_button:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.wb_button:disabled { opacity:.5; cursor:default; }
.wb_linkButton { display:inline-flex; align-items:center; text-decoration:none; }
.wb_primary { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); color:#fff; }
.wb_primary:hover:not(:disabled) { background:var(--dsw-alias-brand-primary); filter:brightness(1.06); }
.wb_overlay { position:fixed; inset:0; z-index:1000; display:flex; align-items:center; justify-content:center; padding:24px; background:var(--dsw-alias-bg-mask-1, rgb(0 0 0 / .45)); }
.wb_dialog { display:flex; flex-direction:column; gap:12px; width:min(380px, calc(100vw - 48px)); padding:20px; border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-panel, 12px); background:var(--dsw-alias-bg-layer-2); box-shadow:var(--dsw-elevation-prominent, 0 16px 40px rgb(0 0 0 / .3)); }
.wb_dialogHead { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
.wb_dialogTitle { margin:0; font-size:14px; font-weight:600; line-height:22px; }
.wb_close { flex:none; width:24px; height:24px; padding:0; border:none; border-radius:var(--dsw-radius-md); background:transparent; color:var(--dsw-alias-label-secondary); font-size:16px; line-height:1; cursor:pointer; }
.wb_close:hover { background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); }
.wb_close:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.wb_qrFrame { display:flex; align-items:center; justify-content:center; padding:12px; border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md); background:#fff; }
.wb_qr { display:block; width:220px; height:220px; }
.wb_url { margin:0; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:11px; line-height:16px; color:var(--dsw-alias-label-secondary); word-break:break-all; user-select:all; }
.wb_wait { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--dsw-alias-label-secondary); }
.wb_spinner { width:12px; height:12px; border:2px solid var(--dsw-alias-border-l2); border-top-color:var(--dsw-alias-brand-primary); border-radius:50%; animation:wb-spin .8s linear infinite; }
@keyframes wb-spin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .wb_spinner { animation:none; } }
`

    /**
     * Insert this plugin's stylesheet, replacing one a previous run left behind.
     * Guarded for the non-DOM evaluation the self-test performs.
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
      if (!response.ok) {
        throw new Error(
          typeof body.error === 'string' && body.error !== '' ? body.error : `HTTP ${String(response.status)}`,
        )
      }
      return body
    }

    const describeError = (cause) => (cause instanceof Error ? cause.message : String(cause))

    // --- the page ---------------------------------------------------------------

    function WorkBuddySection(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const [status, setStatus] = useState(null)
      const [loadError, setLoadError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const [login, setLogin] = useState(null)
      const [guardMode, setGuardMode] = useState('prepend')
      const [guardPrefix, setGuardPrefix] = useState(DEFAULT_GUARD_PREFIX)
      const [guardBusy, setGuardBusy] = useState(false)
      const [guardNotice, setGuardNotice] = useState(null)

      const refresh = useCallback(async () => {
        try {
          const body = await readJson(STATUS_PATH)
          setStatus(body)
          const guard = body?.promptGuard
          if (guard !== undefined) {
            if (typeof guard.mode === 'string') setGuardMode(guard.mode)
            if (typeof guard.prefix === 'string' && guard.prefix !== '') setGuardPrefix(guard.prefix)
          }
          setLoadError(null)
        } catch (cause) {
          setLoadError(describeError(cause))
        }
      }, [])

      useEffect(() => {
        void refresh()
      }, [refresh])

      const closeLogin = useCallback(() => {
        setLogin(null)
      }, [])

      const startLogin = useCallback(async () => {
        setBusy(true)
        setNotice(null)
        try {
          const body = await readJson(LOGIN_PATH)
          setLogin({
            qr: typeof body.qr === 'string' ? body.qr : '',
            authUrl: typeof body.authUrl === 'string' ? body.authUrl : '',
            state: body.state,
          })
        } catch (cause) {
          setNotice({ kind: 'error', text: t('loginFailed', { error: describeError(cause) }) })
        } finally {
          setBusy(false)
        }
      }, [t])

      const logout = useCallback(async () => {
        setBusy(true)
        setNotice(null)
        try {
          await readJson(LOGOUT_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          await refresh()
          setNotice({ kind: 'ok', text: t('loggedOutNotice') })
        } catch (cause) {
          setNotice({ kind: 'error', text: t('logoutFailed', { error: describeError(cause) }) })
        } finally {
          setBusy(false)
        }
      }, [refresh, t])

      const saveGuard = useCallback(async () => {
        setGuardBusy(true)
        setGuardNotice(null)
        try {
          const body = await readJson(GUARD_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: guardMode, prefix: guardPrefix }),
          })
          const guard = body?.promptGuard
          if (guard !== undefined) {
            if (typeof guard.mode === 'string') setGuardMode(guard.mode)
            if (typeof guard.prefix === 'string' && guard.prefix !== '') setGuardPrefix(guard.prefix)
          }
          const persisted = body?.persisted !== false
          const text = typeof body?.message === 'string' && body.message !== '' ? body.message : t('guardSaved')
          setGuardNotice({ kind: persisted ? 'ok' : 'error', text })
        } catch (cause) {
          setGuardNotice({ kind: 'error', text: t('guardSaveFailed', { error: describeError(cause) }) })
        } finally {
          setGuardBusy(false)
        }
      }, [guardMode, guardPrefix, t])

      // While the dialog is open, watch the Host: its login poll is the thing
      // that actually completes, and the page only mirrors that state.
      useEffect(() => {
        if (login === null) return undefined
        let cancelled = false
        const timer = setInterval(() => {
          void (async () => {
            try {
              const body = await readJson(STATUS_PATH)
              if (cancelled) return
              setStatus(body)
              if (body.loggedIn === true) {
                cancelled = true
                clearInterval(timer)
                setLogin(null)
                setNotice({ kind: 'ok', text: t('loginDone') })
              }
            } catch {
              /* a transient poll failure must not close the dialog */
            }
          })()
        }, POLL_MS)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [login, t])

      // Escape closes the dialog and focus returns to the button that opened it,
      // matching the host modal behavior.
      useEffect(() => {
        if (login === null || typeof document === 'undefined') return undefined
        const previous = document.activeElement
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            closeLogin()
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          if (previous !== null && typeof previous?.focus === 'function') previous.focus()
        }
      }, [login, closeLogin])

      if (loadError !== null) {
        return h('div', { className: 'wb_page' }, [
          h('h2', { key: 'title', className: 'wb_title' }, t('title')),
          h('p', { key: 'err', className: 'wb_error', role: 'alert' }, t('loadFailed', { error: loadError })),
          h(
            'button',
            { key: 'reload', type: 'button', className: 'wb_button', onClick: () => void refresh() },
            t('refresh'),
          ),
        ])
      }

      const view = status ?? {}
      const loggedIn = view.loggedIn === true
      const account = view.account ?? {}
      const expiresAt = Number.isFinite(view.expiresAt) ? new Date(view.expiresAt).toLocaleString() : null
      const expiryText =
        expiresAt === null ? t('expiryUnknown') : view.expired === true ? `${expiresAt} (${t('expiryExpired')})` : expiresAt

      const dialog =
        login === null
          ? null
          : h('div', { key: 'overlay', className: 'wb_overlay', onClick: closeLogin }, [
              h(
                'div',
                {
                  key: 'dialog',
                  className: 'wb_dialog',
                  role: 'dialog',
                  'aria-modal': true,
                  'aria-labelledby': 'wb-login-title',
                  onClick: (event) => {
                    event.stopPropagation()
                  },
                },
                [
                  h('div', { key: 'head', className: 'wb_dialogHead' }, [
                    h('h3', { key: 'title', id: 'wb-login-title', className: 'wb_dialogTitle' }, t('loginTitle')),
                    h(
                      'button',
                      {
                        key: 'close',
                        type: 'button',
                        className: 'wb_close',
                        'aria-label': t('loginCancel'),
                        autoFocus: true,
                        onClick: closeLogin,
                      },
                      '×',
                    ),
                  ]),
                  h('p', { key: 'hint', className: 'wb_hint' }, t('loginHint')),
                  login.qr === ''
                    ? null
                    : h('div', { key: 'qr', className: 'wb_qrFrame' }, [
                        h('img', {
                          key: 'img',
                          className: 'wb_qr',
                          src: login.qr,
                          alt: t('qrAlt'),
                          width: 220,
                          height: 220,
                        }),
                      ]),
                  login.authUrl === ''
                    ? null
                    : h('p', { key: 'url', className: 'wb_url' }, login.authUrl),
                  h('div', { key: 'wait', className: 'wb_wait' }, [
                    h('span', { key: 'spin', className: 'wb_spinner', 'aria-hidden': true }),
                    t('loginWaiting'),
                  ]),
                  h('div', { key: 'actions', className: 'wb_actions' }, [
                    login.authUrl === ''
                      ? null
                      : h(
                          'a',
                          {
                            key: 'open',
                            className: 'wb_button wb_linkButton',
                            href: login.authUrl,
                            target: '_blank',
                            rel: 'noreferrer',
                          },
                          t('loginOpen'),
                        ),
                    h(
                      'button',
                      { key: 'cancel', type: 'button', className: 'wb_button', onClick: closeLogin },
                      t('loginCancel'),
                    ),
                  ]),
                ],
              ),
            ])

      return h('div', { className: 'wb_page' }, [
        h('header', { key: 'head', className: 'wb_header' }, [
          h('h2', { key: 'title', className: 'wb_title' }, t('title')),
          h('p', { key: 'intro', className: 'wb_hint' }, t('intro')),
        ]),

        // 1. the account
        h('section', { key: 'account', className: 'wb_section' }, [
          h('div', { key: 'head', className: 'wb_sectionHead' }, [
            h('h3', { key: 'h', className: 'wb_label' }, t('sectionAccount')),
            h('span', { key: 'state', className: 'wb_value' }, [
              h('span', {
                key: 'd',
                className: `wb_dot ${loggedIn ? 'wb_dotOk' : 'wb_dotBad'}`,
                'aria-hidden': true,
              }),
              loggedIn ? t('loggedIn') : t('loggedOut'),
            ]),
          ]),

          h('div', { key: 'card', className: 'wb_card' }, [
            loggedIn
              ? h('div', { key: 'identity', className: 'wb_stack' }, [
                  h('span', { key: 'name', className: 'wb_label' }, account.nickname ?? account.uid ?? t('loggedIn')),
                  h(
                    'span',
                    { key: 'uid', className: 'wb_value' },
                    `${t('accountId')}: ${account.uid ?? '—'}`,
                  ),
                ])
              : h('p', { key: 'empty', className: 'wb_hint' }, t('loggedOut')),
            h('span', { key: 'expiry', className: 'wb_value' }, `${t('expiry')}: ${expiryText}`),
          ]),

          h('div', { key: 'actions', className: 'wb_actions' }, [
            loggedIn
              ? h(
                  'button',
                  {
                    key: 'logout',
                    type: 'button',
                    className: 'wb_button',
                    disabled: busy,
                    onClick: () => void logout(),
                  },
                  busy ? t('busy') : t('logout'),
                )
              : h(
                  'button',
                  {
                    key: 'login',
                    type: 'button',
                    className: 'wb_button wb_primary',
                    disabled: busy,
                    onClick: () => void startLogin(),
                  },
                  busy ? t('busy') : t('login'),
                ),
            loggedIn
              ? h(
                  'button',
                  {
                    key: 'relogin',
                    type: 'button',
                    className: 'wb_button',
                    disabled: busy,
                    onClick: () => void startLogin(),
                  },
                  t('login'),
                )
              : null,
            h(
              'button',
              {
                key: 'refresh',
                type: 'button',
                className: 'wb_button',
                disabled: busy,
                onClick: () => void refresh(),
              },
              t('refresh'),
            ),
          ]),

          notice === null
            ? null
            : h(
                'p',
                { key: 'notice', className: notice.kind === 'ok' ? 'wb_success' : 'wb_error', role: 'status' },
                notice.text,
              ),
        ]),

        // 2. what the plugin installed
        h('section', { key: 'route', className: 'wb_section' }, [
          h('h3', { key: 'h', className: 'wb_label' }, t('sectionRoute')),
          h('div', { key: 'card', className: 'wb_card' }, [
            h('div', { key: 'provider', className: 'wb_row' }, [
              h('span', { key: 'k', className: 'wb_hint' }, t('routeProvider')),
              h('span', { key: 'v', className: 'wb_value wb_mono' }, view.provider ?? '—'),
            ]),
            h('div', { key: 'endpoint', className: 'wb_row' }, [
              h('span', { key: 'k', className: 'wb_hint' }, t('routeEndpoint')),
              h('span', { key: 'v', className: 'wb_value wb_mono' }, view.endpoint ?? '—'),
            ]),
            h('div', { key: 'models', className: 'wb_row' }, [
              h('span', { key: 'k', className: 'wb_hint' }, t('routeModels')),
              h(
                'span',
                { key: 'v', className: 'wb_value' },
                t('routeModelsCount', { count: String(view.catalogSize ?? 0) }),
              ),
            ]),
          ]),
          h('p', { key: 'hint', className: 'wb_hint' }, t('routeHint')),
        ]),

        // 3. how the outbound prompt is adapted for this gateway
        h('section', { key: 'guard', className: 'wb_section' }, [
          h('h3', { key: 'h', className: 'wb_label' }, t('sectionGuard')),
          h('div', { key: 'card', className: 'wb_card' }, [
            h('label', { key: 'mode', className: 'wb_field' }, [
              h('span', { key: 'k', className: 'wb_hint' }, t('guardMode')),
              h(
                'select',
                {
                  key: 'v',
                  className: 'wb_select',
                  value: guardMode,
                  disabled: guardBusy,
                  onChange: (event) => setGuardMode(event.target.value),
                },
                [
                  h('option', { key: 'off', value: 'off' }, t('guardModeOff')),
                  h('option', { key: 'prepend', value: 'prepend' }, t('guardModePrepend')),
                  h('option', { key: 'strip', value: 'strip' }, t('guardModeStrip')),
                ],
              ),
            ]),
            guardMode === 'prepend'
              ? h('label', { key: 'prefix', className: 'wb_field' }, [
                  h('span', { key: 'k', className: 'wb_hint' }, t('guardPrefix')),
                  h('input', {
                    key: 'v',
                    className: 'wb_input',
                    type: 'text',
                    value: guardPrefix,
                    disabled: guardBusy,
                    onChange: (event) => setGuardPrefix(event.target.value),
                  }),
                  h('span', { key: 'note', className: 'wb_hint' }, t('guardPrefixHint')),
                ])
              : null,
            h('p', { key: 'hint', className: 'wb_hint' }, t('guardHint')),
          ]),
          h('div', { key: 'actions', className: 'wb_actions' }, [
            h(
              'button',
              {
                key: 'save',
                type: 'button',
                className: 'wb_button wb_primary',
                disabled: guardBusy,
                onClick: () => void saveGuard(),
              },
              guardBusy ? t('busy') : t('guardSave'),
            ),
          ]),
          guardNotice === null
            ? null
            : h(
                'p',
                { key: 'notice', className: guardNotice.kind === 'ok' ? 'wb_success' : 'wb_error', role: 'status' },
                guardNotice.text,
              ),
        ]),

        h('p', { key: 'help', className: 'wb_hint' }, `${t('sectionHelp')}: ${t('help')}`),

        dialog,
      ])
    }

    // --- plugin ----------------------------------------------------------------

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-workbuddy: dictionaries')
      ctx.effect(installStyles, 'dsh-workbuddy: styles')

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: SECTION_ID,
            order: 61,
            label: () => t('nav'),
            locale: NS,
          },
          (slotProps) => h(WorkBuddySection, { ...slotProps, t }),
        ),
      )
    }

    return { apply, inject, name: 'workbuddy' }
  },
})
