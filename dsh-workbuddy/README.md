# dsh-workbuddy

把 **WorkBuddy（腾讯 WorkBuddy）** 的账号登录与聊天模型接入 **DeepSeek Harness**。

插件只做两件事，且都建立在 WorkBuddy 自己的协议之上：

1. **账号平面**：浏览器登录 → token 轮询 → 本地持久化 → 到期自动刷新。
2. **模型平面**：把 WorkBuddy 的 OpenAI 兼容网关（`{endpoint}/v2`）注册成
   DSH 的一条 `pi-ai` provider 路由，模型目录随插件一起提供。

token 不写入任何 YAML：它存放在 DSH 凭据 seam 的 `WORKBUDDY_ACCESS_TOKEN`
里，`llm-pi-ai` 的 `apiKeyEnv` 按请求读取，刷新后下一次请求立即生效。

配置界面在 **设置 → WorkBuddy**：显示登录状态、账号、token 到期时间、模型路由，
点「登录 / 重新登录」会在页面里弹出二维码，扫码完成后弹窗自动关闭。

---

## 安装

这是一个标准的 DSH bundle（`dsh.bundle.patch` + Host 入口 + 浏览器配置页）。
在 **设置 → 插件** 里安装本包最省事；也可以按 Git 地址安装（monorepo 需带
子目录）。安装后重启 DSH 生效。

