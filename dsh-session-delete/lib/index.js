/**
 * dsh-session-delete — Host half.
 *
 * The shipped workspace browser offers archive/unarchive only, so an archived
 * Session keeps its log on disk forever and "tidy up the sidebar" never
 * reclaims anything. This half adds the missing operation behind one
 * same-origin route that the browser half calls. It removes every local trace
 * of one Session:
 *
 *   1. stop the live Agent, drain its durability and detach the live Session
 *      store entry (`agent.cancel` + `whenIdle`, `sessions.flush`, then the
 *      store's own detach capability, time-boxed). The Agent object itself has
 *      no public disposal handle by id, so it stays registered until restart;
 *      the Session is detached from every Client-facing list;
 *   2. remove the persisted Session directory
 *      `<persistence root>/<projectKey(cwd)>/<session id>/`;
 *   3. drop the `session_projcache` / `sessions` row;
 *   4. drop the Session from Workspace accounting through the current
 *      `workspaceRegistry` surface — the archive set, the pin set and the
 *      owning Workspace's ordered membership — only *after* the log is
 *      confirmed gone, so a failed filesystem delete can never detach a
 *      Session and leave it as a ghost "Ungrouped" row;
 *   5. best-effort: remove the Session's spill directory under the spill root
 *      and the default temp roots.
 *
 * Deliberately NOT removed, and why:
 *   - `DSH_HOME/attachments/v1` is content-addressed and shared between
 *     Sessions, so a single-Session delete cannot own those objects;
 *   - telemetry already delivered upstream cannot be recalled;
 *   - text in *other* Sessions that mentions this Session belongs to them.
 *
 * The half imports nothing from `@deepseek-ai/*`: every service is reached
 * through the Cordis context, so the package installs without peer
 * dependencies and the compatibility preflight never has to judge versions.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const name = 'session-delete'

/**
 * No hard service dependency: `webServer` is adopted through `ctx.inject` so a
 * profile without a web surface loads this plugin harmlessly instead of
 * parking it on an unsatisfied injection. Every other service is optional and
 * read from the context at the moment it is needed.
 */
export const inject = []

/** Same-origin route the browser half posts to. */
const ROUTE = '/plugins/dsh-session-delete/delete'

/** Windows keeps a just-closed log handle alive briefly; retry instead of failing. */
const REMOVE_ATTEMPTS = 12
const REMOVE_DELAY_MS = 120

/** Upper bound on how long a cancelled Agent may take to reach quiescence. */
const QUIESCE_TIMEOUT_MS = 10000

const MAX_BODY_BYTES = 4096

class DeleteError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Reject ids that could name another path even before the persistence encoding. */
function normalizeSessionId(raw) {
  if (typeof raw !== 'string') throw new DeleteError(400, 'invalid session id')
  const id = raw.trim()
  if (id === '') throw new DeleteError(400, 'invalid session id')
  if (id.length > 200) throw new DeleteError(400, 'session id is too long')
  if (id === '.' || id === '..' || /[\\/\u0000-\u001f]/.test(id)) throw new DeleteError(400, 'invalid session id')
  return id
}

// --- path model --------------------------------------------------------------
// Mirrors @deepseek-ai/dsh-session-persistence-jsonl (format v4) so the exact
// directory is derivable without importing the asar-packaged module.

/** `$DSH_HOME`, else `~/.dsh` — the same precedence the harness itself uses. */
function harnessHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return path.join(os.homedir(), '.dsh')
}

/**
 * Encode an arbitrary string as one safe path segment, injectively over all
 * UTF-16 strings. Safe code units stay literal; everything else becomes
 * `~XXXX`, matching the persistence backend exactly.
 */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** Readable project directory key: separators fold to `-`, unsafe units escape. */
