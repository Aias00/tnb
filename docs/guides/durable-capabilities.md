# 长任务使用 skills 与 MCP

长任务默认使用原有文件工具。可以在提交时明确选择 skills 和 MCP 工具；暂停、追加要求和回答问题不能给已存在的任务增加工具。

## 使用 skill

例如在项目 `.tnb/skills/inspect/SKILL.md` 中写：

```markdown
---
name: inspect
description: 检查实现与测试证据
context: inline
allowed-tools: [read, glob, grep]
---
先阅读实现，再核对测试和遗漏的恢复场景。
```

```sh
tnb runtime submit "检查当前项目的任务恢复机制" --skill inspect
```

对话内也可以：

```text
/task "检查当前项目的任务恢复机制" --skill inspect
```

复用普通对话的用户、项目、已激活且受信任的插件和内置 skill 目录。任务只暴露所选 skill；模型调用 `skill` 获取指令，使用 `skill_resource` 按精确路径读取附带的文本资源。资源读取不会开放整个用户配置目录。

本轮支持指令模式。未声明执行模式的 skill 在长任务中也按指令模式处理；显式 fork、独立 agent/model/effort/hooks 不支持，会在提交时拒绝。`allowed-tools` 收缩整个任务的业务工具，多 skill 取交集；不会自动获得其中列出的工具。控制工具和 skill 资源工具仍可用。含有上述执行元数据的内置 skill 也会被拒绝，可另建适合长任务的指令型 skill。

## 使用 MCP

先在 TNB 配置目录的 `mcp.json` 配置服务器，和普通对话使用同一格式。再添加 `durable-mcp.json`：

```json
{
  "tools": [
    { "server": "docs", "tool": "search", "replay": "safe" },
    { "server": "issues", "tool": "create_issue" }
  ]
}
```

只有你确认查询可安全重复时，才把它声明为 `safe`。省略时默认 `never`；服务端声称只读不会改变这个策略。MCP 的外部权限单独选择，与工作区写权限分开。

```sh
tnb runtime submit "查找相关 API 文档" --mcp-tool mcp__docs__search
```

```text
/task "查找相关 API 文档" --skill inspect --mcp-tool mcp__docs__search
```

可以重复传入两个选项。注意示例 skill 的 allowed-tools 没有包含 MCP；若要同时调用搜索，请把 `mcp__docs__search` 加进该 skill 的 allowed-tools。

自然语言交接仍通过需要授权的 `durable_task`，新增 `skills:["inspect"]` 和 `mcpTools:["mcp__docs__search"]`。模型只能在用户明确同意的范围内选择；宿主白名单仍是必要条件。普通对话临时传入的 `--mcp-config` 不会复制到后台服务，持久任务使用服务宿主的配置。

长工具名沿用现有 64 字符截断加 hash 规则。白名单中的 server/tool 使用服务器原始名称，命令选项使用模型可见的最终名称。

## 重启与配置变更

提交时记录 skill 内容/资源、MCP 配置和白名单策略的摘要；首次执行时再固定实际 MCP schema 和描述。后续重启、重试、验收都重新校验。配置或内容不匹配时任务停止推进，恢复原配置或创建新 Run；不会自动升级正在运行的任务。

成功调用的持久结果在恢复时复用。结果未知的非安全调用会进入 `unknown-effects` 暂停状态，通过现有 `runtime status/events` 查看 operation，并核对外部实际结果后用 `runtime reconcile` 提供证据；该命令不重新调用原工具。

MCP stdio 服务器属于宿主信任的进程，不在 Coding Shell 沙箱内。它只自动继承 PATH/HOME/TMPDIR/LANG 和服务器显式配置的 env；需要的 MCP 凭据应显式配置。环境、URL 和 headers 只保存摘要到任务配置，但服务端主动返回的内容仍会进入工具结果与 transcript，不能保证服务响应中没有秘密。

子 Agent 不继承这些额外能力。skill 资源要求恢复时仍在原路径并保持内容一致，每个 skill 最多 1 MiB/128 个资源；二进制资源暂不支持读取。MCP sampling、交互 elicitation 和 prompts 暂不接入持久 worker；OAuth 需事先通过 `tnb mcp auth` 完成登录。

平台范围：持久 owner 服务及 workspace coordinator 当前使用 POSIX 目录所有权与 Unix socket，本轮完整服务验证覆盖 macOS/Linux。Windows 验证能力装配、真实 stdio MCP、权限与目录冻结等便携路径；不代表 Windows 已支持完整持久后台服务。
