# 发布能力与插件调用授权

状态：已实现，见对应审阅记录与发布能力指南。

参考 `/Volumes/data/stream-agent` 的 ExecutionTasks、ExecutionDefinitions 与 AgentAcl：发布版本固定执行合同，认证先于幂等回放，已接纳命令不受重新解析发布版本影响。只读参考本地源码，不修改 Stream Agent 的工作区。

本阶段落地：

1. 管理员发布不可变 `id/version`：目标、namespace、Adapter 精确代码身份、输入 Schema、资源/grants、执行策略和预算；停发只阻止新建。
2. `tnb.executions/v1` 贡献作用域服务，Application/Interface/Channel 显式声明服务并由宿主授予；另用持久 grant 绑定精确插件指纹与贡献身份。提供授权目录、提交、状态和分页结果，不暴露 Runtime/store/宿主控制密钥。
3. 原始业务请求摘要、调用方稳定身份和发布摘要随 Run configuration 同事务提交；不同贡献隔离幂等键；同贡献获批准升级后精确重试仍返回原回执。校验当前授权后先读回执，再检查停发/当前代码。异步准备结束、最终提交之前重查授权与发布状态。
4. 管理员 CLI/API 完成 check/publish/list/get/state/grant/grants 与 execute。文件和 RPC 都有边界校验。SDK 导出类型和服务引用，给出可运行接入示例及离线端到端验证。

明确边界：Owner 私有控制接口仍是管理员权限，namespace 不是租户鉴权。服务声明与宿主服务 allowlist 沿用现有机制，新增授权后首次使用可能需重启消费者；能力 grant 撤销对后续调用即时生效，不自动取消已接纳任务。新调用要求当前 Adapter 代码与发布身份一致，旧发布不会自动切换新代码。发布配置不是部署包仓库，未执行过的发布不额外保留旧代码字节。结果服务只读取正式接受结果；提问/回答、消费 ACK、多租户/API Key、远程桥接不在本阶段。

验证：不可变版本、输入/权限越界、错误消费者/指纹、幂等冲突与并发重试、停发/升级后的旧回执、重启和撤销竞态、进程插件真实 RPC、SDK 独立构建、CLI/API 认证、三平台 CI。