function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const ch = String.fromCharCode(cwd.charCodeAt(i))
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** The mounted backend's own root when it publishes one, else the default. */
function sessionsRoot(ctx) {
  const persistence = ctx.get('sessionPersistence')
  const configured = persistence?.root ?? persistence?.config?.root
  if (typeof configured === 'string' && path.isAbsolute(configured)) return configured
  return path.join(harnessHome(), 'sessions')
}

/** Candidate log directories: the derived exact path first, then a full scan. */
function candidateDirs(ctx, sessionId, cwd) {
  const root = sessionsRoot(ctx)
  const segment = encodeSegment(sessionId)
  const candidates = new Set()

  if (typeof cwd === 'string' && cwd !== '' && path.isAbsolute(cwd)) {
    candidates.add(path.join(root, projectKey(cwd), segment))
  }
  candidates.add(path.join(root, '_no-cwd', segment))

  // Scan fallback: covers an unreadable header, a custom project key and an id
  // that only exists under a project directory the header no longer names.
  let projects = []
  try {
    projects = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    projects = []
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    candidates.add(path.join(root, project.name, segment))
  }
  return [...candidates]
}

function existingDirs(dirs) {
  return dirs.filter((dir) => {
    try {
      return fs.lstatSync(dir).isDirectory()
    } catch {
      return false
    }
  })
}

/** Remove every existing candidate directory, retrying briefly for held handles. */
async function removeLogDirs(dirs) {
  const present = existingDirs(dirs)
  if (present.length === 0) return 0
  let remaining = present
  for (let attempt = 0; attempt < REMOVE_ATTEMPTS && remaining.length > 0; attempt += 1) {
    for (const dir of remaining) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 0 })
      } catch {
        /* the retry loop below decides whether this is terminal */
      }
    }
    remaining = existingDirs(remaining)
    if (remaining.length > 0) await delay(REMOVE_DELAY_MS)
  }
  if (remaining.length > 0) {
    throw new DeleteError(500, `session files are still on disk: ${remaining.join(', ')}`)
  }
  return present.length
}

// --- live Session ------------------------------------------------------------

function liveAgentOf(ctx, sessionId) {
  const agents = ctx.get('agents')
  return agents !== undefined && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
}

/**
 * The Session store's own live entry. `sessions.get()` returns the Session, while
 * `sessions.store` is the entry map the store's detach capability operates on.
 * The typed service surface omits the store, so this is feature-detected.
 */
function liveEntryOf(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  const store = sessions?.store
  if (store === undefined || typeof store.get !== 'function') return undefined
  return store.get(sessionId)
}

/**
 * Stop the Session's work, drain its durability, and detach the live store
 * entry.
 *
 * `agents.get()` exposes the Agent but not the `AgentHandle` that owns its
 * disposal, so a live Agent object stays registered until the harness
 * restarts. What the sidebar and the Client list read is the Session store
 * entry, and the store's own detach capability (the disposer `enter()` hands
 * to the Agent lifecycle) removes it without waiting for that handle.
 *
 * The JSONL writer opens the log for each append and closes it again, so once
 * the Agent is idle and flushed its directory has no held file handle; a later
 * wake in the detached generation fails its append instead of recreating the
 * log.
 *
 * @returns whether a live Agent or Session entry was found, whether the entry
 * was detached, and whether the Agent reached idle first.
 */
