# 工单业务插件：独立 SDK 接入示例

同一个包提供两个贡献：`ticket-review` 使用 `defineAgent` 读取授权工单并以真实工具回执验收；`ticket-intake` 在独立进程接收工单，通过宿主提供的分类服务写入幂等记录。没有文件编辑、Shell 或 Coding 配置。模型与分类服务都是离线测试夹具，不代表生产分类质量。

在 TNB 仓库先生成 SDK：

```sh
bun run sdk:setup
bun run sdk:build
cd examples/plugins/ticket-intake
bun install --ignore-scripts
bun run check
```

可把整个目录复制到其他地方，把 package.json 中 `@tnb/plugin-sdk` 的 `file:` 路径改成实际 tarball 后运行。`src` 只依赖公开 SDK；测试只依赖 `@tnb/plugin-sdk/testing`，无需 TNB 源码路径。严格类型检查包括完整 SDK 声明，不跳过库检查。

测试显式提供 Schema 配置、服务授权和分类服务，验证：首次接收、Owner 重启、重复输入不再次分类、同 ID 不同文本返回 409，以及带领域验收的 Agent 任务。Windows 运行进程应用和重启验证；Agent 任务目前仍要求 macOS/Linux 的持久产物屏障。

安装时只安装 `package/`。此业务需要宿主显式提供 `example.support/v1` 服务与配置，不能仅安装后就自动获得生产服务、模型凭据或默认 CLI 路由。接入实际模型时替换离线传输，并按业务补充语义质量验证。
