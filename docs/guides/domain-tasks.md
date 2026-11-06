# 在 TNB 中运行业务 Agent 插件

安装 Adapter 后，可以直接选择它提交持久任务，不需要自建 SDK 宿主。普通 `runtime submit` 和 Web 首页继续使用 Coding；`--adapter` 是用户明确选择业务及其能力的入口，不自动为模型授予新工具、服务或凭据。

## 从模板到实际运行

```sh
tnb plugins init ./my-agent --template agent
tnb plugins validate ./my-agent
tnb plugins test ./my-agent --yes
tnb plugins install ./my-agent
tnb plugins trust my-agent --yes
tnb plugins enable my-agent
tnb runtime restart
tnb runtime adapters
tnb runtime submit "读取授权消息并给出报告" \
  --adapter ./my-agent/task.json --namespace demo --mode single
```

模板使用离线脚本模型，验收真实工具回执，无需 API Key。它验证宿主接入与恢复，不代表生产模型能力。TypeScript 项目使用 `--language typescript` 创建并执行 `bun run check`，安装 `package/`，提交时选择 `package/task.json`。构建会复制任务描述，部署时不需要源码或 node_modules。

`runtime adapters` 读取正在运行的 Owner，展示 ID、贡献版本、包身份/指纹和可选 `configurationSchema`。`defineAgent` 会提供该 Schema；旧 Adapter 可以省略。`submission: domain` 表示领域入口；`host` 表示已有 Coding/宿主入口，使用其专用提交方式。清单不包含仅为恢复保留的旧代际，也不执行验收或测试模型。

安装、启用、信任与运行是分别进行的。Owner 代码和注册在生命周期内固定；安装新包后需显式重启，已有任务继续固定原代码。旧 Owner 不支持这些接口时会要求升级/重启，客户端不会把业务任务改成 Coding 提交。

## 任务描述与权限

`--adapter` 指向纯 JSON 描述，不是 `.mjs` 实现入口：

```json
{
  "id": "my-agent",
  "version": "1",
  "config": { "message": "Hello from my plugin" },
  "resources": [{ "id": "my-agent/message", "mode": "read" }],
  "grants": [{ "name": "read", "mode": "read", "resources": ["my-agent/message"] }]
}
```

描述最多 64 KiB，配置必须通过领域校验，能力不能超出资源声明。默认不写插件身份，由 Owner 固定当前可信包；显式指定旧指纹不能让新任务切回历史代码。路径相对 CLI 当前目录或当前对话工作目录。

领域提交不接受 `--cwd`、`--allow-write`、`--allow-shell`、`--check`、`--allow-workspace`、`--skill`、`--mcp-tool` 等 Coding 参数，业务工具通过资源/能力合同提供。宿主策略也不能把此入口的逻辑命名空间改为目录或启用 Coding 权限。

可选执行参数：`--mode single|auto|multi`、`--max-turns`（1–2000）、`--max-retries`（0–10）、`--max-model-requests`（4–10000）、`--compact-threshold`（至少 1000）、`--max-budget-usd`、`--deadline`、`--provider`、`--model`、`--command-id`、`--no-start`。模型选择只是传给插件的执行配置；插件仍需提供正确模型传输和费用路由。费用上限不能替未知价格的模型提供计费保证。

CLI 在拉起 Owner 前校验文件、选项和静态能力结构；服务端再次校验，复用现有运行时的限额、代码固定、工具授权、日志、等待、上下文和领域验收。任务被接纳不代表已完成，结果仍须读取。

## 管理命名空间内的任务

```sh
tnb runtime list --namespace demo
tnb runtime status <run-id>
tnb runtime result <run-id>
tnb runtime questions <run-id>
tnb runtime answer <run-id> --question <wait-id> --answer yes --version <N>
tnb runtime pause <run-id>
tnb runtime followup <run-id> --namespace demo --text "补充验收要求"
tnb runtime routing --namespace demo --pending
tnb runtime resume <run-id>
```

命名空间是逻辑业务范围，与文件目录互斥。`status/result/events/questions/pause/resume/cancel` 使用显式 Run ID；`list/followup/routing` 可用 `--namespace` 选择范围。跨范围的追加不会写入目标 Run，路由结果会明确返回 `rejected`；追加和澄清结果应按 JSON 的 `status` 判断。

对话中使用同一套入口：

```text
/runtime adapters
/runtime submit "读取授权消息" --adapter ./my-agent/task.json --namespace demo --mode single
/task list --namespace demo
/task status --namespace demo
/runtime followup <run-id> --namespace demo --text "补充要求"
```

`/task` 是 `/longtask` 别名。省略 Run ID 的控制从明确命名空间选择本会话最新任务，再选择该范围最新任务；不传命名空间时保持原文件工作区行为。跨命名空间控制请用明确 Run ID。

断连后使用原输入与相同 `--command-id` 重试。回执是创建时快照，当前状态用 `status` 读取。已接纳任务的精确重试可返回原回执，即使插件后来升级或停用；不会重新执行。新任务仍要求当前已启用的可信实现。Owner 重启后，未决问题、等待和执行结果继续使用既有持久恢复协议。

## 客户端协议与当前范围

认证的 `GET /adapters` 返回当前目录；`POST /agent-tasks` 接受公开 `AgentTaskInput`（`commandId/objective/namespace/adapter` 及可选执行限制），返回 Run/Tasks 接纳回执。`/health.capabilities.domainCatalog/domainSubmission` 用于协商，仍使用宿主私有 socket 和控制凭据，不是开放公网 API。

命名空间内部对应 `agent:<namespace>`。已有 `/runs`、`/presentation`、`/routing` 和 `/attention` 可按该逻辑范围读取；通知流重连会重新提供待决问题和任务快照。默认终端/Web Coding 工作台尚未提供业务命名空间切换，新的业务界面需要显式订阅对应范围，不能宣称所有界面已经自动展示业务任务。

macOS/Linux 验证实际产品服务、编译 CLI 自动启动 Owner、任务执行及恢复。Windows 验证生成、类型、解析和权限拒绝；Agent 完整执行仍需要当前 POSIX 产物持久化屏障，不在 Windows 静默降低保证。