async function quiesceSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  const agent = liveAgentOf(ctx, sessionId)
  const entry = liveEntryOf(ctx, sessionId)
  let found = agent !== undefined || entry !== undefined
  let settled = true
  let detached = entry === undefined

  if (agent?.status === 'running' && typeof agent.cancel === 'function') {
    try {
      agent.cancel({ kind: 'user' })
    } catch {
      /* an Agent already settling is not a deletion failure */
    }
  }
  if (agent !== undefined && typeof agent.whenIdle === 'function') {
    try {
      await Promise.race([agent.whenIdle(), delay(QUIESCE_TIMEOUT_MS)])
    } catch {
      /* the status check below decides whether the delete may proceed */
    }
    settled = agent.status !== 'running'
  }

  if (entry !== undefined) {
    try {
      if (sessions !== undefined && typeof sessions.flush === 'function') {
        await Promise.race([sessions.flush(entry.session), delay(QUIESCE_TIMEOUT_MS)])
      }
    } catch {
      /* the log removal reports a write that still holds the file */
    }
    try {
      if (sessions !== undefined && typeof sessions.detachEntered === 'function') {
        sessions.detachEntered(entry)
        detached = true
      } else if (sessions?.store !== undefined && typeof sessions.store.delete === 'function') {
        sessions.store.delete(sessionId)
        detached = true
      }
    } catch {
      /* the guard below refuses a half-detached delete */
    }
  } else if (sessions !== undefined && typeof sessions.get === 'function' && sessions.get(sessionId) !== undefined) {
    // A live Session exists but this runtime exposes no way to detach it.
    found = true
    detached = false
  }

  return { found, detached, settled }
}

// --- durable accounting ------------------------------------------------------

/**
 * Drop the projection-cache row.
 * @returns whether a row was actually removed.
 */
async function stripProjectionCache(ctx, sessionId) {
  const domains = ctx.get('storageDomain')
  if (domains === undefined || typeof domains.get !== 'function') return false
  const domain = domains.get('session_projcache')
  if (domain === undefined || typeof domain.table !== 'function') return false
  try {
    const table = domain.table('sessions')
    if (table.get(sessionId) === undefined) return false
    await table.delete(sessionId)
    return true
  } catch {
    /* a closed unit has nothing left to clean */
    return false
  }
}

/** Find the Workspace entities that account for this Session, before files vanish. */
function findOwningWorkspaces(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') return []
  try {
    return registry.list().filter((workspace) => workspace.sessionIds.includes(sessionId))
  } catch {
    return []
  }
}

/**
 * Fallback for a composition without `workspaceRegistry` (or a registry whose
 * canonical-cwd index no longer names the Session): edit the `workspace`
 * domain directly. Archive membership keeps the Session's slot on purpose, so
 * a deleted Session has to be removed from `sessionIds` explicitly.
 */
async function stripStoredWorkspaceAccounting(ctx, sessionId) {
  const domains = ctx.get('storageDomain')
  if (domains === undefined || typeof domains.get !== 'function') return false
  const domain = domains.get('workspace')
  if (domain === undefined) return false
  let removed = false

  if (typeof domain.table === 'function') {
    try {
      const workspaces = domain.table('workspaces')
      for (const [workspaceId, record] of workspaces.entries()) {
        const owned = record === null || typeof record !== 'object' ? undefined : record.sessionIds
        if (!Array.isArray(owned) || !owned.includes(sessionId)) continue
        await workspaces.put(workspaceId, {
          ...record,
          sessionIds: owned.filter((id) => id !== sessionId),
        })
        removed = true
      }
    } catch {
      /* a closed unit has nothing left to clean */
    }
  }

  if (domain.global !== undefined && typeof domain.global.get === 'function') {
    try {
      const state = domain.global.get()
      if (state !== null && typeof state === 'object') {
        const archived = Array.isArray(state.archivedSessionIds) ? state.archivedSessionIds : []
        const pinned = Array.isArray(state.pinnedSessionIds) ? state.pinnedSessionIds : []
        const nextArchived = archived.filter((id) => id !== sessionId)
        const nextPinned = pinned.filter((id) => id !== sessionId)
        if (nextArchived.length !== archived.length || nextPinned.length !== pinned.length) {
          await domain.global.set({
            ...state,
            archivedSessionIds: nextArchived,
            pinnedSessionIds: nextPinned,
          })
          removed = true
        }
      }
    } catch {
      /* a closed unit has nothing left to clean */
    }
  }

  return removed
}

