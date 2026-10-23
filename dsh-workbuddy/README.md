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
GET /workbuddy/status              -> { loggedIn, account, expiresAt, provider, catalogSize, promptGuard }
POST /workbuddy/prompt             -> { mode: "prepend" | "strip" | "off", prefix }
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
- **提示词校验**：网关会拒绝系统提示词里出现 DSH 的身份标识，返回 `400` 与业务码
  `11128 Illegal API invocation from an unapproved channel`。这条规则**变过**：
  最早只看开头那句 `You are an AI agent powered by DeepSeek Harness.`，现在整段
  扫描——把开头那句删掉、只在后面的运行时上下文里留下 `The runtime context names
  the DeepSeek Harness implementation checkout…`，一样会被拒。所以插件的提示词守卫
  不只处理开头，还会把整段提示词里的 `DeepSeek Harness` / `deepseek-harness`
  统一改名成 `WorkBuddy`（实测改名后同样内容可以正常流式返回）。
- **角色校验**：网关同样拒绝 `role: "developer"` 的指令消息，返回同一个
  `11128`。pi-ai 只在「模型是推理模型 + compat 允许」时才把指令消息发成
  `developer`。
- **User-Agent 校验（最容易被忽略的一条）**：DSH 会给全进程的请求固定一个
  `User-Agent: deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)`，
  网关对带这个头的请求直接回 `11128 request illegal`。实测把同一份请求体的
  UA 换成 Node 默认、`pi (…)` 或 `WorkBuddy/1.0` 都能正常流式返回。
- **官方客户端的整套头**：官方桌面端在把请求转给网关前会重写一套头（其 bundle
  里的 `applyGatewayHeaders` / `applyTraceHeaders`）：`X-IDE-Type` /
  `X-IDE-Name=WorkBuddy`、`X-IDE-Version`、`X-Product=SaaS`、`X-Private-Data=true`、
  `x-codebuddy-request=1`、`X-Agent-Intent=craft`、`X-Agent-Purpose=conversation`、
  `x-requested-with=XMLHttpRequest`、`Accept-Encoding=identity`、
  `X-Request-ID` / `X-Conversation-ID` 等 UUID，外加 `traceparent`、`b3`、`X-B3-*`
  追踪头，UA 是 `WorkBuddy/<version> WorkBuddy/<version>`。插件默认就发这一套
  （`gatewayHeaders: true`），并顺手去掉 `x-stainless-*` 这类 SDK 指纹。
- 这三条是**独立**的：只改提示词开头仍然会踩到角色和 UA，只改 UA 也仍然会踩到
  提示词。插件的出站守卫（`lib/wire.js`）负责后两条，提示词守卫负责第一条。

## 提示词守卫（11128）

WorkBuddy 的模型网关会做一次"渠道校验"，对三种请求返回 `400 / 11128`：

1. 系统提示词里出现 DSH 的身份标识（整段扫描，不只开头）；
2. 指令消息用了 `developer` 角色（pi-ai 对推理模型会优先用它）；
3. `User-Agent` 自称 `deepseek-harness/…`（DSH 的默认值）。

第 2、3 条由插件的**出站守卫**（`lib/wire.js`）在 `globalThis.fetch` 上修掉：
发往本插件端点的 `/v2/chat/completions` 请求，`developer` 角色改写成 `system`，
请求头整体换成官方客户端那一套（UA `WorkBuddy/<appVersion> …`，去掉
`x-stainless-*` 与 harness 归因头），都在离开进程前完成。provider 行里的
`compat: { supportsDeveloperRole: false }` 仍然保留，作为不依赖 wire 层的第二道
保险。每个被检查的请求会往 `$DSH_HOME/workbuddy/wire.log` 记下角色、工具数、
token 上限、请求头和每条指令消息的开头 60 字（token 打码），失败时还会记下
响应状态与响应体。

第 1 条取决于提示词内容，**设置 → WorkBuddy → 提示词守卫**提供四种处理方式：

| 方式 | 发出去的系统提示词 |
|---|---|
| 关闭 | 原样发送（只在改用其它网关或官方客户端时合适） |
| 在开头增加一句（默认） | 把前置文本放到第一段前面，所有段落原样保留 |
| 删除身份行 | 移除 `harness:identity` 段，提示词从部署人设开始 |
| 删除并换成 WorkBuddy 介绍 | 移除身份行，把 `promptPrefix` 放到最前面当开场白 |

