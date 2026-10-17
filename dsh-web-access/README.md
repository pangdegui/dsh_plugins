# dsh-web-access

A standalone plugin that makes **how far a DSH profile is reachable** a
configurable setting, with an optional **TOTP (time-based one-time password)**
gate in front of the connection token.

It presumes nothing about the deployment: there is no built-in "intranet" or
"internet" mode — you choose the bind address, the authorities the browser-trust
fence accepts, and whether a one-time code is required at all.

Verified against DSH desktop `0.2.0-rc.2`.

## What you get

**A panel in the application chrome.** The sidebar's global panel row
(`sidebar.panellist`) gains one icon at `order: 5`, which places it between the
shipped **插件 / Plugins** row (`order: 0`) and **自动化任务 / Automation
tasks** row (`order: 10`). The same id addresses the matching central panel
(`main` → `key: 'web-access'`), so the button and the page are one entry.

The panel holds the reachability controls, a live status block, and the TOTP
provisioning in one place — no settings subpage, and no dependency on the
settings-form machinery.

| Setting | Default | Meaning |
|---|---|---|
| `bind` | `127.0.0.1` | The address the webserver listens on. The other legal value is `0.0.0.0` (every interface). Applied live — no restart. |
| `autoTrustLocalIps` | `true` | While binding `0.0.0.0`, trust this machine's non-internal IPv4 addresses. Turn off to pin the fence to an explicit list. |
| `trustedHosts` | `[]` | Extra authorities the Host/Origin fence accepts: `host` (any port) or `host:port`. |
| `totpEnabled` | `false` | Require a one-time code before the login entry hands back the launch token. |
| `totpGate` | `all` | `all` = every caller; `remote` = non-loopback callers only. |

**Three Host routes:**

- `GET/POST /dsh-access` — the script-free login entry: verify the code, then
  redirect through the application's own launch-token exchange.
- `GET/POST /dsh-access/setup` — provisioning. Requires the ordinary session
  cookie, and is the only thing that ever returns the shared key.
- `GET/POST /dsh-access/config` — the panel's own settings API. Reading and
  writing both require the session cookie; the write is answered *before* it is
  persisted, because persisting restarts this plugin's fiber and a response still
  queued across that restart would never reach the browser.

**A live status block** in the panel: current bind, the port in use, the
authorities currently trusted, the origins another device would reach, the login
URL to type elsewhere, plus show/rotate controls for the key.

It also lists the per-origin **launch-token URLs** (`?token=…`). A bare
`http://host:port` answers `401 dsh web authentication required`, because the
application's own `/` route accepts only the process launch token — that is
upstream behaviour, not something this plugin changes. Copying one of those URLs
to another device completes the ordinary authority-bound cookie exchange, which
is the supported way to reach this Harness from a second device while TOTP is
off. Treat such a URL as a password: it grants full access to this Harness.

## How it fits together

```
你的插件配置  ──apply──▶  configEditor.edit(entry, …)
                              │  持久化到 profile cordis.patch.yml
                              │  reconcileProfilePatches → 只重载该 entry
                              ▼
                    cordis fiber.update() → restart()
                              ▼
                    WebServer[Service.init] → server.listen(host, port)   ← 真的重新绑定
```

So `bind` is not a separate "web access" switch bolted onto the app: the plugin
rewrites the *existing* `webserver` entry's configuration through the
Loader-owned path, and Cordis's restart semantics make `Service.init` run again,
which rebinds the socket. Nothing else in the app is bypassed.

Each target is written at most once per process (see `written`), so a reconcile
can settle instead of becoming a restart loop.

The fence is **not reimplemented**: every route this plugin serves calls
`connection.requestRejection(req)` — the same Host/Origin + cookie check the
`/api` bridge uses — so a rebound or cross-site caller is refused before any
TOTP logic runs. `401` (trusted but anonymous) is what the login page serves;
`403` is refused outright.

## The TOTP flow

```
另一台设备  ──▶  http://<你的IP>:<端口>/dsh-access      (fence: 401 = 受信但未认证)
                    │  输入 6 位动态码
                    │  校验通过 → 303 → connection.authenticatedUrl('http://<authority>/')
                    ▼
              GET /?token=<launchToken>   ← 应用自己的根交换,原样复用
                    ▼
              签发 authority-bound cookie → 303 到 ./  → 应用正常加载
```

The app never learns about TOTP: the gate sits *in front of* the token, and the
browser ends up holding the ordinary cookie. Nothing inside the app is modified.

Implementation is dependency-free: RFC 4648 base32 + RFC 6238 HMAC-SHA1 via
`node:crypto`, with a ±1 step window so a slightly skewed clock still works, and
`timingSafeEqual` on the comparison.

**Brute force** is bounded: 8 attempts per source address per 10 minutes, plus a
fixed 400 ms cost per attempt. A 6-digit code with three valid steps at any
moment is not reachable at that rate.

## Security notes — read before enabling

- **The token is still the application's own credential.** TOTP guards *this
  plugin's* entry, i.e. how you obtain the launch token; it does not replace the
  application's `/` exchange. Do not hand `/?token=...` URLs to other devices —
  give them `/dsh-access` instead (the panel prints that URL).
- **`0.0.0.0` exposes the port to every device on the network**, including
  devices you did not plan for. `trustedHosts` is what the fence actually
  enforces, so if you want exactly one device, turn off `autoTrustLocalIps` and
  list that device's IP.
- **The shipped cookie omits `Secure`** (upstream: the server is loopback HTTP).
  Over a plaintext network the cookie travels unencrypted. That is inherent to
  the current transport, not something this plugin can change.
- **Anyone who can read `$DSH_HOME` can disable or read TOTP.** That is the same
  trust boundary as the rest of the harness.

## Recovery

If you enable `totpGate: all` and lose your authenticator:

1. Delete `$DSH_HOME/web-access/totp.secret` (the key is *not* configuration —
   it lives in its own file precisely so no config reload is involved), or
2. Set `totpEnabled: false` in the profile's `cordis.patch.yml`, or
3. Edit `bind` back to `127.0.0.1` and use the desktop window directly.

The key file is written with mode `0600` and is never projected to any client:
it is absent from the plugin's Config, so no form or settings projection carries
it, and it is only ever returned by `/dsh-access/setup` behind the full cookie.

## Deliberate limits

- **`port` is not configurable here.** The listening port belongs to the launch,
  not to this plugin, and an already-open page is bound to the port it loaded
  from; changing it in place would desynchronise the page from the server. The
  panel shows the live port read-only instead, and every trusted-host entry is
  port-agnostic unless you write `host:port` explicitly.
- **No QR code.** Rendering one would mean shipping a QR encoder or calling a
  third-party image API, and the latter would leak the shared key off-machine.
  The panel offers the base32 key and the `otpauth://` URI as copyable text;
  every authenticator app can paste either.
- **Not a reverse proxy.** TLS termination, IP allow-lists at the network layer,
  and per-device revocation are out of scope; this plugin operates inside the
  harness's own request trust.

## Install

```sh
dsh plugin --profile desktop add file:F:/test/plugins/dsh-web-access
```

Restart the harness for the Host half; the card and status block arrive with the
next page load.