手工放进 profile 时，把包加入 `dependencies` 和 `dsh.profile.bundles`：

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-workbuddy": "github:<owner>/dsh-workbuddy"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-workbuddy"]
    }
  }
}
```

插件加载时会：

- 读取 `$DSH_HOME/workbuddy/session.json`（如果有），把 access token 写入凭据；
- 如果 `llm-pi-ai` 里还没有 `workbuddy` 路由，就通过 Loader 的
  `configEditor` 写入它（含 46 个模型的目录），写进 profile patch 并热重载
  该条目；
- 每 60 秒检查一次 token，临近过期（默认 10 分钟）时自动刷新。

已经存在的 `workbuddy` 路由默认**不会**被覆盖，避免冲掉你在 DSH「模型」页做
的修改。要随插件升级刷新模型目录，设置 `syncProviderModels: true`，或删掉
profile patch 里的该路由后重启。

## 登录

打开 **设置 → WorkBuddy**，点「登录 / 重新登录」。页面会向 Host 要一个新的
WorkBuddy 登录地址，并把它渲染成二维码弹窗：

- 用手机上的 WorkBuddy / 微信扫码，或点弹窗里的「在浏览器中打开登录页」；
- 登录完成后弹窗自动关闭，页面立即显示账号、UID 与 token 到期时间；
- 关闭弹窗即放弃这次登录；再次点击会复用仍在有效期内（10 分钟）的登录流程。

Host 每 1.5 秒轮询一次 WorkBuddy，拿到 token 后自动完成：

- 写 `$DSH_HOME/workbuddy/session.json`（`0600`）；
- 把新 token 写入凭据 `WORKBUDDY_ACCESS_TOKEN`（下一次模型请求立即生效）；
- 更新 `/workbuddy/status`（配置页读的就是它）。

也可以直接用 `?format=json` 取登录链接和二维码：

```
GET /workbuddy/login?format=json   -> { "authUrl": "...", "state": "...", "qr": "data:image/svg+xml;base64,..." }
GET /workbuddy/status              -> { loggedIn, account, expiresAt, provider, catalogSize }
POST /workbuddy/logout             -> 清除本地会话与凭据
```

`/workbuddy` 仍保留一个无脚本的独立页面，供不走 Web UI 的调用方或不方便打开
设置面板时兜底。

模型路由在首次安装时就会装好，所以**未登录也能在模型列表里看到 WorkBuddy
的模型**，只是请求会以 `MISSING_CREDENTIAL` 失败，登录后立即恢复。

登录完成后，在 DSH 的模型选择器里选择 `WorkBuddy` 下的模型即可。默认目录
包含 46 个支持工具调用的聊天模型（`fast-model`、`deep-model`、GLM、Kimi、
DeepSeek、MiniMax、Hunyuan 等），略去图片/视频/补全等非聊天路由。

## 协议摘要（为什么能这样接）

- 登录状态：`POST /v2/plugin/auth/state?platform=workbuddy`
  → `{ state, authUrl }`；浏览器完成后
  `GET /v2/plugin/auth/token?state=...` → `{ accessToken, refreshToken, ... }`。
- 刷新：`POST /v2/plugin/auth/token/refresh`，请求头 `X-Refresh-Token`。
- 账号：`GET /v2/plugin/account`，`Authorization: Bearer <token>`。
- 模型：`POST /v2/chat/completions`，OpenAI Chat Completions 形状，
  **只支持流式**（非流式会被服务端以 `11101` 拒绝），支持 `tools` 与
  `stream_options.include_usage`。

## 安全

- token 只落在 `$DSH_HOME/workbuddy/session.json` 与 DSH 凭据存储，不进配置、
  不进日志（日志只记录到期时间与账号 uid）。
- `/workbuddy` 的 HTTP 路由复用 DSH `connection` 的 Host/Origin 栅栏，并要求
  已登录的 DSH 会话；未登录返回 401。
- 退出登录会同时删除本地会话、删除凭据；WorkBuddy 侧的会话仍可在其 App 内
  单独退出。

## 开发与测试

```bash
npm test                     # 目录完整性、provider 行映射、token 过期与归一化
node test/client.test.mjs    # 配置页：注册、字典、样式表与初始渲染
```

`test/` 只做无网络检查；协议本身用两种方式验证过：

- 账号平面：真实走通 `auth/state → 浏览器登录 → auth/token → account →
  token/refresh`；
- 模型平面：用 DSH 自己依赖的 `@earendil-works/pi-ai` 的
  `openai-completions` 传输直接打 WorkBuddy，确认文本流、`tool_calls`、
  `reasoning_content`、usage 都能被 pi-ai 正确解析成 DSH 需要的事件。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 模型列表没有 `WorkBuddy` | profile 未加入 bundle，或没有 `llm-pi-ai` 行；看 DSH 日志里 `workbuddy:` 开头的告警。 |
| 请求报 `MISSING_CREDENTIAL` | 未登录或凭据被清掉；打开 **设置 → WorkBuddy** 重新登录。 |
| 请求 401/403 | token 被服务端吊销；重新登录。 |
| 登录页打不开 | 需要能访问 `www.workbuddy.cn`；也支持 `endpoint: https://staging.workbuddy.cn`。 |
| 刷新一直失败 | refresh token 过期（通常远长于 access token）；重新登录即可。 |

## 目录

```
lib/index.js     Cordis 插件：路由、会话、凭据、pi-ai 路由对账、登录二维码
lib/client.js    设置 → WorkBuddy 配置页（登录状态、扫码弹窗、退出）
lib/wb.js        WorkBuddy 账号/模型协议客户端（纯 Node，无 Cordis）
lib/provider.js  provider 行与 token 过期判断（纯函数）
lib/catalog.js   随插件发布的模型目录（由 WorkBuddy 产品配置生成）
lib/uqr.js       随包引入的二维码渲染（uqr 0.1.3，MIT，见 lib/uqr.LICENSE）
tools/gen-catalog.mjs  从 wb-product-config.json 重新生成模型目录
test/unit.mjs    无网络单元检查（npm test）
test/client.test.mjs  配置页的加载器/注册/渲染检查
locale/*.json    插件清单里的名称与说明
icon.svg         插件图标
cordis.patch.yml bundle 层：插入 workbuddy 行
```

二维码在本机由 Host 渲染成内联 SVG data URI 后交给配置页，不经过任何第三方
二维码服务，也不把登录链接发给外部。
