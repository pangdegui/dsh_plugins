# dsh_plugins

一组自包含的 [DeepSeek Harness](https://github.com/deepseek-ai) 插件，每个目录是一个可独立安装的 bundle。

## 插件

| 插件 | 说明 |
|---|---|
| [dsh-workbuddy](dsh-workbuddy/) | 登录 WorkBuddy（腾讯），把它支持的聊天模型接入 DSH；支持二维码/浏览器登录与 token 自动续期。 |
| [dsh-model-proxy](dsh-model-proxy/) | 只让选中的模型走指定 HTTP 代理，其余请求保持原网络路径。 |
| [dsh-web-access](dsh-web-access/) | 配置监听地址与受信主机，可选在启动令牌前加一道 TOTP 验证。 |
| [dsh-session-delete](dsh-session-delete/) | 在侧栏菜单提供「删除会话」，连同日志、投影缓存、工作区记账和 spill 文件一起清理。 |

## 插件市场索引

仓库根目录的 [`plugin-market.json`](plugin-market.json) 是 DSH「自定义插件市场」的格式 1 索引，列出上面这些 bundle 的版本、安装来源和展示信息。

在 DSH 里使用：

1. 在 Web 侧栏的 **插件** 页把 **自定义插件市场** 打开（实验性组合包，默认关闭）。
2. 进入 **发现** 标签页，点 **添加索引源**。
3. 填入索引 URL：

   ```
   https://raw.githubusercontent.com/pangdegui/dsh_plugins/master/plugin-market.json
   ```

   索引拒绝重定向，必须使用最终地址；如果你更喜欢 CDN，可以用等价的 jsDelivr 地址。

4. 之后即可在 **发现** 里浏览、搜索并安装；安装会用索引里钉死的提交与子目录，例如
   `git+https://github.com/pangdegui/dsh_plugins.git#<commit>&path:/dsh-workbuddy`。

> 没有官方市场时，**发现** 只显示你添加的索引源；索引内容由本仓库负责。

## 更新索引

修改某个插件的版本后，重新生成并提交：

```bash
node tools/gen-market-index.mjs
```

生成器从每个目录的 `package.json` 与 git 读取包名、版本、发布时间和当前提交，保留索引里已有的标题、描述、分类、标签与图标等编辑内容。索引里的版本固定到生成时的 `HEAD`，因此后续 `master` 前进不会改变已发布版本指向的代码。

索引格式由 DSH 的 `@deepseek-ai/dsh-plugin-market-index` 校验；生成器输出应与该包的 `parseMarketIndex` 兼容。
