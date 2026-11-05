# 常驻协作模式实现审阅

基线 main `88438c9`，设计先独立提交为 `0ca1275`。本次比较、取舍和实现依据 TNB 与 DeepSeek Superagent `8c32a9d` 的实际源码。审阅采用逐项跟踪命令输入、持久回执、状态写入和外部副作用的方式，并用故障注入验证；没有使用额外 Agent。

## 设计合同检查

| 合同 | 实现与证据 |
| --- | --- |
| 复用原执行内核 | server 在同一 owner lock 下启动 CollaborationHost，复用 store/runtime/Coding 插件；CLI 生命周期转发 runtime，不另起 owner |
| 无 Run 也能记录来源事实 | schema 5 增加 application_records；v1–v4 迁移、CAS、事务回执、分页、快照和离线备份恢复均有用例 |
| 来源身份和权限独立于模型 | 严格配置固定工作目录、工具权限、模型及预算；GitHub 官方 API 给出 actor，webhook HMAC 认证桥的身份断言；外部额外字段拒绝 |
| 事件幂等和配置锁定 | source+externalId 稳定身份；原文摘要冲突拒绝；事件持久化接收时已规范化的配置及插件 provenance；旧事件不能套用新权限 |
| 创建 Run 与工单的崩溃桥 | 稳定 commandId、原 createRun 回执优先重放，再关联工单；SIGKILL 子进程后重新打开 SQLite 验证只有一个原 Run |
| 已发生的控制正确关联 | pause/resume/cancel、answer、followup 和 PR 绑定优先查匹配回执；发起者之后被撤权也不会让已提交动作失联，未执行动作仍检查当前权限 |
| 模糊输入不猜任务 | 原 Source/线程/身份关系匹配；多个候选进入 clarify；本机 resolve 需要原候选和当前 revision；跨线程及越权控制拒绝 |
| 来源游标恢复 | 扫描完整 GitHub 分页并重叠读取；事件分块先持久化，最后提交扫描游标。中途失败只会重读已经保存的事件，不越过未保存数据。单次 ingest 的事件与游标仍同事务 |
| 自动问题与结果 | Run/Wait 事实投影与 Outbox 入队同事务；问题附 waitId/version 和可复制回答指令；结果附实际报告和验收证据；已失效的问题发送前 suppressed |
| 暂停与授权保持 | 回答调用原 waits.answer，不执行 resume；修改 limits、reconcile 等只能用本机原管理接口；CI 变化不授权新 Run |
| 外部写入不确定性 | 发送前 dispatched；响应丢失及重启后 unknown；不自动重发。GitHub reconcile 只接受目标、正文、通知标记和账号全部匹配的回执；显式重试保留证据和版本 |
| PR 交付事实 | 明确授权绑定同仓库 PR；读取真实 head/checks/status/reviews/merged/closed；执行终态与交付状态分开，评审保留 commit |
| 独立推进与退出排空 | 来源轮询、接单投影、通知发送、PR 查询分开推进；PR 批量上限 4，通知每轮最多 16 个目标线程；关闭先停止入口并取消/等待所有协作网络请求，再关闭 runtime/store |
| 同库备份与保留 | 关联工单的真实 Run 有 FK 保护，不能直接 prune；应用记录包含于 SQLite snapshot/backup，相关 artifact references 纳入保留 |

## 审阅中修复的问题

- 撤权或插件不可用时，已提交 Run/控制的回执关联仍应恢复；只对尚未提交的动作重新检查授权。
- 外部网络不能占住整个协作循环。分离轮询、发送和 PR 观察，并限制一次 PR 扫描与通知批量。
- 接收或控制的异步间隙不能重新绑定 Source 身份，或者用新 revision 解释原控制命令。Source 传输身份固定；控制前保存原 Run revision；本机管理使用 CAS。
- 读取验收 artifact 时到达的新 PR 观察不能被旧投影覆盖。投影提交核对原工单 revision；不匹配则留给下一轮。
- 无变化的投影不能每秒写一个 command receipt。已完成且无需继续观察的工单退出活跃扫描，空闲投影不写回执。
- 旧 v3 迁移测试夹具必须同时去掉 v5 新表，再构造真正的历史版本；没有将生产迁移改成忽略现存新表。
- runtime ready 必须在可选协作组件初始化完成后发布；客户端等待正在启动的 owner，不为尚未 ready 的服务再次派生 owner。

## 验证

全部模型和渠道使用脚本模型、本机 HTTP 替身和临时工作目录；没有连接用户实际 GitHub/IM 渠道或发送真实消息。新增 18 个协作合同测试，覆盖迁移、快照/备份、重复与冲突、授权、来源游标、SIGKILL 恢复、跨线程/多工单、暂停后回答、过期问题、unknown 回执、PR head/CI/合并、投影竞态、网络隔离与退出排空。

本机完成 macOS/Linux 原生沙箱全量回归、最终变更的协作/服务/CLI 集中回归、typecheck 和编译构建。编译产物另外验证 collaboration validate/start/status/stop 生命周期。具体计数与平台结果以 PR 的验证记录和 CI 为准；本机测试保留原始日志。

## 明确保留的边界

第一版需要明确 `/tnb run` 接单；独立模型 Router、飞书/Slack 原生卡片、自动创建/推送/合并 PR 和开机服务注册未实现。普通终端形态和按需后台仍保留。

GitHub 分页不是上游事务快照，重叠扫描和 ID 去重降低并发评论变化风险，不承诺读取已被删除的消息。发送回执未知时无法跨系统保证 exactly-once。每线程保留发起顺序，unknown 不阻止后续独立通知，不保证严格送达顺序。

应用命名空间容量为 10,000 条，单条 128 KiB；达到容量明确停止接收/投影并暴露错误。自动归档、释放工单关联后安全 prune，以及长期历史分页 UI 留给后续，未暗中删除去重身份。备份覆盖数据库及执行证据，配置与凭据需单独保存。
