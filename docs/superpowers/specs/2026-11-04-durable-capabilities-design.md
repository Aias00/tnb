# 持久 Coding 任务的 skills 与 MCP 能力契约

## 问题与目标

普通对话通过 `loadSkills`、`createSkillTool`、`connectMcpServers` 加载能力；持久 Coding worker 原先只组装文件与 Shell 工具，并在健康接口声明 `skills:false,mcp:false`。把对话的工具数组直接复制给后台任务，会把 hooks、独立模型调用、交互授权和可变 MCP 目录一起带过去，绕过持久任务的预算与恢复约束。

本轮只补齐持久 Coding 插件的能力装配。执行内核仍负责状态、日志、预算、压缩与恢复；Coding 插件负责选择、资源声明、配置 pin 和工具装配。应用、界面、渠道仍走现有插件宿主。本轮不实现 Web 工作台。

## 提交与授权

- 默认能力不变；`skills`、`mcpTools` 是显式选择。
- `tnb runtime submit`、`/runtime submit`、`/task` 接受重复的 `--skill NAME`、`--mcp-tool EXPOSED_NAME`；自然语言交接工具增加相同字段，继续要求原有授权。
- Coding adapter 的 normalize 在创建 Run 前加载目录，校验选择，生成 `capabilityPins`。已带 pin 的输入必须匹配当前配置。相同提交命令和未变化的配置仍得到相同 Run；配置漂移时拒绝重试，不生成新授权。
- skill 声明独立的 `skill.read` 资源；每个 MCP 工具声明独立的 `mcp.call` 写资源。MCP 外部权限与 workspace 写权限分别授予。
- MCP 还必须出现在宿主配置目录的 `durable-mcp.json` 中。任务只能选择宿主允许的精确工具，不能通过文本、followup、answer 或子 Agent 增权。

## Skills

复用现有解析器和优先级：用户、项目、激活且受信任的插件、内置。指令型 skill 通过 `skill` 工具按需暴露；支持资源通过 `skill_resource` 读取 worker 内存中的不可变副本，不开放对宿主配置目录的普通文件读取。

显式 `context:fork`、agent、非继承 model、effort、hooks 以及禁止模型调用的 skill 拒绝进入持久任务。没有执行元数据的 skill 在此次显式选择中按指令模式加载；这与普通对话默认可能另起调用的语义不同，必须在使用文档说明。`allowed-tools` 对整个任务的业务工具取交集，不能给任务授予新工具；运行时控制、完成报告和资源读取能力保留。不存在绕过预算的嵌套模型调用。

pin 覆盖解析结果、来源、路径及支持文件内容摘要。单 skill 最多 128 个资源，总指令/资源最多 1 MiB；每类最多选择 16 个，合计最多 24 个。文本资源必须是 UTF-8。资源按精确名称访问，拒绝目录穿越。SKILL.md 和实际收录的资源要求普通文件，资源不能通过符号链接跳出目录；加载器原本忽略的符号链接资源不会暴露。

资源副本只在 worker 生命周期内存在。数据库保存摘要而非整个目录；重启需要原目录仍存在且匹配。skill 返回结果走已有工具日志、transcript 和上下文预算/压缩/archive recall。

## MCP

复用现有 MCP 配置、激活插件贡献、连接与工具实现。仅连接所选工具对应的服务器；服务器其他工具、资源和 prompts 不暴露给模型。客户端不提供 sampling 或 elicitation 回调，模型调用不能绕过账本；OAuth 复用已有非交互凭据/刷新流程，需要人工登录时返回现有认证错误。

宿主白名单按原始 server/tool 名生成现有稳定的 `mcp__...` 名称并检查冲突。默认 `replay:never`；只有宿主能显式声明 `safe`，服务端 annotations 不参与授权或重放判断。`safe` 不等于只读，MCP 工具的 access 保持 unknown，资源按写模式管理。

提交时 pin 选择的服务器配置、显式 replay 策略及 stdio 基础环境的摘要。展开后的 URL、headers、env 不复制进 Run 配置；配置变化（包括显式凭据变化）会阻止原任务继续。OAuth 动态 token 轮换不复制进 pin。stdio 默认继承环境改为 PATH/HOME/TMPDIR/LANG，另加服务器显式 env；这一行为只用于持久 worker。stdio MCP 是宿主信任的进程，不受 Coding Shell 的原生沙箱隔离，HOME 也不是沙箱。

第一次 worker admission 保存实际工具 schema、description、effects 的执行 binding；重新 admission 必须匹配。工具目录不是在提交时联网冻结，首次 admission 前服务器目录变化会采用首次实际目录。worker 固定一次工具数组，list_changed 或连接 revision 变化阻止后续使用原工具。服务器内部实现、远程数据和同一命令路径上的二进制内容不在此校验范围；配置/schema 摘要不是远程服务行为证明。

调用仍经过权限 checker 与 durable journal。deny/ask 优先；没有后台交互提示的 ask 会拒绝。调用成功持久化结果；连接断开或其他失败按默认 unsafe 策略标记 unknown，暂停并要求核对。已记录成功结果不重放；缺失确认的 unsafe 调用在恢复后也不重新发出。

连接初始化和 worker 生命周期支持 AbortSignal，失败与关闭时回收客户端。每次 worker admission 独立连接，不引入全局后台池。

## 子任务与验收

Coding 子任务显式覆盖 `skills:[],mcpTools:[],capabilityPins:{}`，避免运行时合并父配置时意外继承。子任务仍只获得现有只读 workspace 能力。

原有 Coding 验收维持文件快照、报告与显式 checks。MCP 调用日志能证明调用及确认结果，不证明外部业务目标完成；需要额外业务验收的场景应由对应 domain adapter 实现，不能把一次 MCP 成功响应当成任意业务验收。

## 验证

使用临时目录、脚本模型和本地 stdio fixture 验证真实工具调用、重启、问题恢复、未知副作用、目录/配置漂移、凭据不落 Run、环境收缩、allowed-tools 与 deny 优先级、子任务收权、初始化取消。补充 CLI/slash/自然语言字段传递测试，并回归插件打包与默认执行路径。不会连接实际外部 MCP 或付费模型。
