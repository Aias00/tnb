# TNB 插件规范的源码比较与设计取舍

TNB 的插件规范需要同时约束包交付、宿主扩展和持久任务恢复。当前优先事项是让已有扩展遵守一致的授权与生命周期规则，再完善服务装配、业务目录和状态迁移。新增字段必须对应执行语义、错误行为和自动化验收，不能仅由清单解析器接受。

配套的 [插件规范草案](superpowers/specs/2026-11-05-plugin-specification.md) 将这些取舍转化为要求与验收项目。草案定义后续目标，当前实现仍以各使用指南为准。

## 比较范围

| 项目 | 依据 | 重点 |
| --- | --- | --- |
| TNB | `512816252f42f31378bbbbd04faedba74ad6d33a` | 注册、信任、工具执行、服务、历史包和来源绑定 |
| Pi | 本地 `16f5f0af4d85ca583d045ceb5ed6d646fcaf7761` | 交互扩展 API、注册事务、资源发现和上下文失效 |
| DeepSeek Harness | 本地 `687f282e8625c6b8d11ff58211a90524be2e4317` | Cordis 作用域、组合、代际引用和故障诊断 |
| OpenCode | `893e8dc43f05e872d4cac603486ce8a7181170fa` 的开发分支源码 | 分端入口、分域 API、作用域注册和实验能力 |
| VS Code | `4d2fba6576fd008ecfcc06a93378d004460c2473` 的源码及官方文档 | 声明式贡献、激活原因、API 兼容和运行位置 |
| Backstage | `8714768d116c33192cd8794c7ce76fc1aa906824` 的源码及官方文档 | 类型化服务引用、服务作用域、扩展点和模块 |
| Stream Agent | 本地 HEAD `06f9256a511779e01fa3160adc6dbcf4022e0b7e` | 可信 SPI、冻结工具契约、执行时复验和状态所有权 |

Stream Agent 工作区有其他未提交改动；本文依据的 `LifecycleProcessor.java`、`ExecutionContext.java`、`ToolRegistry.java`、`ExecutionDefinitions.java` 未在工作区修改。Spring SPI、动态插件包和跨进程业务 API 属于不同扩展机制，不能直接视为同一种插件体系。本文没有将上述框架引入 TNB 的依赖。

## Pi 适合参考交互接口和注册事务

Pi 的 [ExtensionAPI](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/extensions/types.ts) 分别提供工具、命令、快捷键、Flag、渲染器和事件接口。扩展开发者面对明确的扩展点，不必修改交互入口。其 [loader](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/extensions/loader.ts) 在初始化期间暂存运行时修改和订阅，成功后 commit，失败则 discard；运行时 invalidate 会使旧上下文失效并清理订阅。

TNB 已有注册暂存和失败清理，应继续采用，并补齐交互侧的标准 SDK。新 SDK 应返回可释放的注册句柄，注册属于具体插件代际或会话，不能把旧上下文长期保存在全局变量中。

Pi 的 [ResourceLoader](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/resource-loader.ts) 还允许第三方工具、命令或 Flag 替换标记为 replaceable 的内置扩展。TNB 不应把这种便捷替换直接用于已持久化的任务实现。同名冲突、内置替换和历史解析必须分别定义；旧任务继续解析原指纹。

## DeepSeek Harness 适合参考作用域和组合诊断

DSH 的 [scope](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/scope/src/index.ts) 给注册分配作用域，清理需等待 Fiber 的异步退出。其 [AgentPresetRegistry](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/preset/agent-preset-registry/src/index.ts) 为组合保存 generation、users 和 retired；代际退休且无人引用时才释放，并保留 broken 诊断。

TNB 应将资源所有权明确到宿主、插件代际、Run 和调用，依赖图同时承担启动顺序、失败传播和逆序退出的依据。运行清单应能解释某项贡献为什么不能启动，以及哪个引用阻止旧包释放。

DSH 的这些用户计数主要管理活跃作用域。TNB 的 SQLite Run、终态证据和 Source 绑定跨进程存在，不能仅用内存引用数替代。即便热更新时旧实例已无人调用，仍可能有持久任务需要其字节。当前保留“重启后精确恢复”和“历史渠道依赖拒绝”的限制，比直接引入动态重组更适合现阶段。

## OpenCode 适合参考分端入口和分域接口

OpenCode 当前开发分支的 [入口解析器](https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/plugin/src/host.ts) 区分 server、tui、rpc 和 gui，GUI 入口明确使用实验名称。其 [插件 Context](https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/plugin/src/effect/plugin.ts) 按工具、会话、命令等领域组织 API；[Hook 注册器](https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/core/src/plugin/hooks.ts) 使用作用域 finalizer 删除回调，并为不同事件声明错误通道。

TNB 应允许一个包交付不同运行位置的贡献，服务端启动不导入界面代码，渲染器也不取得执行宿主凭据。稳定 API 与实验 API 应分开，实验接口不能成为持久恢复所依赖的默认合同。

