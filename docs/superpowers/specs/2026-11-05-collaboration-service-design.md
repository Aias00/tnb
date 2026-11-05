# 协作插件的受限任务与状态服务

目标：删除默认 profile 的 `tnb.runtime.internal/v1` 及整个 Runtime 注入，协作插件改用 `tnb.collaboration/v1` 和原渠道注册表。执行内核、已有应用状态、命令回执与外部消息身份保持同一份事实。

## 服务合同

宿主创建协作服务，持有自己读取的 Source 配置；应用取得配置副本，不再获得 env、configDir、Runtime、SQLite、任意 artifact 或 generic command/replay API。

- state：只允许 collaboration.events/tickets/outbox/cursors/sources/meta 六个旧命名空间。事务仅暴露应用记录读写与 now，沿原数据库 command/CAS。拒绝 Runtime kind 的命令；保留已存在协作回执的重放，新增状态命令使用独立命令身份。
- tasks.admit：按宿主 Source 和原始事件解析、检查 actor、冻结配置并记录宿主私有准入凭据。插件不能指定替代 workspace、预算、工具、模型或 routing identity。
- tasks.create/apply：仅接受已准入事件和原工单，命令 ID 仍派生自原事件。先查历史回执，再检查新执行权限；提交与控制使用现有 Runtime 方法。工单只能绑定宿主确认由该协作事件创建的 Run。
- tasks.run/questions/summaries：只查询协作拥有的 Run，只读取 root 验收摘要，不开放数据库遍历、任意 configuration 或 artifact 引用。

宿主私有准入/归属事实保存在现有数据库的宿主私有应用命名空间 中，应用 state 接口不能读写。创建 Run 后、关联工单前崩溃时，恢复通过原 createRun 回执补全归属，不再次提交。非 Run 控制也保留原 input.route/wait.answer/run.* 回执语义。

## 兼容与恢复

六个旧应用命名空间、记录 ID、渠道 provenance、Outbox 身份及 CAS 均保留。第一次启用新桥时由宿主在插件启动前把已有准入事件迁入私有凭据；已有工单只在原 createRun 回执证明对应 Run 时补建归属。迁移不调用模型、工具或网络，不解析/替换旧领域插件，也不凭当前模型重新生成旧任务合同。完成标记阻止将后续插件可写记录当作历史可信数据。

来源配置由宿主保有，应用拿到副本。应用内改 actor、权限、模型或预算不能扩大宿主准入；渠道插件 provenance 由同一 registry 解析，未激活时不建立替代身份。新提交继续受 actor/controller、Source/thread 和内容摘要约束；旧已提交回执的恢复不成为撤权后的新执行授权。

## 验证与边界

补充跨命名空间、事务逃逸、伪造配置/actor/事件/外部 Run/命令种类、旧数据迁移和 crash window 验证，回归真实接单→问答→恢复→交付/Outbox unknown→核对。验证内置与独立安装应用均不需要内部 Runtime 服务。

这是宿主 API 的权限收敛。受信任进程内插件仍不是 OS 沙箱；渠道注册表权限与其他插件 API 继续沿现有合同，不宣称恶意 Node/Bun 代码已被隔离。更新仍受旧领域/渠道代际约束，本轮不实现多代际代码迁移或 TUI 整体插件化。通过本地替身验证、macOS/Linux 回归、构建与 CI 后直接推送 main，不新建 PR。
