# dsh-web-access

A standalone plugin that makes **how far a DSH profile is reachable** a
configurable setting, with an optional **TOTP (time-based one-time password)**
gate in front of the connection token.

It presumes nothing about the deployment: there is no built-in "intranet" or
"internet" mode — you choose the bind address, the authorities the browser-trust
fence accepts, and whether a one-time code is required at all.

Verified against DSH desktop `0.2.0-rc.2` and `0.2.1-rc.2`. On 0.2.1 the core
rejects a wildcard bind at startup, so LAN access goes through the built-in
reverse proxy instead of re-binding the listener (see
[How it fits together](#how-it-fits-together)); toggling it needs no restart.

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
| `bind` | `127.0.0.1` | `127.0.0.1` keeps everything local. `0.0.0.0` turns on the built-in **reverse proxy**: LAN traffic arrives on this machine's LAN address and is forwarded to the loopback listener. It is never written as a wildcard listener — dsh rejects that at startup. |
| `lanAddress` | `''` | The concrete LAN IPv4 the proxy listens on. Empty picks automatically (192.168/10 before 172.16/12, because Hyper-V and WSL live in the latter). |
| `lanPort` | `3080` | The fixed LAN port. Stable across restarts and applied live, so a URL you hand to another device keeps working. The application's own loopback port stays launch-assigned and is never exposed. |
| `autoTrustLocalIps` | `true` | While the proxy is on, trust every non-internal IPv4 address of this machine. Turn off to trust only `lanAddress` plus `trustedHosts`. |
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
另一台设备 ──▶ http://<lanAddress>:<lanPort>   (插件内的反向代理,固定端口,默认 3080)
本机 / 转发  ──▶ http://127.0.0.1:<lanPort>      (同一端口也绑回环,方便本机与端口转发)
                     │  转发 Host 原样保留
                     ▼
              http://127.0.0.1:<appPort>        (应用自己的监听器,启动时分配,从未改动)
```

两条硬约束决定了这个设计:

1. **`0.0.0.0` 会被核心直接拒绝。** `dsh-host-webserver` 在配置校验阶段就抛
   `host "0.0.0.0" is an unspecified (wildcard) address`;`webserver` 是 required
   插件,所以整个应用**启动失败**。任何写进 `webserver.host` 的通配地址都会让
   Harness 起不来。
2. **桌面端窗口的 URL 写死 `http://127.0.0.1:<port>`。** 把监听器改绑到局域网
   地址,窗口就指向一个没人监听的 socket。

所以插件不再动监听器,而是在**同一个端口的本机局域网地址**上起一个反向代理
(`http` + `WebSocket` upgrade 原样隧道),把请求转发给 `127.0.0.1:<port>`。
监听地址的切换因此**立即生效,不需要重启**。

代理用的 authority 必须被 Host/Origin 栅栏接受,所以插件会向 profile patch 写入
一小段托管行(仅 `connection.trustedHosts`,刻意不写 `webserver`):

```
另一台设备 ──▶ 代理 ──▶ 应用
                │
                └─ 栅栏检查 Host: <lanAddress>:<port>  → 必须在 trustedHosts 里
```

托管区块位于 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`,由
`# >>> dsh-web-access managed rows >>>` 标记包围,请勿手改;把 `bind` 设回
`127.0.0.1` 会删除整个区块。`status.managed` 记录这次写入的路径、是否改动、时间
与错误,写不进去时不再静默。

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
- **The LAN proxy exposes the port to every device on the network**, including
  devices you did not plan for. `trustedHosts` is what the fence actually
  enforces, so if you want exactly one device, turn off `autoTrustLocalIps` and
  list that device's IP (the proxy address is always included).
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

- **The application's own loopback port is not configurable.** The desktop host
  binds a launch-assigned port and opens its window at that exact address, so
  pinning it would desynchronise the window and a busy port would be a fatal
  startup error. Only the LAN-facing `lanPort` is fixed (3080 by default), which
  is the number other devices actually see.
- **QR encoding is vendored.** `lib/uqr.js` is uqr 0.1.3 (MIT, see
  `lib/uqr.LICENSE`), so the QR is rendered inside the authenticated panel and
  the shared key never leaves the machine. The base32 key and the `otpauth://`
  URI stay copyable for authenticators without a camera.
- **Token URLs are hidden while the gate is on.** A `?token=…` URL is the
  application's own credential and bypasses `/dsh-access` entirely; offering it
  next to a one-time-code gate would make the gate decorative. Enable TOTP and
  hand other devices the `/dsh-access` URL (or its QR) instead.
- **Not a TLS-terminating proxy.** The built-in proxy speaks plain HTTP on the
  LAN and forwards bytes; TLS termination, IP allow-lists at the network layer,
  and per-device revocation are out of scope; this plugin operates inside the
  harness's own request trust.

## Install

```sh
dsh plugin --profile desktop add file:F:/test/plugins/dsh-web-access
```

Restart the harness for the Host half; the card and status block arrive with the
next page load.