OpenCode 的 [模块加载器](https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/core/src/plugin/module.ts) 支持 npm 安装、源文件观察和旧式入口。TNB 不采用在任务恢复过程中自动安装新依赖、跟随源文件变化更换实现的行为。交互开发的便利性不能决定持久任务的版本选择。官网的 [插件介绍](https://opencode.ai/docs/plugins/) 展示 hooks 对象式接口；本比较涉及作用域和分端入口的结论依据上述固定开发分支源码，不把两种接口混写成同一版本。

## VS Code 适合参考声明与激活的分离

VS Code 的 [清单](https://code.visualstudio.com/api/references/extension-manifest) 区分包版本、宿主兼容范围、贡献和入口，[激活声明](https://code.visualstudio.com/api/references/activation-events) 则决定何时需要运行代码。对应 [ExtensionsActivator](https://github.com/microsoft/vscode/blob/4d2fba6576fd008ecfcc06a93378d004460c2473/src/vs/workbench/api/common/extHostExtensionActivator.ts) 复用激活操作、处理依赖，并保存激活原因和失败结果。

TNB 应允许只读清单建立目录和诊断，实际使用时再激活所需贡献；`lazy` 必须说明延迟的是 import、factory、贡献 start 还是连接建立。已经安装或清单标为启用，不等于代码已启动。按需激活只能改变资源使用时机，不能改变信任要求。

VS Code 的 [Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host) 区分本地、远端与 Web 运行位置，[Proposed API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api) 单独管理不稳定接口。TNB 可以采用位置声明和实验接口分离，但不能据此声称每个插件都有独立进程或安全沙箱；进程拓扑、操作系统约束和能力授权必须分别记录。

## Backstage 适合参考服务和扩展点的区分

Backstage 的 [ServiceRef](https://github.com/backstage/backstage/blob/8714768d116c33192cd8794c7ce76fc1aa906824/packages/backend-plugin-api/src/services/system/types.ts) 同时承载服务标识、类型和 root/plugin 作用域。[ServiceRegistry](https://github.com/backstage/backstage/blob/8714768d116c33192cd8794c7ce76fc1aa906824/packages/backend-app-api/src/wiring/ServiceRegistry.ts) 检查重复、缺失、循环依赖，并禁止 root 服务依赖 plugin 作用域服务。类型化引用提升编译期约束；包解析和跨进程输入仍需运行时校验。

Backstage 的 [扩展点](https://backstage.io/docs/backend-system/architecture/extension-points/) 用于模块扩展所属插件，独立于共享服务；[插件注册](https://github.com/backstage/backstage/blob/8714768d116c33192cd8794c7ce76fc1aa906824/packages/backend-plugin-api/src/wiring/createBackendPlugin.ts) 也将 register 与 init 分开。TNB 应分别定义服务引用、服务实现和插件扩展点，避免一个任意 `service<T>(string)` 同时承担这些职责。

Backstage 的 [架构](https://backstage.io/docs/backend-system/architecture/index/) 规定独立插件通过网络通信，模块则经所属插件的扩展点通信。TNB 当前是本地可信插件宿主，不需要照搬所有插件服务化；应采用清晰的 API 包和部署装配规则，同时保留本地低开销调用。[生命周期服务](https://backstage.io/docs/backend-system/core-services/lifecycle/) 的资源清理机制可以参考，但 TNB 仍需另外定义退出期限与未知外部结果。

## Stream Agent 适合参考业务权限和执行所有权

`LifecycleProcessor.java` 明确处理器是可信部署 SPI，不能扩大权限、改写持久任务状态或自行拥有重试。共享实例必须把请求状态保留在本次调用中；ToolPolicy 和 ResultAcceptance 只提供额外拒绝，不能绕过平台校验。`ExecutionContext.java` 将身份、执行 epoch、取消、期限和复验函数显式传入。

`ToolRegistry.java` 将输入/输出 Schema 和工具版本组合为契约摘要，冻结目录与当前注册及授权不一致时拒绝执行；`requireCurrent` 在派发和读取已记录结果前复验。`ExecutionDefinitions.java` 则将业务发布和冻结叶子能力分开。源码位于 `src/main/java/org/streamagent/domain/execution/`、`worker/tools/`、`domain/access/`。定位与部署差异见 [原比较](guides/stream-agent-comparison.md)。

TNB 应采用“固定原业务合同，同时检查当前权限”的原则。插件包不是授权单位的全部；应用、资源、Run、调用和外部账户也需要归属。新插件、新 Skill 或新工具不会自动进入已准入任务，调用中变更后的参数也必须在实际执行前重新校验。

## MCP 提供协议而不替代宿主规则

MCP 的 [2025-11-25 工具协议](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) 定义发现、调用、Schema 和目录变化通知，并要求客户端在来源不可信时把工具 annotations 视为不可信。TNB 应将 MCP 当成工具来源，由宿主补充权限、预算、目录固定和副作用规则。服务端描述为只读或幂等，不等于已获得业务授权，也不证明一次响应丢失的写入可以再次派发。

远端服务实现不包含在本地插件指纹中。固定 URL、Schema 或工具目录只能固定客户端观察到的合同，不能保证远端代码未变。需要强恢复语义时，连接器必须提供版本识别和操作回执查询，否则只能拒绝不兼容变化并保留不确定结果。

## 对 TNB 的统一取舍

| 议题 | 采用 | 暂不采用 |
| --- | --- | --- |
| 扩展职责 | 现有四类贡献，工具和资源有明确所属 | 增加一个可以任意操纵内核的通用回调 |
| 注册 | 声明先行、暂存提交、资源归属、精确冲突诊断 | 同名自动覆盖或失败后切换内置实现 |
| 服务 | 类型引用、版本、提供者、作用域和依赖图 | 让每个插件取得整个 Runtime 或 SQLite |
| 权限 | 所有资源入口共用宿主策略，执行前复验 | 仅在模型 Schema 或菜单中隐藏 |
| 生命周期 | 每个资源有 owner；启动、调用、排空有界 | 超时返回后假装旧代码已经停止 |
| 持久恢复 | 原代码/配置/状态协议与当前权限同时满足 | 新包按同名替换，或自动迁移未知状态 |
| 交互 | 分端入口、命令和渲染器注册、只读事件 | 观察事件直接改权威任务状态或发业务写入 |
| 发布 | 稳定接口和实验接口分开，明确兼容测试 | 因仍处于 0.1 阶段就允许 v1 任意破坏 |

预算、状态转换、owner/fencing、问答提交、回执与结果验收的最终决定由宿主内核执行。插件可以补充业务能力或收紧策略，不能批准内核已经拒绝的操作。

## 当前差距与实施顺序

| 当前事实 | 对应规范工作 | 顺序 |
| --- | --- | --- |
| Host Loader 检查阻止指纹，资源发现和 Coding capability catalog 未统一检查 | 单一策略判定，覆盖 Skill、MCP、Hooks、工具、命令及执行前复验 | 第一轮 |
| HTTP 外部工具未区分 loopback 与外网目标；子进程的权限声明不构成 OS 限制 | 明确可信执行与受限执行，实施地址、环境和沙箱合同 | 第一轮 |
| 输出存在完整读取后再截断；关闭依赖插件配合取消 | 流式大小限制、调用期限、取消和排空协议 | 第一轮 |
| 插件非 GET 请求进入全局串行队列 | 缩短原子区间，使任务控制不被插件 I/O 阻塞 | 第一轮 |
| Application/Interface 沿同贡献版本读取旧状态，迁移由插件自行负责 | 状态版本、迁移回执、失败隔离及降级拒绝 | 第二轮 |
| Web 提交仍以 Coding 配置为入口 | 领域目录、输入/结果 Schema、统一 prepare/submit | 第二轮 |
| 服务由 Profile 手工装配，调用者自行填写泛型 | 独立 API 包、类型引用与作用域服务工厂 | 第二轮 |
| 历史恢复按 entry 执行 factory 后过滤贡献 | 可恢复入口的独立性、依赖和资源合同 | 第二轮 |
| 终态任务与 Source 保留历史引用；备份不包含可执行归档 | 可解释引用、显式退休、完整恢复预检 | 第三轮 |
| TUI 扩展和资源运行清单仍有单独路径 | 统一身份/策略/诊断，保留不同运行位置的执行器 | 第三轮 |

第一轮两个策略问题已用本地夹具复现：被阻止包的 Skill 仍获选；声明 loopback 的 HTTP 工具仍将外网 URL 交给 fetch。后者通过拦截 fetch 验证，没有实际外部请求。取消验证也确认忽略信号的 handler 会使关闭持续等待。TNB 源码依据为 [资源 active 判断](../src/services/plugins/loader.ts#L199)、[capability catalog](../src/adapters/coding/capabilities.ts#L47)、[外部执行器](../src/services/plugins/tools.ts#L239)、[关闭](../src/agent/extension-host.ts#L234) 与 [全局串行请求](../src/services/runtime/server.ts#L51)。

## 规范如何变成执行约束

要求必须同时写明输入、执行者、提交点、失败结果和验收。清单字段只有在注册表、执行器、生命周期和管理界面都具有一致语义时，才进入稳定协议。类型声明、示例和实际宿主应使用同一协议包；离线一致性测试覆盖默认包和安装包，不能仅靠内置插件通过。

首轮验收应包括：同一包在所有入口被一致阻止；loopback 工具不能向外网或经重定向越界；大输出和无换行输出受到读取上限约束；慢插件不阻塞取消；未知写入不因重启而重发。第二轮再验证安装一个新的非 Coding 业务后，发现、配置、提交和恢复都走标准接口，无需为该业务修改默认 Profile 或 Web 的业务分支。
