# 通过发布能力接入业务

这是一个独立进程 Application，只依赖公开 `@tnb/plugin-sdk`。它不接收 Owner 控制密钥，不自己选择 Adapter、资源或执行预算。

在 TNB 根目录 `bun run sdk:build`，然后在此目录：

```sh
bun install --ignore-scripts
bun run typecheck
bun run build
tnb plugins validate ./package
tnb plugins install ./package
tnb plugins trust published-intake --yes
```

跟随 [发布能力指南](../../../docs/guides/published-capabilities.md) 安装一个离线 Agent、发布 support.reply@1，设置宿主 `pluginServices`，重启并为本贡献的实际指纹授予该能力。服务注册与能力授权缺一不可。示例不自带业务身份/API Key，入口仍位于管理员认证的扩展路由内。

目录内提供可直接使用的 `publish.json` 和 `request.json`。先安装名为 reply-agent 的 Agent 模板并启动 Owner，即可验证发布与执行：

```sh
tnb runtime capabilities publish.json
tnb runtime execute request.json
```

路由前缀：`/extensions/application/published-intake/1`。

- `GET /catalog[?after=…]`：授权能力目录。
- `POST /submit`：JSON 为 `{commandId,capability:{id,version},input}`。
- `GET /status?runId=…[&after=…]`：任务分页状态。
- `GET /result?runId=…&taskId=…[&offset=…]`：正式结果 JSON 文本分片；拼接至 next 消失后解析。

不要将默认 Owner control key 分发给外部业务用户。接入外部 HTTP 需要额外业务认证与调用身份映射。进程隔离不是 OS 安全沙箱。

仓库 `tests/integration/published-capabilities.test.ts` 使用临时安装、实际信任指纹、后台 Owner、JSON-RPC 和离线模型验证本例的发布、授权、执行、重启和撤权。`tests/integration/plugin-sdk.test.ts` 在独立目录只安装本地 SDK tarball，校验类型和打包；构建后的 `.mjs` 不需要保留 SDK 开发依赖。
