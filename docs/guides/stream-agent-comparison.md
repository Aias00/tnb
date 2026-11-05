# TNB 与 Stream Agent 的定位和边界

依据 `/Volumes/data/stream-agent` 当前工作区（HEAD `06f9256`，包含本地改动）及本轮 TNB 插件宿主源码。仅做只读分析，没有修改 Stream Agent 的工作区。本比较关注已实现机制，不把 README 的未来目标当成现成能力。

## 共同方向

两者都向通用 Agent 执行平台演进：业务接入与执行内核分离，模型、工具、任务、预算、取消和恢复由平台负责。新增业务复用执行能力，而不是每个业务再写一套 AgentLoop。

源码依据：Stream Agent 的 `domain/access/ApiTasks.java` 明确是原持久执行引擎上的认证门面；`domain/execution/AgentRuntime.java` 将模型/工具对话与 Worker 的租约、fencing、预算和持久输出分开。TNB 的 `engine-core.ts` 持有执行状态，领域适配器提供业务资源、工具和验收，应用/交互/渠道通过插件宿主接入。

## 相似定位下的不同实现

| 维度 | Stream Agent 当前实现 | TNB 当前实现 |
| --- | --- | --- |
| 主要形态 | Java/Spring 服务，可按 Gateway、Runtime、Worker 角色部署 | 本地可嵌入 Bun runtime，终端客户端和可选常驻宿主 |
| 业务接入 | 独立业务后端调用应用任务 API，带能力版本和业务身份 | 已信任插件包提供领域、应用、交互、渠道；默认产品 profile 组合它们 |
| 扩展装配 | 可信 Spring Bean SPI、部署白名单和声明式处理器 plan | 可安装 .mjs 包、manifest 注册、信任指纹、私有快照和固定代际 |
| 契约 | 发布能力冻结 Agent、输入/输出 Schema、模型及执行配置 | 领域 descriptor 固定资源/授权/验收；插件 manifest 固定贡献和服务/依赖；没有同等的业务能力发布目录 |
| 数据治理 | 应用凭据、业务租户/主体及配额、SQL 权威状态、流式重放 | 同一配置目录的 owner、SQLite、工作区权限、预算和回执；尚不是多租户服务中台 |
| 典型侧重 | 为多个独立业务提供统一执行与流式交付 | 本地工作区执行、Coding 工具/原生沙箱、持久任务及应用组合 |

Stream Agent 不是“目前已经有一套与 TNB 相同的动态插件市场”。它的 `LifecycleProcessor.java` 提供 ContextContributor、ModelWrapper、ToolPolicy、ResultAcceptance，主要通过可信部署代码和配置扩展。其约束尤其值得保留：处理器不能扩大授权、改写任务状态或自行接管重试；共享实例的可变状态必须放在每次调用中。

Stream Agent 也存在通用执行与具体实现的差别：`AgentRuntime.NATIVE_DESCRIPTOR` 明确 interaction/checkpoint/handoff 为 false，`NativeAgentRuntime` 每轮复核 ExecutionContext 的 epoch、取消和期限。不能因平台有持久 WorkItem/人工节点，就推断原生模型循环已经具备任意 checkpoint 恢复。

## 业务适配不必全部进入 Agent 进程

Stream Agent 的 `examples/repo-triage` 是独立 Python 业务服务：GitHub 收集、Review 发布和业务回执由适配器负责；中台接收标准 WorkItem/Input/Task。业务写凭据留在业务侧。它证明“不同业务共用中台”可以通过标准 API 实现，而不要求把业务后端动态加载到 Worker。

TNB 应同时容纳两种形式：

- 已信任、需要直接访问本地资源的能力，作为领域/应用/渠道插件部署。
- 有自己的数据、发布节奏和账号体系的业务，作为独立服务通过明确的任务协议接入；适配器也可封装为插件，但不强制整个业务系统进入宿主进程。

插件负责扩展机制，业务 API 负责跨进程接入；它们不是同一层协议。插件包版本、领域 adapter 版本与可发布业务能力版本也不能混为一谈。

## 对 TNB 当前改造的判断

本轮统一插件宿主方向合理，不需要为了“更像中台”立即引入 Java、Redis/Kafka 或重做执行内核。当前先把安装/信任、注册原子性、依赖、生命周期、服务边界和持久恢复做实，协作应用及渠道迁出直接装配，给后续网页入口提供基础。

进入更多业务前应补充的下一层是标准业务调用合同：输入/结果 Schema、能力选择、执行配置与授权冻结、稳定命令身份、验收和回执、业务关联 ID，以及按接入方限定可用资源。原 tnb.runtime.internal/v1 高权限兼容桥已从默认宿主移除；协作应用改用 tnb.collaboration/v1，网页使用 tnb.tasks/v1，按来源/工作目录和任务归属限定能力。普通业务应使用窄命令服务，不能重新暴露整个 Runtime。正式多租户中台还需要独立实现身份、租户、配额和审计，安装插件本身不提供这些保证。

两项目可以共享契约和经验，暂时保持各自职责。如果以后让 Stream Agent 调用 TNB 作为 Coding 执行器，应明确父业务任务与本地 Run 的关联、状态所有权、取消/fencing、预算归属和结果回执；同一业务实体不能由两边各维护一套互相覆盖的终态，也不能对同一次模型请求重复计量。这个远程执行集成尚未实现。

## 主要源码定位

Stream Agent：`src/main/java/org/streamagent/domain/access/ApiTasks.java`、`ApiAccess.java`、`domain/execution/AgentRuntime.java`、`ExecutionContext.java`、`LifecycleProcessor.java`、`worker/execution/NativeAgentRuntime.java`、`worker/tools/ToolRegistry.java`、`examples/repo-triage/triage.py`。

TNB：`src/agent/plugins.ts`、`extension-host.ts`、`extensions.ts`、`src/services/runtime/engine-core.ts`、`src/profiles/default.ts`、`src/plugins/collaboration/plugin.ts`。
