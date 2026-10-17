# dsh-session-delete

Adds the operation the DeepSeek Harness sidebar has never had: **permanently
delete a session**. The shipped workspace browser offers archive/unarchive only,
so an archived conversation keeps its log on disk forever and "tidying up" never
reclaims anything.

Verified against DSH desktop `0.2.1-rc.2`.

## What the user sees

- A red **删除会话 / Delete session** row at the bottom of every Session row's
  `...` menu, below the shipped Pin / Rename / Fork / Archive / Copy Session ID
  rows.
- A **risk-consent dialog**: it names the Session and its id, warns when the
  Session is running, and keeps the confirm button disabled until "I
  understand the consequences" is checked.
- After a committed delete the sidebar list is re-pulled **in place** (no page
  reload). If the deleted Session was the open conversation, the next remaining
  Session is opened, or a new blank Session starts when none remains.

The row and the dialog are plain React with the Harness theme tokens. Current
plugin guidance keeps Client bundles on the baseline `react` module, so this
package imports no Harness Client package and declares no Client externals.

## What is deleted

In this order, so a failure can never strand a half-deleted Session:

| # | Surface | Location |
|---|---|---|
| 1 | Live Session | `agents.get(id)`, then `cancel({ kind: 'user' })` + `whenIdle()`, `sessions.flush(entry.session)`, then the store's own detach capability; time-boxed at 10 s each |
| 2 | Session log | `<persistence root>/<projectKey(cwd)>/<session id>/` — exact path from the stored header, plus a full scan fallback and `_no-cwd` |
| 3 | Projection cache | `session_projcache` domain, `sessions` table |
| 4 | Workspace accounting | `workspaceRegistry`: archive set, pin set, and the owning Workspace's `sessionIds` |
| 5 | Spill files | `<spill root>/session-<sha256(id)[:12]>` plus default `dsh-spill-*` temp roots (best effort) |

The log directory is removed **before** the workspace accounting is touched, and
the accounting is only detached once the log is confirmed gone. The reverse
order lets a failed filesystem delete evict a Session from its group and leave it
behind as a ghost "Ungrouped" row.

The live Agent is stopped and its Session is detached from the store that feeds
the sidebar and the Client list. The current runtime exposes no `AgentHandle`
lookup by id, so the Agent object itself stays registered until the harness
restarts; it is idle and its Session is already gone from every list. The JSONL
writer opens the log per append and closes it again, so the directory has no held
file handle once the Session is flushed; a later wake in the detached generation
fails its append instead of recreating the log.

A Session that is open in another process is not visible to this Host and is not
affected.

### Deliberately not deleted

- `DSH_HOME/attachments/v1` — content-addressed and shared between Sessions, so
  a single-Session delete cannot own those objects.
- Telemetry already delivered upstream — it cannot be recalled.
- Text in *other* Sessions that mentions this Session — that is their data.

## How it hooks into the existing UI

No DOM injection and no monkey-patching of shipped components; both halves use
shipped extension points.

| Half | File | Role |
|---|---|---|
| Host | `lib/index.js` | Adopts `webServer` lazily and serves `POST /plugins/dsh-session-delete/delete`. Performs the whole deletion. |
| Browser | `lib/client.js` | Registers a `sidebar.workspaces.session.menu.item` row and a `shell.overlay` dialog; posts to the route and re-pulls the Session list. |

The route uses the current `connection.requestRejection` fence: loopback or
`trustedHosts` authority, same-origin browser markers, and the authenticated
browser cookie. The handler additionally requires a JSON content type and the
`x-dsh-session-delete: 1` header, so a plain cross-site form cannot reach it.
Without a `connection` service (a bare headless composition) only a loopback
caller is accepted.

Display metadata lives in `locale/en.json` and `locale/zh.json` under `meta`,
with an original `icon.svg` exported as `./icon`.

## Install

```sh
dsh plugin --profile desktop add file:F:/test/plugins/dsh-session-delete
```

Or install the same directory through **Settings → Plugins**. Restart the
harness afterwards so the Host half reloads; the browser half arrives with the
page.

## Known limits

- Deleting a Session that is open in this Host stops and detaches it, so its
  conversation view is closed. The Agent object stays registered until the
  harness restarts because the runtime has no public `AgentHandle` lookup by
  id; it is idle and its Session is already absent from every list.
- If a live Agent refuses to settle within the time box, or its Session entry
  cannot be detached, the delete is refused with `409` **before** any file is
  touched, so a queued flush cannot recreate the log.
- The removal retries briefly for a held log handle and reports a `500` if the
  log is still on disk. Nothing is detached from workspace accounting in that
  case.
- A Session owned by another process is outside this Host's live registry; its
  writer is not stopped, so deleting its log is not coordinated with that
  process.
- Deleting a parent Session leaves its forked children's own headers naming it;
  those headers are the children's durable data.
- The spill sweep covers the mounted `spillStore.root` and the default
  `dsh-spill-*` temp roots; a process with an unreachable custom root leaves
  that Session's spill directory behind (harmless — nothing reads it once the
  Session is gone).
