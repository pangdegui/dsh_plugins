/**
 * dsh-session-delete — browser half.
 *
 * Adds one "Delete session" row to the Session row's "..." menu and one shared
 * confirmation dialog. Both hook into shipped extension points instead of the
 * DOM:
 *
 *   - `sidebar.workspaces.session.menu.item` — the list the workspace browser
 *     renders for every Session row, so this row lands beside the shipped
 *     Pin / Rename / Fork / Archive rows and already receives `sessionId`,
 *     `displayTitle`, the reactive `useSessions` / `useSessionStatus` hooks and
 *     the `useMenuOpenState` hook;
 *   - `shell.overlay` — the frame-wide floating layer, so one dialog serves
 *     every entry point.
 *
 * The dialog and its menu row are plain React + theme-token CSS: current
 * plugin guidance keeps Client bundles on the baseline `react` module and has
 * plugins match host controls instead of importing Harness Client packages.
 * The deletion itself runs on the Host through this package's same-origin
 * route. After a committed delete the sidebar list is re-pulled in place
 * (`sessions.refresh`) and, when the deleted Session was the open
 * conversation, the next remaining Session is opened — no page reload.
 *
 * Bundle protocol: `window.__ModuleLoader__.load({ id, factory })`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-session-delete'
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
    const OVERLAY_SLOT = 'shell.overlay'
    const CONTRIBUTION_ID = 'dsh-session-delete'
    const DELETE_ROUTE = '/plugins/dsh-session-delete/delete'
    const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'

    // --- copy ------------------------------------------------------------------
    // Registered with the locale service so `t` arrives as a slot seat and the
    // dialog follows a live language switch. Plugin metadata lives in
    // `locale/*.json`; these are the runtime UI dictionaries.

    const zh = {
      'menu.delete': '删除会话',
      'dialog.title': '删除会话',
      'dialog.deleteDesc': '会话「{title}」（{id}）的日志、投影缓存与工作区记账将被永久删除，此操作无法撤销。',
      'dialog.runningDesc': '会话「{title}」（{id}）正在运行。删除会先停止它正在进行的任务，再永久删除其日志、投影缓存与工作区记账，此操作无法撤销。',
      'dialog.ack': '我已了解后果，确认删除',
      'dialog.cancel': '取消',
      'dialog.confirm': '永久删除',
      'dialog.deleting': '删除中…',
      'dialog.failed': '删除失败：{error}',
    }

    const en = {
      'menu.delete': 'Delete session',
      'dialog.title': 'Delete session',
      'dialog.deleteDesc': 'Session "{title}" ({id}) will be permanently deleted together with its log, projection cache and workspace accounting. This cannot be undone.',
      'dialog.runningDesc': 'Session "{title}" ({id}) is running. Deleting stops its current work first, then permanently removes its log, projection cache and workspace accounting. This cannot be undone.',
      'dialog.ack': 'I understand the consequences and want to delete it',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete permanently',
      'dialog.deleting': 'Deleting…',
      'dialog.failed': 'Delete failed: {error}',
    }

    // --- icons -----------------------------------------------------------------

    const trashIcon = h('svg', {
      viewBox: '0 0 16 16',
      width: 14,
      height: 14,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    }, [
      h('path', { key: 'lid', d: 'M3 4.5h10' }),
      h('path', { key: 'handle', d: 'M6.2 4.5V3.4c0-.5.4-.9.9-.9h1.8c.5 0 .9.4.9.9v1.1' }),
      h('path', { key: 'body', d: 'M4.4 4.5l.7 8.2c.05.6.55 1.1 1.2 1.1h3.4c.65 0 1.15-.5 1.2-1.1l.7-8.2' }),
      h('path', { key: 'line', d: 'M6.7 6.9v4.6M9.3 6.9v4.6' }),
    ])

    const warningIcon = h('svg', {
      viewBox: '0 0 20 20',
      width: 18,
      height: 18,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    }, [
      h('path', { key: 'shape', d: 'M10 2.6l7.2 13.2a.8.8 0 0 1-.7 1.2H3.5a.8.8 0 0 1-.7-1.2L10 2.6z' }),
      h('path', { key: 'bar', d: 'M10 7.4v4.1' }),
      h('circle', { key: 'dot', cx: 10, cy: 14.2, r: 0.9, fill: 'currentColor', stroke: 'none' }),
    ])

    const closeIcon = h('svg', {
      viewBox: '0 0 16 16',
      width: 16,
      height: 16,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      'aria-hidden': true,
    }, [
      h('path', { key: 'a', d: 'M4 4l8 8' }),
      h('path', { key: 'b', d: 'M12 4l-8 8' }),
    ])

    // --- styles ----------------------------------------------------------------
    // Copied in spirit from the shipped Menu / Modal / RiskConfirmation
    // primitives and renamed under this plugin's prefix. Only theme tokens are
    // shared, so a renamed token degrades appearance without breaking render.

    const CSS = `
.dsd_menuCell { position: relative; }
.dsd_menuSeparator { height: 0.5px; margin: 3px 2px; background: var(--dsw-alias-border-l2); }
.dsd_menuItem {
  display: flex; align-items: center; gap: 6px; width: 100%; min-height: 34px;
  padding: 6px 8px; border: none; border-radius: var(--dsw-radius-md);
  background: transparent; cursor: pointer; font: inherit;
  font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary);
  text-align: left;
}
.dsd_menuItem:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsd_menuItem:focus-visible:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); outline: none; }
.dsd_menuItem:disabled { opacity: 0.4; cursor: not-allowed; }
.dsd_menuIcon { display: inline-flex; flex: none; width: 14px; height: 14px; align-items: center; justify-content: center; color: var(--dsw-alias-menu-icon); }
.dsd_menuIcon svg { width: 14px; height: 14px; }
.dsd_menuLabel { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsd_danger { color: var(--dsw-alias-state-error-primary); }
.dsd_danger .dsd_menuIcon { color: var(--dsw-alias-state-error-primary); }
.dsd_danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.dsd_danger:focus-visible:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); outline: none; }

.dsd_overlay {
  pointer-events: auto; position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center;
  padding: max(24px, var(--dsh-frame-overlay-top, 24px)) 24px;
}
.dsd_backdrop {
  position: absolute; inset: var(--dsh-frame-chrome-top, 0px) 0 0;
  backdrop-filter: var(--dsw-mask-blur);
  background: var(--dsw-alias-bg-mask-1);
  animation: dsdFade var(--ds-transition-duration) var(--ds-ease-in-out);
}
.dsd_dialog {
  box-sizing: border-box; position: relative; z-index: 1;
  display: flex; flex-direction: column; gap: 20px;
  width: min(440px, 100%); max-height: calc(100dvh - 48px);
  padding: 0 0 24px; overflow: hidden; border: 0;
  border-radius: var(--dsw-radius-panel); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary); box-shadow: var(--dsw-elevation-prominent);
  animation: dsdFade var(--ds-transition-duration) var(--ds-ease-in-out);
}
.dsd_dialog:focus { outline: none; }
.dsd_header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 22px 14px 12px 24px; }
.dsd_title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }
.dsd_close {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border: none; border-radius: var(--dsw-radius-sm);
  background: transparent; cursor: pointer; color: var(--dsw-alias-label-secondary);
}
.dsd_close:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsd_close:disabled { opacity: 0.4; cursor: not-allowed; }
.dsd_close:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; }
.dsd_body { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 24px; }
.dsd_warning { display: flex; align-items: flex-start; gap: 10px; color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 22px; }
.dsd_warning p { margin: 0; }
.dsd_warningIcon { flex: none; margin-top: 2px; color: var(--dsw-alias-state-error-primary); }
.dsd_ack { display: flex; align-items: flex-start; gap: 10px; margin-top: 20px; color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; cursor: pointer; }
.dsd_ack input { flex: none; width: 16px; height: 16px; margin: 3px 0 0; accent-color: var(--dsw-alias-button-primary-fill); cursor: pointer; }
.dsd_ack input:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.dsd_ack input:disabled { cursor: default; }
.dsd_footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 0 24px; }
.dsd_button {
  box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  gap: 4px; height: 36px; padding: 0 14px; border: none; border-radius: var(--dsw-radius-md);
  cursor: pointer; font: inherit; font-size: 14px; line-height: 22px;
  color: var(--dsw-alias-label-primary); background: transparent;
}
.dsd_button:disabled { cursor: not-allowed; opacity: 0.4; }
.dsd_button:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.dsd_outline { border: 0.5px solid var(--dsw-alias-border-l3); background: transparent; }
.dsd_outline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsd_primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dsd_primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dsd_confirm { min-width: 136px; }
@keyframes dsdFade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .dsd_backdrop, .dsd_dialog { animation: none; } }
`

    function installStyles() {
      for (const old of document.querySelectorAll('style[data-plugin-css="dsh-session-delete"]')) old.remove()
      const tag = document.createElement('style')
      tag.dataset.pluginCss = 'dsh-session-delete'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    // --- shared dialog state ---------------------------------------------------
    // One request drives the single overlay occupant; the menu row and the
    // dialog live in this bundle, so a module-level store is enough and the
    // row never has to switch the conversation to raise the dialog.

    function createRequestStore() {
      let value = null
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set: (next) => {
          if (value === next) return
          value = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    // --- fetch -----------------------------------------------------------------

    async function deleteSession(sessionId) {
      const response = await fetch(DELETE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-session-delete': '1' },
        body: JSON.stringify({ sessionId }),
      })
      let body = {}
      try {
        body = await response.json()
      } catch {
        body = {}
      }
      if (!response.ok || body.ok !== true) {
        throw new Error(typeof body.error === 'string' && body.error !== '' ? body.error : `HTTP ${response.status}`)
      }
    }

    // --- Session row menu entry -------------------------------------------------

    function DeleteSessionMenuItem(props) {
      const {
        sessionId,
        displayTitle,
        useSessions,
        useSessionStatus,
        useMenuOpenState,
        openDeleteDialog,
        t,
      } = props

      const row = useSessions((snapshot) => snapshot.byId[sessionId])
      const statuses = useSessionStatus((snapshot) => snapshot)
      const [, setMenuOpen] = useMenuOpenState()

      const title = displayTitle || row?.displayTitle || sessionId
      const running = statuses?.get?.(sessionId)?.running ?? row?.running === true

      const onSelect = React.useCallback(() => {
        setMenuOpen(false)
        openDeleteDialog({
          sessionId,
          title,
          running,
          open: (row?.retainedBy?.mainView ?? 0) > 0,
        })
      }, [sessionId, title, running, row, setMenuOpen, openDeleteDialog])

      return h('div', { className: 'dsd_menuCell' }, [
        h('div', { key: 'separator', role: 'separator', className: 'dsd_menuSeparator' }),
        h('button', {
          key: 'row',
          type: 'button',
          role: 'menuitem',
          className: 'dsd_menuItem dsd_danger',
          onClick: onSelect,
        }, [
          h('span', { key: 'icon', className: 'dsd_menuIcon', 'aria-hidden': 'true' }, trashIcon),
          h('span', { key: 'label', className: 'dsd_menuLabel' }, t('menu.delete')),
        ]),
      ])
    }

    // --- confirmation dialog ----------------------------------------------------

    function describe(t, request, running, error) {
      const base = t(running ? 'dialog.runningDesc' : 'dialog.deleteDesc', {
        title: request.title,
        id: request.sessionId,
      })
      return error === null ? base : `${base} ${t('dialog.failed', { error })}`
    }

    function DeleteSessionDialog(props) {
      const {
        t,
        useSessions,
        useSessionStatus,
        useDeleteRequest,
        closeDeleteDialog,
        leaveDeletedSession,
      } = props

      const request = useDeleteRequest((value) => value)
      const list = useSessions((snapshot) => snapshot)
      const statuses = useSessionStatus((snapshot) => snapshot)

      const [acknowledged, setAcknowledged] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)

      const dialogRef = React.useRef(null)
      const busyRef = React.useRef(false)
      busyRef.current = busy
      const closeRef = React.useRef(() => {})
      closeRef.current = () => {
        if (!busyRef.current) closeDeleteDialog()
      }

      const row = request === null ? undefined : list.byId[request.sessionId]
      const running = request === null
        ? false
        : (statuses?.get?.(request.sessionId)?.running ?? row?.running === true)

      React.useEffect(() => {
        setAcknowledged(false)
        setBusy(false)
        setError(null)
      }, [request])

      // Modal keyboard ownership and focus return: initial focus, Escape,
      // Tab containment, and focus restore to the invoking control.
      React.useLayoutEffect(() => {
        if (request === null) return undefined
        const element = dialogRef.current
        if (element === null) return undefined
        const previous = document.activeElement
        const initial = element.querySelector('[data-dsd-autofocus]')
          ?? element.querySelector(FOCUSABLE)
          ?? element
        if (!element.contains(document.activeElement)) initial.focus({ preventScroll: true })

        const onKeyDown = (event) => {
          if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return
          if (event.key === 'Escape' && !event.shiftKey) {
            event.preventDefault()
            if (!event.repeat) closeRef.current()
            return
          }
          if (event.key !== 'Tab') return
          const items = [...element.querySelectorAll(FOCUSABLE)].filter((item) => item.offsetParent !== null)
          if (items.length === 0) {
            event.preventDefault()
            element.focus({ preventScroll: true })
            return
          }
          const first = items[0]
          const last = items[items.length - 1]
          const active = document.activeElement
          const outside = active === null || !element.contains(active)
          if ((event.shiftKey && (active === first || outside)) || (!event.shiftKey && (active === last || outside))) {
            event.preventDefault()
            ;(event.shiftKey ? last : first).focus({ preventScroll: true })
          }
        }

        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
        }
      }, [request !== null])

      const onCancel = React.useCallback(() => {
        if (!busy) closeDeleteDialog()
      }, [busy, closeDeleteDialog])

      const onConfirm = React.useCallback(() => {
        if (busy || !acknowledged || request === null) return
        setBusy(true)
        setError(null)
        const sessionId = request.sessionId
        const wasOpen = (row?.retainedBy?.mainView ?? 0) > 0
        deleteSession(sessionId).then(
          () => {
            closeDeleteDialog()
            leaveDeletedSession(sessionId, wasOpen)
          },
          (reason) => {
            setBusy(false)
            setError(reason instanceof Error ? reason.message : String(reason))
          },
        )
      }, [busy, acknowledged, request, row, closeDeleteDialog, leaveDeletedSession])

      if (request === null) return null

      return h('div', {
        className: 'dsd_overlay',
        role: 'presentation',
      }, [
        h('div', {
          key: 'backdrop',
          className: 'dsd_backdrop',
          onClick: onCancel,
        }),
        h('div', {
          key: 'dialog',
          ref: dialogRef,
          className: 'dsd_dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'dsh-session-delete-title',
          tabIndex: -1,
        }, [
          h('div', { key: 'header', className: 'dsd_header' }, [
            h('h2', { key: 'title', id: 'dsh-session-delete-title', className: 'dsd_title' }, t('dialog.title')),
            h('button', {
              key: 'close',
              type: 'button',
              className: 'dsd_close',
              'aria-label': t('dialog.cancel'),
              disabled: busy,
              onClick: onCancel,
            }, closeIcon),
          ]),
          h('div', { key: 'body', className: 'dsd_body' }, [
            h('div', { key: 'warning', className: 'dsd_warning' }, [
              h('span', { key: 'icon', className: 'dsd_warningIcon', 'aria-hidden': 'true' }, warningIcon),
              h('p', { key: 'text' }, describe(t, request, running, error)),
            ]),
            h('label', { key: 'ack', className: 'dsd_ack' }, [
              h('input', {
                key: 'box',
                type: 'checkbox',
                checked: acknowledged,
                disabled: busy,
                'data-dsd-autofocus': '',
                onChange: (event) => { setAcknowledged(event.currentTarget.checked) },
              }),
              h('span', { key: 'text' }, t('dialog.ack')),
            ]),
          ]),
          h('div', { key: 'footer', className: 'dsd_footer' }, [
            h('button', {
              key: 'cancel',
              type: 'button',
              className: 'dsd_button dsd_outline',
              disabled: busy,
              onClick: onCancel,
            }, t('dialog.cancel')),
            h('button', {
              key: 'confirm',
              type: 'button',
              className: 'dsd_button dsd_primary dsd_confirm',
              disabled: busy || !acknowledged,
              onClick: onConfirm,
            }, busy ? t('dialog.deleting') : t('dialog.confirm')),
          ]),
        ]),
      ])
    }

    // --- plugin -----------------------------------------------------------------

    const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']

    function apply(ctx) {
      const sessions = ctx.sessions
      const uiWorkspace = ctx.uiWorkspace
      const requestStore = createRequestStore()

      const leaveDeletedSession = async (deletedId, wasOpen) => {
        try {
          await sessions.refresh()
        } catch (reason) {
          console.warn('dsh-session-delete: session list refresh failed:', reason)
        }
        if (!wasOpen) return
        try {
          const ids = sessions.list.getSnapshot().ids.filter((id) => id !== deletedId)
          if (ids.length === 0) uiWorkspace.startSession()
          else uiWorkspace.openSession(ids[0])
        } catch (reason) {
          console.warn('dsh-session-delete: leaving the deleted session failed:', reason)
        }
      }

      ctx.effect(installStyles, 'dsh-session-delete: styles')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-session-delete: dictionaries')

      ctx.slots.inject(MENU_SLOT, () => ctx.slots.register({
        name: MENU_SLOT,
        id: CONTRIBUTION_ID,
        order: 500,
        locale: NS,
        inject: () => ({ openDeleteDialog: requestStore.set }),
      }, DeleteSessionMenuItem))

      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: CONTRIBUTION_ID,
        order: 100,
        locale: NS,
        inject: () => ({
          hooks: { deleteRequest: requestStore },
          closeDeleteDialog: () => requestStore.set(null),
          leaveDeletedSession,
        }),
      }, DeleteSessionDialog))
    }

    return { apply, inject, name: 'session-delete' }
  },
})
