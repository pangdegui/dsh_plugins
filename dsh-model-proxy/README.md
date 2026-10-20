# dsh-model-proxy

DeepSeek Harness 的**模型代理**插件：填一个代理地址，勾选要走它的模型。

- 勾选的模型请求走代理
- 未勾选的模型**完全不受影响** —— 保持原有的网络路径
- 网页抓取、插件安装、子进程等流量一律不碰

配置界面在 **设置 → 模型代理**。

---

## 怎么用

1. 打开 **设置**（`Ctrl` + `Alt` + `,`）→ 左侧 **模型代理**
2. 在「代理地址」里填一个代理，例如 `http://127.0.0.1:10808`
3. 在「生效的模型」里勾选要走这个代理的模型
4. 点 **保存**

保存会写进 profile 的 `cordis.patch.yml`，重启后仍然生效。不勾任何模型
（或清空代理地址）就等于关闭 —— 插件不做任何改道。

存储的形状就这么点：

```yaml
- id: model-proxy
  name: dsh-model-proxy
  config:
    proxy: http://127.0.0.1:10808
    models:
      - deepseek/deepseek-v4.1-flash
      - z-ai/glm-5.3-flash
    log: false
```

只支持 `http://` 和 `https://`。SOCKS 代理会被明确拒绝，而不是静默跳过。

---

## 为什么只做模型流量

这不是简化，是刻意的边界。

官方 `@deepseek-ai/dsh-http-proxy` 是**库**，启动器在第一个插件加载前调用一次
`installProxyFromEnvironment()`，装的是一个**进程级** undici dispatcher ——
它作用于该进程发出的每一个请求。

如果本插件也去 `setGlobalDispatcher`，那么网页抓取、插件安装、遥测、任何用
`fetch` 的东西都会跟着改道。而配置里谈的全是模型。这是范围放错，不是功能更强。

所以本插件**从不调用 `setGlobalDispatcher`**，机制只有两步：

1. `llm/stream` waterfall 命中规则的调用，用 `AsyncLocalStorage` 把决策挂到
   **这一次调用**上。
2. 包装 `globalThis.fetch`，**没有 ambient route 时原样放行**。

结果：卸载本插件不可能把进程留在它创建的代理上，因为它从没改过默认路径。

「未勾选」和「强制直连」是两件事：未勾选的模型走 `unrouted`，意思是
**根本不碰它**，包括启动器从环境变量装上的代理。

## 已知覆盖边界

| 流量 | 是否受控 | 原因 |
|---|---|---|
| LLM 流式对话 | ✅ 精确到模型 | 拦 `llm/stream` waterfall |
| 模型发现 `GET /models` | ❌ | pi-ai 内部发 fetch，拿不到模型上下文 |
| `dsh-web-fetch-http` 网页抓取 | ❌ | 不在范围内，这是设计要求 |
| 子进程（bash / pnpm / curl） | ❌ | 不在范围内 |
| 插件安装 | ❌ | 不在范围内 |

模型发现这一条意味着：**新模型的列表可能拉不到**（如果该端点在墙外）。
此时该端点必须靠启动器的环境代理可达。这是「只代理模型」的必然代价 ——
要覆盖它就得改全局 dispatcher，那就退回了官方库的行为。

---

## 安装

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
- insert:
    - id: model-proxy
      name: dsh-model-proxy
      config:
        proxy: ''
        models: []
        log: false
```

包装成 bundle 时，`dsh.bundle.patch` 指向本包的 `cordis.patch.yml`，加载器会
自己插入这一行。

浏览器半边在 `package.json` 的 `dsh.client` 里声明（`platform: web`），由
`window.__ModuleLoader__.load` 加载，**不需要构建步骤**。

### 从旧版本升级

第一版存的是 `{ proxies, rules }`（命名代理 + 每规则一个目标）。这个形状还能
读：插件会把第一条可用规则的代理地址取成 `proxy`，把各规则的 `model` 收成
`models`。多个不同地址的规则无法映射到一个代理，只有第一个会被保留。

下一次保存会写成新形状。

---

## 设置页放在哪，为什么

`settings.section` 是一个开放的 `list` slot（`replaceRisk: "none"`），第三方
插件可以往里加一个导航项。所以本插件是一个**独立的设置区**，而不是：

- **不是独立路由**：第一版是 `/model-proxy` 页面，得先知道 URL 才能打开。
  代理是普通配置，应该待在配置该在的地方。旧路径现在 303 跳到 `/`。
- **不是「内置插件」里的 tab**：那个 slot 的文档写的是本部署**自带**的插件，
  第三方插件不属于它。
- **不是「模型」区的表单**：「模型」区是官方包独占的单一组件，第三方加不进去。

页面直接调本插件自己的 Host 路由，不走 `remote.settings`：`settings/describe`
只列出导出了 `Config` schema 的插件，而模型清单不是生成的表单能编辑的标量字段。
Host 路由自己做校验和 `configEditor` 落盘，浏览器半边只负责渲染和读 JSON。

---

## 路由

| 路径 | 方法 | 用途 |
|---|---|---|
| `/model-proxy` | GET | 303 跳到 `/`（旧书签兜底） |
| `/model-proxy/status` | GET | 当前配置、传输层状态、最近决策 |
| `/model-proxy/models` | GET | 本部署提供的模型，按 provider 分组 |
| `/model-proxy/apply` | POST | 写入配置（JSON） |

全部经过 `connection.requestRejection` 的 Host/Origin 校验；未认证返回 401，
不被信任返回 403。

---

## 测试

```powershell
$env:UNDICI_PATH="<app>\node_modules\undici\index.js"
node test/config.test.mjs     # 18  passed
node test/rules.test.mjs      # 26  passed
node test/transport.test.mjs  # 12  passed
node test/scope.test.mjs      # 3   passed
node test/plugin.test.mjs     # 18  passed
node test/client.test.mjs     # 12  passed
```

`config` 覆盖存储形状、旧版迁移、编译成规则、校验；`rules` 是纯匹配逻辑；
`transport` 覆盖 dispatcher 与 fetch 包装；`scope` 证明未命中的请求确实不被
碰；`plugin` 用假 Cordis 上下文跑 Host 半边的全部路由；`client` 用假
`__ModuleLoader__` 跑浏览器半边的注册与渲染。

`test/undici.mjs` 负责找到一份可用的 undici：先试裸模块名，再试
`UNDICI_PATH`，都没有就跳过（退出码 2）—— 因为外部插件无法 import 启动器
自己的那份副本（模块级状态不跨副本）。
