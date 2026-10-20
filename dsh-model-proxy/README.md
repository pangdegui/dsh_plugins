# dsh-model-proxy

DeepSeek Harness 的出站代理控制插件：**一个面板，两种能力**。

1. **随时切换全局代理** —— 不需要重启应用，改完下一次请求就生效。
2. **按模型分流** —— 同一个端点上，A 模型走代理、B 模型直连。

![面板](docs/panel.png)

---

## 为什么不是官方 `dsh-http-proxy`

`@deepseek-ai/dsh-http-proxy` 是**库**，不是插件。启动器在第一个插件加载前调用一次
`installProxyFromEnvironment()`，之后没有任何交互面：改代理只能改环境变量 + 重启。

它确实支持运行时重装（disposer 会归还 dispatcher、policy 和环境变量），实测也成立：

```
安装 A  -> fetch 走 A
重装 B  -> fetch 走 B，env 同步变 B
切直连  -> fetch 直连，env 被清除
```

所以「能不能随时切」的答案是**能**，缺的只是开关。

但这个插件**不 import 它**，原因是一个很实际的问题：`proxyRouteFor()` 读的是模块内的
`let active`，而 `undici.setGlobalDispatcher()` 写的是
`globalThis[Symbol.for('undici.globalDispatcher.2')]`。只有后者跨模块副本共享。外部插件
从 `~/.dsh/profiles` 解析 `@deepseek-ai/dsh-http-proxy` 会得到 `MODULE_NOT_FOUND`
（启动器是从 `app.asar` 内部加载的），装了也会是**第二份实例**，两份 policy 互相看不见。

实测（同一份源码、两条物理路径）：

```
模块实例相同? false
启动器安装后  launcher.proxyRouteFor = proxied   plugin.proxyRouteFor = direct
插件侧切直连后 launcher.proxyRouteFor = proxied   globalThis.fetch 仍走代理
```

所以本插件自己持有 dispatcher 状态，只依赖一个跨副本可靠的接缝：`globalThis`。

## 已知覆盖边界

| 流量 | 是否受控 | 原因 |
|---|---|---|
| LLM 流式对话（openai-chat / responses / anthropic） | ✅ 精确到模型 | 拦 `llm/stream` waterfall |
| `dsh-llm-deepseek` 直连适配器 | ✅ | 同样经过 `llm/stream` |
| 模型发现 `GET /models` | ⚠️ 仅 `host` 规则 | pi-ai 内部发 fetch，拿不到 provider/model |
| `dsh-web-fetch-http` 网页抓取 | ❌ | 它读官方库的模块内 policy，换不掉它的 import |
| 子进程（bash / pnpm / curl） | ❌ | 未注入环境变量 |

`dsh-web-fetch-http` 这一条无法从外部补——除非改 `app.asar`。接受它，因为网页抓取不走
LLM 代理通常没有影响。

## 安装

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
- id: model-proxy
  name: dsh-model-proxy
  config:
    global:
      mode: system        # system | direct | proxy
      url: ''             # mode=proxy 时必填
      noProxy: ''         # 逗号或空格分隔
    proxies:
      local: http://127.0.0.1:10808
    rules:
      - provider: command
        model: deepseek/deepseek-v4.1-flash
        proxy: local
      - host: '*.commandcode.ai'
        proxy: local
    defaultMode: system   # 都没命中时：system | direct
    log: false
```

然后打开 `http://127.0.0.1:<port>/model-proxy`。

## 配置

### 全局层

| 字段 | 取值 | 含义 |
|---|---|---|
| `global.mode` | `system` | 保持启动器的环境代理策略 |
| | `direct` | 强制直连，绕过一切代理 |
| | `proxy` | 安装 `global.url` 指定的代理 |
| `global.url` | URL | 仅 http:// 或 https:// |
| `global.noProxy` | 列表 | 永远直连的主机；`example.com` 也匹配 `api.example.com` |

`loopback` 永远直连，不可配置——代理自己的 Web UI 会形成回环。

### 规则

按数组顺序匹配，**首个命中生效**。每条规则至少写一个匹配字段：

| 字段 | 说明 |
|---|---|
| `provider` | 提供方路由名，如 `command` |
| `model` | 模型 id；`deepseek-v4-flash` 也匹配 `deepseek-v4-flash@command`；支持尾部 `*` |
| `host` | 请求主机；支持 `*.suffix`；也用于模型发现 |
| `proxy` | 命名代理、`direct`、`system`，或完整 URL |

### 面板编辑语法

规则和命名代理在面板里是**每行一条**，字段用空格分隔：

```
provider: command model: deepseek/deepseek-v4.1-flash proxy: local
host: *.commandcode.ai proxy: local
```

解析器按 ` key:` 边界切分，所以模型 id 和 URL 里的冒号不会被误当分隔符。

## 验证

```sh
node test/rules.test.mjs      # 28 项：匹配、绕过、校验
node test/transport.test.mjs  # 12 项：真实 HTTP，切换与并发路由
node test/plugin.test.mjs     # 10 项：apply 注册、面板、表单
```

传输层测试需要一份 undici。装了这个包就用它的依赖；从源码检出直接跑时，用
`UNDICI_PATH` 指向运行中的应用所带的那份——必须是同一份，因为插件依赖的
`globalThis` dispatcher symbol 是在该副本安装时写入的：

```sh
# Windows
set UNDICI_PATH=C:\path\to\dsh\node_modules\undici\index.js
# POSIX
export UNDICI_PATH=/path/to/dsh/node_modules/undici/index.js

node test/transport.test.mjs
```

不设也不会误报通过：那组测试会以退出码 2 明确跳过。

传输测试用本地 loopback 代理服务器，通过响应体 `VIA-A` / `VIA-B` 判断实际走了哪个
代理，而不是断言内部状态——一个错误的 dispatcher 会表现为错误的响应。

## 实现要点

- `lib/rules.js` —— 纯函数，不 import Cordis 也不 import undici，可单测
- `lib/transport.js` —— 唯一碰 undici 的地方；全局 dispatcher + fetch 包装
- `lib/panel.js` —— 无脚本 HTML，每个动作都是普通表单 POST
- `lib/index.js` —— 组装：waterfall 监听、路由、生命周期

### 为什么拦 `llm/stream`

进程级 dispatcher 只有一个答案，做不到「同一端点不同模型走不同代理」。所以用
waterfall 拿到 `options.provider` / `options.model`，把决定塞进 `AsyncLocalStorage`，
再包一层 async generator，让**每一次 `next()`** 都在该上下文里跑——适配器发请求正是在
`next()` 期间发生的。

实测这个边界可靠，并发也不串味：

```
concurrent routes -> A 得到 VIA-A，B 得到 VIA-B
generator boundary -> 生成器步进内的 fetch 看到的是该步的 route
```

### 为什么包装 `globalThis.fetch`

Node 的内置 `fetch` 在这个运行时里**拒绝**外部 undici 的 dispatcher：

```
fetch(url, { dispatcher: externalProxyAgent })
  -> TypeError: fetch failed / cause: invalid onRequestStart method
```

但委托给同副本的 `undici.fetch(url, { dispatcher })` 可以。所以包装层把
「有 ambient route」的请求转给 `undici.fetch`，其余原样交给原始 fetch（保留启动器的环境
代理语义）。

## 卸载

删掉 patch 里的 `model-proxy` 条目即可。插件 unload 时会把启动器的 dispatcher 还回去，
不会把进程留在插件创建的代理上。

## License

MIT
