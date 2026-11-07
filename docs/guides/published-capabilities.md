# 发布业务能力，供插件调用

TNB 把“安装一份可执行代码”和“允许业务调用这份能力”分开管理。参考 Stream Agent 的能力发布与调用授权，宿主发布不可变版本，业务插件只提交输入；目标、逻辑 namespace、资源、工具权限、模型选择和执行预算由发布者控制。

前提：已安装、信任并启用一个领域 Adapter。`tnb runtime adapters` 查看当前身份。本文的 `reply-agent` 可以由 `tnb plugins init ./reply-agent --name reply-agent` 创建，模板使用离线模型，不产生模型费用。按插件指南安装、信任并显式启动/重启 Owner。

## 1. 管理员发布

创建 `publish.json`：

```json
{
  "action": "publish",
  "definition": {
    "protocol": "tnb.capability/v1",
    "id": "support.reply", "version": "1",
    "namespace": "support",
    "objective": "读取获授权的消息，给出经过验证的答复",
    "adapter": { "id": "reply-agent", "version": "1" },
    "inputSchema": {
      "type": "object",
      "properties": { "message": { "type": "string", "minLength": 1 } },
      "required": ["message"], "additionalProperties": false
    },
    "resources": [{ "id": "support:message", "mode": "read" }],
    "grants": [{ "name": "read", "resources": ["support:message"], "mode": "read" }],
    "execution": { "mode": "single", "maxTurns": 50, "maxRetries": 1, "maxModelRequests": 256, "maxDurationMs": 3600000 }
  }
}
```

```sh
tnb runtime capabilities publish.json
tnb runtime capabilities list
```

把 action 改为 `check` 可以在发布前检查合同和当前 Adapter 元数据，不创建 worker、不调用模型。check 不执行 Adapter 的业务配置校验；实际输入仍要在提交时通过发布 Schema 与 Adapter 自身校验。

发布会固定当前插件 `name/version/fingerprint` 和合同摘要。相同 id/version 不能改定义或改代码身份，必须发布新版本。重复发布相同合同返回当前记录。新调用要求当前 Adapter 与固定身份一致；升级后旧发布会拒绝新建，不会自动切换代码。已经接纳的任务继续使用 TNB 原有的历史代码固定与恢复机制。

`execution` 还支持 `provider/model/compactThreshold/maxCostUsd`。未配置的数值遵循领域任务默认值；默认模式为 single，默认持续时间 24 小时，持续时间上限 30 天。provider/model 未固定时由 Adapter 决定；发布合同并不自动冻结外部模型服务本身。输入直接成为 Adapter 的 config；它不能覆盖目标、资源或 execution。Schema 使用 TNB 有界 JSON Schema 子集。定义最多 48 KiB，输入最多 48 KiB，完整 Adapter 描述仍须满足 64 KiB 上限。

业务服务不提供调限方法；Owner 管理员仍可使用既有 runtime limits 等运维命令调整已接纳 Run。发布合同约束业务调用方的准入，不限制宿主管理员的管理权限。

## 2. 先用 Owner 验证

创建 `request.json`：

```json
{
  "commandId": "ticket-123",
  "capability": { "id": "support.reply", "version": "1" },
  "input": { "message": "请分析这条工单" }
}
```

```sh
tnb runtime execute request.json
tnb runtime status <run-id>
tnb runtime result <run-id>
```

命令返回 runId、能力版本与发布摘要。重复同一个 commandId 和完全相同的业务请求返回原任务；改输入会冲突。所有这些命令要求显式启动 Owner，不隐式拉起服务。JSON 文件必须是普通 UTF-8 文件，最大 64 KiB；CLI 在访问 Owner 前先做结构校验。

## 3. 让业务插件接入

SDK 导出 `EXECUTION_SERVICE_REF`、`ExecutionService` 和 `CapabilityRequest` 等类型。进程 Application 示例在 [published-intake](../../examples/plugins/published-intake/README.md)，通过真实 JSON-RPC 使用与进程内插件相同的合同：

```ts
// 进程内 Application/Interface/Channel 的 ExtensionContext
const executions = context.service(EXECUTION_SERVICE_REF);
const receipt = await executions.submit(request);
const status = executions.status({ runId: receipt.runId });

// ProcessContext：JSON-only 参数与结果；可选字段省略，不能显式传 undefined。
const receipt = await context.call(EXECUTION_SERVICE_REF, "submit", [request]);
```

需要两层显式配置：

