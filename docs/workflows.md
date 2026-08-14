# Workflows

`workflow` 现在既支持原来的内联 DAG 执行，也支持可持久化的命名定义和运行状态。

## Storage

Workflow 状态按项目隔离，存储在：

```text
~/.tnb/projects/<project-hash>/workflows/
├── definitions/<name>.json
└── runs/<run-id>.json
```

定义文件保存参数声明和模板步骤；运行文件保存参数实参、展开后的步骤、每步输出、失败信息，以及暂停/完成状态。

## Backward Compatibility

老的调用仍然有效：

```json
{
  "steps": [
    {
      "id": "inspect",
      "description": "inspect code",
      "prompt": "Inspect the provider implementation."
    }
  ]
}
```

这种输入仍然直接执行，并继续返回旧的 `{ status, steps }` 结果格式。

## Definition Actions

保存命名 workflow：

```json
{
  "action": "save_definition",
  "name": "provider-fix",
  "description": "Inspect, patch, and verify provider issues.",
  "parameters": [
    {
      "name": "target_file",
      "description": "Provider file to inspect",
      "required": true
    }
  ],
  "steps": [
    {
      "id": "inspect",
      "description": "inspect {{target_file}}",
      "prompt": "Inspect {{target_file}} and report concrete issues.",
      "agent_type": "explore"
    },
    {
      "id": "implement",
      "description": "implement fixes",
      "prompt": "Implement the confirmed fixes for {{target_file}}.",
      "depends_on": ["inspect"]
    }
  ]
}
```

发现和读取定义：

```json
{ "action": "list_definitions" }
{ "action": "get_definition", "name": "provider-fix" }
{ "action": "delete_definition", "name": "provider-fix" }
```

参数使用 `{{param_name}}` 模板展开，支持 `description`、`prompt`、`agent_type`、`id`、`depends_on`。定义里的 `parameters[].default` 会在运行时自动补全。

## Run Actions

从命名定义启动：

```json
{
  "action": "run",
  "name": "provider-fix",
  "params": {
    "target_file": "src/providers/openai.ts"
  }
}
```

从内联步骤启动并持久化 run：

```json
{
  "action": "run",
  "description": "one-off triage",
  "steps": [
    {
      "id": "inspect",
      "description": "inspect repo",
      "prompt": "Inspect the repo and summarize the bug."
    }
  ]
}
```

查询与发现运行：

```json
{ "action": "list_runs" }
{ "action": "get_run", "run_id": "workflow-abc123" }
```

## Pause / Resume / Rerun

`workflow` run 会在每个 batch 后把状态落盘。支持三种控制方式：

1. 协作式暂停当前调用：

```json
{
  "action": "run",
  "name": "provider-fix",
  "params": { "target_file": "src/providers/openai.ts" },
  "pause_after_step_count": 1
}
```

2. 暂停已存在的 run：

```json
{ "action": "pause_run", "run_id": "workflow-abc123" }
```

如果该 run 当前没有执行中的进程，会立即变成 `paused`；如果执行中的进程稍后恢复到调度循环，会读到 `pause_requested` 并在下一批之前停下。

3. 恢复或重跑：

```json
{ "action": "resume_run", "run_id": "workflow-abc123" }
{ "action": "rerun_run", "run_id": "workflow-abc123" }
{ "action": "rerun_run", "run_id": "workflow-abc123", "use_latest_definition": true }
```

`resume_run` 继续未完成步骤；`rerun_run` 会创建新的 run，并默认复用原 run 的参数和定义快照。`use_latest_definition: true` 会在原 run 绑定命名定义时，先重新加载最新定义。

## Status Semantics

Run 状态：

- `running`: 当前调用正在推进步骤
- `paused`: 还存在 `pending` 步骤，但本次执行已停下
- `completed`: 所有步骤都完成
- `completed_with_errors`: 至少一个步骤失败或因依赖失败而跳过

Step 状态：

- `pending`
- `running`
- `completed`
- `failed`
- `skipped`

如果进程在执行期间退出，恢复读取 run 时会把整体状态归一到 `paused`，并把残留的 `running` step 回滚成 `pending`，同时记录恢复错误信息，避免把半执行状态误判成完成。