/**
 * Drop the Session from Workspace accounting through the current registry
 * surface: the archive set, the pin set and the owning Workspace's ordered
 * membership. The registry owns the durable write chain and emits the same
 * `domain/changed` notifications the shipped UI already follows.
 *
 * @returns whether any accounting surface changed.
 */
async function stripWorkspaceAccounting(ctx, sessionId, owners) {
  const registry = ctx.get('workspaceRegistry')
  let removed = false
  let ownerDetached = false
  let metadataFailed = false

  if (registry !== undefined) {
    let archived = false
    let pinned = false
    try {
      archived = registry.archivedSessionIds?.includes?.(sessionId) === true
      pinned = registry.pinnedSessionIds?.includes?.(sessionId) === true
    } catch {
      /* a registry still loading has no accounting to drop */
    }

    if (archived && typeof registry.unarchiveSession === 'function') {
      try {
        await registry.unarchiveSession(sessionId)
        removed = true
      } catch (error) {
        metadataFailed = true
        ctx.logger?.warn?.('dsh-session-delete: unarchive during delete failed: %s', String(error))
      }
    }
    if (pinned && typeof registry.unpinSession === 'function') {
      try {
        await registry.unpinSession(sessionId)
        removed = true
      } catch (error) {
        metadataFailed = true
        ctx.logger?.warn?.('dsh-session-delete: unpin during delete failed: %s', String(error))
      }
    }

    if (owners.length > 0) {
      ownerDetached = true
      for (const owner of owners) {
        if (typeof owner.detachSession !== 'function') {
          ownerDetached = false
          continue
        }
        try {
          await owner.detachSession(sessionId)
          removed = true
        } catch (error) {
          ownerDetached = false
          ctx.logger?.warn?.('dsh-session-delete: workspace detach during delete failed: %s', String(error))
        }
      }
    }
  }

  // The registry may be absent, its canonical-cwd index may no longer name the
  // Session, or the Session may be ungrouped. Edit the domain directly only
  // when the public registry path did not account for it.
  if (!ownerDetached || metadataFailed) {
    removed = (await stripStoredWorkspaceAccounting(ctx, sessionId)) || removed
  }
  return removed
}

/** Directories the current spill store may use: its configured root and defaults. */
function spillRoots(ctx) {
  const roots = new Set()
  const store = ctx.get('spillStore')
  if (typeof store?.root === 'string' && path.isAbsolute(store.root)) roots.add(store.root)
  const base = os.tmpdir()
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory() && /^dsh-spill-.{6}$/.test(entry.name)) roots.add(path.join(base, entry.name))
    }
  } catch {
    /* temp discovery is best-effort */
  }
  return roots
}

/** Best-effort spill cleanup: `<root>/session-<sha256(id)[:12]>`. */
function removeSpill(ctx, sessionId) {
  const name = `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`
  let removed = false
  for (const root of spillRoots(ctx)) {
    const dir = path.join(root, name)
    try {
      if (!fs.lstatSync(dir).isDirectory()) continue
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 0 })
      removed = true
    } catch {
      /* temp files are not worth failing a delete over */
    }
  }
  return removed
}

// --- the operation -----------------------------------------------------------

/**
 * Delete one Session end to end.
 * @param ctx - the route's context.
 * @param rawId - the Session id as the browser half reported it.
 * @returns the per-surface removal report (for the route's JSON body).
 * @throws {DeleteError} with the HTTP status the route should answer.
 */