1. manifest 的贡献声明 `services: ["tnb.executions/v1"]`；宿主 settings.json 的 `pluginServices` 为该插件允许这个服务。例如 `{"pluginServices":{"published-intake":["tnb.executions/v1"]}}`。首次改变服务配置后重启 Owner。
2. 持久能力授权，精确绑定插件代码身份和贡献身份。`tnb runtime plugins` / `/extensions` 查看实际指纹与贡献，不要猜测指纹。

授权文件 `grant.json`：

```json
{
  "action": "grant", "commandId": "approve-intake-1", "expectedRevision": 0,
  "capability": { "id": "support.reply", "version": "1" },
  "consumer": {
    "plugin": { "name": "published-intake", "version": "0.1.0", "fingerprint": "替换成实际64位SHA256" },
    "contribution": { "kind": "application", "id": "published-intake", "version": "1" }
  },
  "enabled": true
}
```

```sh
tnb runtime capabilities grant.json
tnb runtime capabilities grants
```

`expectedRevision: 0` 表示新授权；更新/撤销必须带当前 revision 和新的 commandId。相同管理 commandId 精确重试返回原回执，换输入冲突。同一包内其他贡献不继承能力授权；代码指纹变化后必须重新批准。服务准入和业务能力授权分开，允许宿主独立管理插件能获得哪些接口，以及每个接口能执行哪些业务。

## 4. 状态、结果与停发

服务只有四个方法：

| 方法 | 合同 |
| --- | --- |
| catalog({after?,limit?}) | 当前贡献获授权的发布摘要，默认 16、最多 32 项；返回 next 时继续翻页 |
| submit(request) | 只接受 commandId、capability、input；返回原始创建回执的精简投影 |
| status({runId,after?,limit?}) | 当前 Run 状态/revision 与任务 ID、状态、是否已有正式结果；任务分页默认 32、最多 64 |
| result({runId,taskId,offset?,limit?}) | 正式接受结果的 JSON 文本分片；默认 8192、最多 16384 个 UTF-16 code unit，返回 next/total |

result 需要将 text 按顺序拼接后再 JSON.parse；不能把单片当成完整 JSON。UTF-16 游标用于无损拼接，不能改用 UTF-8 字节偏移。状态查询不返回原始配置、工具回执、运行时句柄或宿主凭据。需要用户决定的任务仍通过宿主现有 questions/answer/attention 流处理，本版服务没有将提问回答暴露给业务插件。进程边界沿用既有错误脱敏，未获授权等失败可能只表现为 `Host capability call rejected`；管理员可查询发布和授权记录诊断。

停发文件：

```json
{
  "action": "state", "commandId": "stop-new-reply-1", "expectedRevision": 1,
  "capability": { "id": "support.reply", "version": "1" }, "enabled": false
}
```

仍用 `tnb runtime capabilities state.json`。`enabled:false` 只拒绝新建；已获授权的精确业务重试仍能获得原回执，状态/结果继续可读。撤销 grant 后，该贡献的后续提交与读取均立即拒绝，包括旧回执；撤权不隐式取消后台任务。异步准备和结果 IO 后都会重新检查授权，最终建任务前在无 await 的边界重新检查。能力绑定、业务请求摘要和 Run 在同一事务内提交，不会出现任务已创建而所属业务尚未记录的空窗。

同一调用贡献的稳定幂等身份是插件名 + 贡献 kind/id/version，代码指纹用于当前授权校验。明确批准包升级后，原业务键仍返回原任务；贡献身份变化则是新的调用方。Owner 调用有独立幂等范围，不能冒充业务贡献。终态任务被管理员显式 prune 后，保留的命令身份会阻止同业务键重新执行，结果证据不可用会明确报错。

管理 API 为认证的 `POST /capabilities/command` 和 `POST /capabilities/execute`。command 还支持 `{"action":"get","capability":{"id":"support.reply","version":"1"}}`、`{"action":"list","after":"…","limit":16}` 和 grants 分页。管理列表 next 是不透明游标。Owner 私有 socket + control key 仍是管理员能力，不能分发给普通业务客户端。namespace 是逻辑隔离，不是多租户身份；本阶段没有业务 API Key、消费 ACK 或跨机器执行桥接。

发布配置、授权和 Run 绑定随 SQLite 状态备份，但发布不是代码部署仓库。未产生 Run 的发布不额外保留旧插件包；恢复后调用前仍须确保发布固定的包已安装、可信且为当前版本。需要长期部署旧发布时自行保管对应安装包，不能只备份发布 JSON。
