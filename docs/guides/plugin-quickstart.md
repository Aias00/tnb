# 从零创建并验证插件

先用离线样例走通真实执行，再接入业务模型或服务。所有命令使用已安装的 `tnb`；开发仓库中可先 `bun run build`，把下文的 `tnb` 换成仓库内 `dist/tnb` 的绝对路径。

```sh
tnb plugins init ./my-agent
cd my-agent
tnb plugins validate .
tnb plugins test . --yes
```

不需要 API Key、依赖下载或构建。默认 Agent 模板通过离线模型调用 `read_message`，内核持久记录工具结果，领域 `accept` 核对实际回执后接受报告。通过测试说明这条真实接入链路可以运行；离线模型只是演示，接入真实业务时替换 `createWorker` 的 transport、工具和验收逻辑。

需要 TypeScript 类型提示和标准工程结构时，加 `--language typescript`，再执行 `bun install --ignore-scripts`、`bun run check`。独立 `@tnb/plugin-sdk` 的本地 tarball 随 TNB 构建交付，详见[SDK 开发指南](plugin-sdk.md)。

## 按职责选择模板

```sh
tnb plugins init ./my-app --template application
tnb plugins init ./my-channel --template channel
```

| 模板 | 提供的起点 | 自带验证 |
| --- | --- | --- |
| `agent`（默认） | 领域 Adapter、只读工具、离线模型和领域验收 | 实际任务成功、报告包含指定内容、工具已有确认回执 |
| `application` | 有持久计数的应用，以及调用该应用的界面 handler | GET/POST 响应、相同 commandId 不重复计数、界面依赖调用 |
| `channel` | 本地事件拉取、发送回执、回执查询 | 游标不重复投递、重复发送返回同一回执、find 核对 |

每个模板生成四个文件：`plugin.json` 声明贡献，`index.mjs` 注册和实现，`plugin.test.json` 定义测试输入/断言，`README.md` 给出下一步操作。包代码没有 TNB 仓库内部导入，移出源码仓库仍可安装。目标目录须不存在；`init` 不覆盖已有项目。目录名不适合作为包名时使用 `--name my-plugin`。

## 修改后的检查循环

编辑 `index.mjs` 和测试期望，再运行：

```sh
tnb plugins validate . --json
tnb plugins test . --yes --json
```

`validate` 使用正式发现流程的同一清单解析器，检查 API/宿主兼容性、精确贡献身份、入口是否为包内文件、JavaScript 语法、default 导出和测试格式。只检查指定包，旁边的同名包不会覆盖结果。不 import、不运行 Hook/MCP、不安装、不授信。缺少测试文件时可以静态通过，但 `test` 要求至少一个场景。

`requirements.services` 和 `requirements.contributions` 列出需要宿主提供的服务和包外贡献。它们是接入要求，不代表已获授权或已验证。静态通过也不能证明 factory 会正确注册；真实 `test` 会检查注册和激活，并报告失败阶段。

`test --yes` 明确允许执行可信插件代码。它复制到临时插件目录，在临时 trust store 中只批准这次复制的包，用正式 `openAgentRuntime` 加载、执行场景、停止和清理。准备期间内容变动会拒绝。每次运行都是新状态；不会安装到个人目录、修改个人 settings、连接或重启已有 owner。

临时宿主不读取用户 settings 来提供模型配置、服务授权或伪造的服务对象。需要这些能力的插件，应使用 SDK 测试宿主显式提供服务、配置和 fixtures，参考[服务指南](plugin-services.md)和[宿主指南](host-plugins.md)。进程内插件仍可访问当前进程环境和用户文件，临时状态不等于沙箱；不合作的代码仍可能阻塞退出。模板本身不会调用外部业务服务。

两条验证命令均输出 JSON，`ok: false` 时退出码为 1，适合接入 CI。`test` 的 `checks` 按准备、激活、场景和关闭报告；输出不包含原始模型/工具响应。Windows 支持静态校验、应用和渠道试跑；Agent 任务试跑目前需要 macOS/Linux 的持久化屏障，不在 Windows 静默降级。

## 测试文件合同

`plugin.test.json` 使用 `version: 1`，允许 1–32 个顺序执行的场景，总文件不超过 64 KiB。场景共享同一次临时宿主，便于核对重复输入和状态延续；下一次命令重新创建状态。未知字段直接拒绝。

应用请求示例：

```json
{
  "version": 1,
  "scenarios": [{
    "kind": "request",
    "contribution": {"kind": "application", "id": "my-app", "version": "1"},
    "method": "GET",
    "path": "/status",
    "expect": {"status": 200, "json": {"ready": true, "visits": 0}}
  }]
}
```

请求支持 `GET`/`POST`、可选 JSON `body`，按精确 `status`、JSON 相等或 `textIncludes` 验证；请求直接派发到声明的贡献 handler，不启动浏览器 HTTP 服务。`task` 场景提供 `objective`、未固定插件身份的完整 `adapter` 描述及 `expect.reportIncludes`，可用 `expect.tools` 核对确认的工具回执。`channel` 场景提供渠道身份、`configuration`、`message` 和 `expect.receipt`；可选 `expect.events` 会验证首次 poll 数量和游标推进后的空结果。渠道场景要求可查询的重复发送回执，其他业务语义可用 SDK 自写测试。

这些是宿主接入冒烟测试，不承诺完整领域正确性、模型质量、网络可靠性或重启恢复覆盖。静态校验不解析整个 import 依赖闭包；依赖由作者打包到 `.mjs`，真实加载时继续校验。

## 验证通过后安装

```sh
tnb plugins install .
tnb plugins trust my-agent --yes
tnb plugins enable my-agent
tnb runtime restart
tnb runtime plugins
```

安装包和服务授权仍分别管理。Adapter 安装后可由 SDK 选择；当前默认 CLI 的任务入口仍是 Coding，安装不自动新增任意领域提交路由。应用/界面需要宿主请求入口，渠道需要显式配置 Source；下一步分别见[宿主接入与路由](host-plugins.md)和[协作来源](collaboration.md)。这种选择不会为了通过测试而修改宿主核心。