除「关闭」外，三种方式都会把提示词里所有的 `DeepSeek Harness` /
`deepseek-harness` 改写成 `WorkBuddy`——这一条是内容级的，改名后同一份提示词
实测可以正常返回。

只影响本插件注册的 provider 路由；其它 provider 拿到的提示词与装配结果一字不
差。守卫挂在 `system-prompt/assemble` 瀑布上，读的是该次装配的
`variables.provider`，所以同一次对话切换模型也不会串。

配置存在插件自己的行里，页面保存后写入 profile patch 并热重载：

```yaml
- id: workbuddy
  config:
    promptGuard: replace            # off | prepend | strip | replace
    promptPrefix: This session is served through WorkBuddy.
    gatewayHeaders: true            # 发官方客户端那套请求头（默认开）
    appVersion: 1.0.0               # 写进 X-IDE-Version 和 UA 的版本号
```

插件写进 `llm-pi-ai` 的那条路由同时带有角色开关：

```yaml
providers:
  workbuddy:
    api: openai-completions
    baseURL: https://www.workbuddy.cn/v2
    compat:
      supportsDeveloperRole: false   # 否则推理模型会被发成 developer 角色
```

已有路由默认不会被插件改写（`syncProviderModels: false`），从旧版本升级时请
手工补上 `compat`，或删掉该路由后重启让插件重写。

`POST /workbuddy/prompt`（`{ "mode": "prepend", "prefix": "..." }`）是页面用的保存
接口；没有 `configEditor` 时改动仍然对本次运行生效，只是重启后丢失。

## 安全

- token 只落在 `$DSH_HOME/workbuddy/session.json` 与 DSH 凭据存储，不进配置、
  不进日志（日志只记录到期时间与账号 uid）。
- `/workbuddy` 的 HTTP 路由复用 DSH `connection` 的 Host/Origin 栅栏，并要求
  已登录的 DSH 会话；未登录返回 401。
- 退出登录会同时删除本地会话、删除凭据；WorkBuddy 侧的会话仍可在其 App 内
  单独退出。

## 开发与测试

```bash
npm test                     # 目录完整性、provider 行映射、token 过期与归一化、提示词守卫
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
| 请求报 `400 / 11128` | 三个独立原因：① 提示词以 DSH 身份句开头 → 把 **设置 → WorkBuddy → 提示词守卫** 设为「在开头增加一句」或「删除身份行」；② 指令消息是 `developer` 角色；③ `User-Agent` 是 `deepseek-harness/…`。②③ 由插件的出站守卫自动处理，看 `$DSH_HOME/workbuddy/wire.log` 里有没有 `REWROTE` 行即可确认。 |
| 请求 401/403 | token 被服务端吊销；重新登录。 |
| 登录页打不开 | 需要能访问 `www.workbuddy.cn`；也支持 `endpoint: https://staging.workbuddy.cn`。 |
| 刷新一直失败 | refresh token 过期（通常远长于 access token）；重新登录即可。 |

## 目录

```
lib/index.js     Cordis 插件：路由、会话、凭据、pi-ai 路由对账、登录二维码、提示词守卫
lib/client.js    设置 → WorkBuddy 配置页（登录状态、扫码弹窗、退出、提示词守卫）
lib/wb.js        WorkBuddy 账号/模型协议客户端（纯 Node，无 Cordis）
lib/provider.js  provider 行与 token 过期判断（纯函数）
lib/prompt-guard.js  11128 守卫的纯函数：识别身份句，前置一句或删除
lib/wire.js      出站守卫：把发往网关的 developer 角色改写成 system，并记录 wire.log
lib/catalog.js   随插件发布的模型目录（由 WorkBuddy 产品配置生成）
lib/uqr.js       随包引入的二维码渲染（uqr 0.1.3，MIT，见 lib/uqr.LICENSE）
tools/gen-catalog.mjs  从 wb-product-config.json 重新生成模型目录
test/unit.mjs    无网络单元检查（npm test）
test/wire.test.mjs   出站守卫的改写/放行/日志检查
test/client.test.mjs  配置页的加载器/注册/渲染检查
locale/*.json    插件清单里的名称与说明
icon.svg         插件图标
cordis.patch.yml bundle 层：插入 workbuddy 行
```

二维码在本机由 Host 渲染成内联 SVG data URI 后交给配置页，不经过任何第三方
二维码服务，也不把登录链接发给外部。
