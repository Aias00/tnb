# 发布能力与插件授权实现审阅

参考实现：Stream Agent 本地工作区的 `domain/access/ExecutionTasks.java`、`ExecutionDefinitions.java`、`domain/security/AgentAcl.java`；其基线为 06f9256，工作区含未提交实现，本轮仅只读参考。TNB 基线为 917f49c。

## 结论

完成一个独立阶段：不可变发布合同、精确贡献授权、受限插件执行服务、Owner 管理 CLI/API 和独立 SDK 示例。没有引入 Spring、外部数据库或另一套执行循环；新准入仍复用现有 SQLite 单 Owner、领域资源授权、任务状态机、历史包固定和长任务恢复。

采用 Stream 的三个设计点：发布与调用分离；调用身份/权限先于回执读取，回执先于重新解析当前发布；稳定幂等身份与当前代码授权分开。执行循环内部恢复继续由 TNB 负责，没有把 Stream 的 WorkItem 重排等同于会话 checkpoint。

## 关键审阅项

- publication digest 包含定义和 Adapter 精确代码身份；id/version 不可变。停发的 revision 不进入合同摘要，重复发布不能改代码或隐式重新启用。
- service scope 由宿主提供真实 consumer；业务输入无法指定 consumer、namespace、预算、工具权限或宿主配置。服务声明、宿主 allowlist、精确贡献能力 grant 三项均需满足。
- 业务命令键隔离 Owner/不同贡献；包升级需明确批准新指纹，稳定业务键不因此重复建任务。撤权后旧回执也不可读。
- 原始请求摘要、发布摘要、稳定调用方和实际准入 consumer 与 Run 同一事务保存。没有 Run 创建后补归属记录的空窗。
- await normalize/storage 后、createRun 同步事务前重新校验；Adapter normalize 不能改发布的资源或预算。并发精确提交即使绝对 deadline 不同，也根据已提交业务摘要返回同一个回执，变更输入仍冲突。
- result 只读正式接受结果，校验 Run 和 task 的归属；分页保持完整 JSON 内容，并在磁盘 IO 后再次校验当前授权。没有通过进程 RPC 返回 Runtime/store/连接或宿主控制密钥。
- 显式 prune 后保留命令身份，不因配置证据缺失而重建相同业务任务。发布/授权状态由 application_records 及既有 revision CAS、command receipt 持久化。
- CLI JSON 文件读取复用原领域入口的有界普通文件读取方式；新管理 API 沿用 Owner 的 socket 认证。未改变原 Coding、对话或领域提交入口。

## 验证

本地 macOS 最终全量 `TNB_REQUIRE_NATIVE_SANDBOX=1 bun test`：1362 pass、3 skip、0 fail，6113 assertions、202 files；类型检查、SDK 独立打包、构建与两类编译验证通过。新增定向测试覆盖 Schema/权限越界、发布不可变、授权 CAS、不同贡献/代码指纹、并发提交、异步撤权/停发/生命周期结束、结果 IO 撤权、重启、升级后旧回执、分页和 prune 后防重建。

默认产品端到端使用临时安装/信任记录、实际后台 Owner、示例进程 Application 的真实 JSON-RPC、离线 Agent 的真实工具调用和业务验收；验证重启后的同一任务/结果、停发和即时撤权。SDK 示例在独立项目仅安装本地 tarball，通过类型检查和打包，删除开发依赖后仍能验证包。

编译 CLI 的独立验证覆盖 detached Owner、catalog、普通领域任务、发布准入与回执重试；另跑原编译进程应用/渠道验证。CI macOS/Linux 跑全套，Windows 新增本阶段单元测试、CLI 前置校验与 SDK 打包验证；完整 Owner/Agent 端到端沿用现有 macOS/Linux 范围，未宣称 Windows 全量执行通过。

## 明确剩余边界

- namespace 不是租户鉴权；没有业务 API Key、客户端级总量配额、外部业务身份映射或远程执行桥接。私有 Owner 接口仍有管理员权限。
- 授权撤销控制后续访问/准入，不自动取消已接纳任务。Owner 可以用原有控制命令管理任务和调整预算。
- 服务只提供目录、提交、状态和结果；业务侧问答、事件消费 ACK、交付操作生命周期尚未纳入本阶段。仍可由宿主原有问答/通知接口处理。
- 服务可用性配置在启动时生效；能力 grants 每次调用读取。没有隐式热切换代码、自动切换发布版本或自动授予全部业务权限。
- 发布定义不是部署包仓库；尚未产生 Run 的发布不额外保留旧代码字节。恢复发布状态后仍须安装并信任对应代码。
- 进程隔离不是 OS 沙箱；继承既有 JSON-RPC 错误脱敏策略，业务消费者可能仅得到通用拒绝信息，管理员通过发布/授权记录诊断。