async function deleteSession(ctx, rawId) {
  const sessionId = normalizeSessionId(rawId)

  // Read the project directory and the owning Workspace before anything is
  // removed: they are what make the exact log path and the accounting target
  // derivable rather than guessed after the header is gone.
  let cwd
  try {
    const persistence = ctx.get('sessionPersistence')
    const snapshot = persistence === undefined ? undefined : await persistence.stat(sessionId)
    cwd = snapshot?.header?.cwd
  } catch {
    /* fall back to the scan */
  }
  const owners = findOwningWorkspaces(ctx, sessionId)

  const live = await quiesceSession(ctx, sessionId)
  if (live.found && (!live.detached || !live.settled)) {
    // Removing the log while live work still owns the Session can let a queued
    // flush recreate it, so refuse instead of half-deleting.
    throw new DeleteError(409, 'session is still live; close it and try again')
  }

  // The log goes first. The projection cache and the Workspace accounting are
  // the sidebar's grouping authority, so they are only touched once the bytes
  // are confirmed gone — otherwise a half-delete strands an "Ungrouped" row.
  const dirsRemoved = await removeLogDirs(candidateDirs(ctx, sessionId, cwd))
  const projectionRemoved = await stripProjectionCache(ctx, sessionId)
  const accountingRemoved = await stripWorkspaceAccounting(ctx, sessionId, owners)
  const spillRemoved = removeSpill(ctx, sessionId)

  if (dirsRemoved === 0 && !projectionRemoved && !accountingRemoved && !live.found) {
    throw new DeleteError(404, 'session not found')
  }

  return {
    live,
    dirsRemoved,
    projectionRemoved,
    accountingRemoved,
    spillRemoved,
  }
}

// --- HTTP --------------------------------------------------------------------

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', Buffer.byteLength(text))
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

/**
 * Current-connection trust: the shared carrier decides loopback/trusted-host,
 * same-origin and browser authentication. Without a connection service (for
 * example a bare headless composition) only a loopback caller is accepted.
 */
function rejectUntrusted(ctx, req, res) {
  const connection = ctx.get('connection')
  if (connection !== undefined && typeof connection.requestRejection === 'function') {
    let rejection
    try {
      rejection = connection.requestRejection(req)
    } catch {
      rejection = 403
    }
    if (rejection !== undefined && rejection !== null) {
      res.statusCode = rejection
      res.end()
      return true
    }
    return false
  }
  const host = String(req.headers.host ?? '').toLowerCase()
  if (!host.startsWith('127.0.0.1') && !host.startsWith('localhost') && !host.startsWith('[::1]')) {
    res.statusCode = 403
    res.end()
    return true
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    res.statusCode = 403
    res.end()
    return true
  }
  return false
}

/** Collect a bounded request body; null past the ceiling (stream drained). */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

function handler(ctx) {
  return async (req, res) => {
    if (rejectUntrusted(ctx, req, res)) return
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'POST')
      res.end()
      return
    }
    if (req.headers['x-dsh-session-delete'] !== '1') {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
    if (contentType !== 'application/json') {
      sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
      return
    }

    let sessionId
    try {
      const raw = await readBoundedBody(req)
      if (raw === null) {
        sendJson(res, 413, { ok: false, error: 'request body too large' })
        return
      }
      sessionId = raw === '' ? undefined : JSON.parse(raw).sessionId
    } catch (error) {
      if (error instanceof DeleteError) {
        sendJson(res, error.status, { ok: false, error: error.message })
        return
      }
      sendJson(res, 400, { ok: false, error: 'malformed JSON body' })
      return
    }
    if (typeof sessionId !== 'string' || sessionId === '') {
      sendJson(res, 400, { ok: false, error: 'sessionId is required' })
      return
    }

    try {
      const result = await deleteSession(ctx, sessionId)
      sendJson(res, 200, { ok: true, sessionId: sessionId.trim(), ...result })
    } catch (error) {
      const status = error instanceof DeleteError ? error.status : 500
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.('dsh-session-delete: deleting "%s" failed: %s', sessionId, message)
      sendJson(res, status, { ok: false, error: message })
    }
  }
}

/**
 * Mount the route against the Web carrier. The carrier is adopted lazily and
 * re-registered whenever it is replaced, so this works both at boot and after
 * a webserver restart.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: handler(webCtx),
    }), 'dsh-session-delete: delete route')
  })
}
