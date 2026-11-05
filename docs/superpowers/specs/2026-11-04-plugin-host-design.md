# 插件宿主体系：场景、应用、交互与渠道

基线：`b046216`（常驻协作 PR #3）。本轮先完善插件基础和实际迁移，再开发网页界面。执行内核、数据库、恢复协议和宿主所有权保持集中；插件统一发现、安装、信任校验、内容快照、代际固定与生命周期，不为应用另建加载器。

## 注册合同

保留现有 manifestVersion 2 / tnb.plugin/v1 的 contributes.adapters；新增 applications、interfaces、channels 使用 tnb.host-plugin/v1，使旧宿主明确拒绝不支持的应用 API，避免静默忽略。新 API 也支持同包声明 adapters。每项仍声明精确 id/version/entry，entry 必须是包内 .mjs。同一模块只导入并执行一次，按其所有声明授予对应注册接口；必须恰好注册声明的贡献，未声明、重复、越界、setup 完成后注册一律拒绝。整个包所有入口成功后才提交注册。未知 executable contribution 字段拒绝，避免静默降级。

应用与交互定义包含 start(context)，返回请求处理/状态接口，通过 onDispose 清理资源。交互插件可以提供视图或客户端协议，不强迫实现 Coding Adapter。渠道定义负责 connect(configuration, context)，返回 poll/send/find/observe 等协议。渠道消息合同独立于协作工单，GitHub PR 观察作为具名资源观察能力，由协作应用验证结果。持久状态与 Outbox 继续属于应用，网络适配器不创建第二套任务。

应用/交互可以声明精确依赖 kind/id/version；宿主校验缺失、循环和启动顺序，失败贡献不对外发布，依赖者不启动。领域适配器和渠道先注册；Runtime 就绪后再启动应用，随后启动交互。包注册失败原子回滚；贡献启动失败单独保留失败状态，宿主能明确要求某个必需应用启动成功，不能假装后台已经可用。一个包的其他已接纳领域代码不因后续应用故障被静默替换。

## 服务和权限

宿主提供按名称声明/授予的服务访问、插件专属状态目录、生命周期 AbortSignal 和清理注册。未声明或宿主未授予的服务不可通过 API 取得。内置协作应用获授 tnb.runtime 与 tnb.channels，普通示例仅获得读取状态的服务；不向所有插件默认暴露整个 env、SQLite 或控制 token。凭据只由宿主按需传给已配置渠道。

已信任的 .mjs 是进程内代码；服务授权是 API 边界，不是对恶意 Node/Bun 模块的 OS 沙箱。继续复用已有显式信任和包内容指纹，不作额外隔离承诺。未信任、禁用、内容变更、兼容性失败的包不得 import。已安装同名包即使失败，也不能绕过它回退到内置实现。

应用记录接口按插件命名空间访问，所有变更通过原 SQLite command/CAS。执行任务、问答、预算和未知副作用核对走 Runtime 原命令，不把持久 Run 状态授权给 UI 自行修改。扩展 HTTP 请求经宿主认证后按 kind/id/version 派发，handler 不得到宿主控制 token。

## 生命周期与恢复

加载和 setup 在 owner lock 下，先验证完整私有快照，再执行入口；每次宿主运行只使用一个不可变插件代际。更新、禁用、删除在重启后生效，不对活跃 worker 热替换。持久任务保留原领域插件 provenance；恢复时缺少原代际明确阻塞，不偷换实现。

停止先拒绝新扩展请求/渠道连接，取消应用和接口的信号，等待在途 handler 和渠道操作，按依赖逆序清理应用/交互/渠道，再停止 Runtime，最后释放领域插件快照、SQLite 和 owner lock。启动中途失败同样执行已注册清理，清理异常不跳过剩余资源。已保存事件/通知、人工问题和任务均沿原协议恢复，停用插件不删除业务事实。

## 本轮迁移和使用

- Coding 插件保留已有 API 与安装兼容；旧 loadAdapterPlugins/openAgentRuntime 调用继续可用。
- 常驻协作改为 tnb-collaboration 应用插件；runtime/server 不再 import 或直接 new CollaborationHost，以插件扩展路由提供原 /collaboration 兼容入口。
- GitHub、webhook、timer 通过渠道注册表连接。内置与已安装渠道使用相同合同；新渠道可以在 Source 配置使用显式 channel descriptor/options，不修改核心 switch。
- /plugins 和 runtime plugins 展示贡献种类、依赖、启动/失败/排空状态；继续使用原 install/trust/enable/disable 命令管理包。
- 提供可安装的最小应用+交互+渠道示例，证明扩展可被真实加载、调用、停用和恢复。网页工作台和现有 TUI 视图迁移不在这一轮实现，但注册/服务/生命周期协议必须真实可用，不能只列 enum。

## 验收

保留原领域插件/执行/协作测试；新增多类型同入口原子注册、未声明注册、信任变化、无内置回退、服务越权、缺失/循环依赖、启动及清理失败、在途调用退出、关闭后接口失效、安装渠道接单/通知、贡献 provenance、应用命名空间 CAS 与重启恢复测试。使用本机模型和 HTTP 替身，macOS/Linux 回归、编译产物探测和 CI 分别记录。实现后再次按合同审阅并明确尚未交付的 UI。

## 与已有中台项目的关系

对照本地 stream-agent 后，确认共同方向是通用执行与业务解耦，但当前 TNB 仍侧重本地可嵌入执行宿主，Stream Agent 侧重多业务服务中台。Spring SPI/部署配置、动态插件包和业务任务 API 属于不同扩展层，不能直接视为同一种插件体系。业务既可作为受信插件，也可独立后端通过标准 API 接入。下一层业务能力合同及多租户治理不在本轮冒充已交付；详细源码比较与后续边界见 `docs/guides/stream-agent-comparison.md`。
