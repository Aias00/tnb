# 协作应用的任务与状态权限

`tnb-collaboration` 使用 `tnb.collaboration/v1` 和 `tnb.channels/v1`。默认宿主不再发布 `tnb.runtime.internal/v1`，协作应用也不再接收 Runtime、SQLite、env、控制 key 或任意 artifact 读取器。

这次调整不改变 CLI、渠道命令、工单和 Outbox 协议。原 `/tnb run/followup/answer/pause/resume/cancel/bind` 和 `tnb collaboration ...` 仍然可用。

## 接口范围

`context.service(COLLABORATION_SERVICE).open(context.signal)` 打开一个应用生命周期内的服务，包含：

- `configuration()`：返回宿主 Source 配置副本，不能通过修改副本更改宿主 actor、工作目录、模型、预算或权限。
- `state`：只访问六个旧协作命名空间，支持事务与版本校验。看不到其他插件、宿主准入/归属凭据或 Runtime 的配置/账本/执行状态；不能写入 run.* 或 wait.answer 等核心命令回执。
- `tasks.admit(sourceId, incoming)`：使用宿主 Source 冻结原始请求和准入合同；应用不能提交自己构造的替代执行配置。
- `tasks.create(eventId)` / `tasks.apply(eventId, ticketId)`：从已有准入事实产生或控制任务，沿用原事件命令 ID、actor/controller 与 Source/thread 校验。
- `tasks.run/questions/summaries(runId)`：只读取本协作应用真正创建的任务和 root 验收摘要，不能通过伪造工单访问其他 Run。
- `close()`：结束服务租约。任务方法在取消后拒绝新操作；排空期间仍允许登记已观察到的发送结果，排空后关闭状态访问。

应用调用 `open` 后应立即登记 `onDispose(service.close)`，再登记网络/Host 的清理。宿主按逆序清理，因此服务最后关闭，保留登记已知结果的机会。

## 已有状态与恢复

事件、工单、游标、通知、来源身份、版本及旧命令身份保持不变。宿主第一次启用新桥时，在应用启动前把原有准入事实迁入应用不可访问的私有命名空间；被拒绝或忽略的历史请求不会因此获得准入。原工单的 Run 归属需要原 createRun 回执证明。

恢复会先查已提交回执，再检查新执行权限。创建 Run 后、关联工单前崩溃，仍关联原 Run，不再创建另一个任务。已提交的暂停/回答等操作可以补齐应用记录；撤权后未执行的命令仍被阻止。迁移不调用模型、工具或外部服务，也不替换旧领域插件代际。

新应用状态命令使用单独的命令空间，旧协作回执仍可恢复。未知发送结果仍保持 unknown，须核对或由操作者明确允许重试，不会因为升级服务接口就自动重发。

## 升级与边界

独立安装的旧协作包若仍请求 `tnb.runtime.internal/v1`，需要更新到新包并重新信任；宿主不会恢复这个高权限服务，也不会回退到内置实现。若 settings.json 中显式覆盖了 `tnb-collaboration` 的 pluginServices，应改为新服务名与渠道服务。普通默认配置不需要新增授权。

SDK 宿主可以使用 `createCollaborationService` 的同等宿主实现提供此合同；泛用业务仍优先使用受限 TaskService 与插件状态合同，不应把本协作专用服务复制为另一个全局 Runtime 入口。

这些是宿主 API 边界。插件仍是受信任的进程内代码；明确授予渠道注册表后，它具有相应渠道能力，并不获得 OS 沙箱隔离。本轮不自动迁移领域/渠道可执行代码的代际，也未把现有终端 TUI 整体插件化。
