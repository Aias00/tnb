# 常驻协作模式设计与实施范围

基线：main `88438c9`。目标是在已有执行内核和持久任务之上增加可选协作应用：持续收取外部请求，按来源授权接单，把人工问题与结果交回原渠道，跟踪明确绑定的 PR。普通终端模式保持可用。方案依据当前 TNB、DeepSeek Superagent `8c32a9d` 的 Source/Trigger/Ticket/Outbox 分层，不复制其实现或更换运行时。

## 交付顺序

先提交本方案，再实现第一版完整链路：配置、持久事件箱和路由、GitHub 接入、通用 IM/webhook 接口、定时事件、问题/结果通知、PR 跟踪、运行管理和故障回归。第一版新工作必须有明确 `/tnb run` 指令；已有线程仅沿已建立关系续接。模糊归属保留待处理，不按主题相似度匹配任务。独立模型 Router、飞书专属交互卡片、自动 PR 创建/合并及系统开机自启留为后续，不将其列为已经实现的能力。

## 运行与配置

沿用同一 owner、SQLite、认证 Unix IPC 和 `runtime start/serve/stop`；存在启用的 collaboration.json 时，后台同时启动协作循环。新增 `tnb collaboration` 管理入口，start/serve/restart/stop 转发原运行时操作。不是第二个抢锁进程。所有 Source 网络 I/O 有取消与超时，退出先停来源和通知，再停执行器，最后关闭数据库。配置为宿主文件，不允许外部消息修改。默认不启用，也不在本次开发中连接用户真实仓库或发送真实消息。

配置逐 Source 指定稳定 id、类型、允许发起者、允许控制者、固定 Coding 执行配置、轮询间隔及渠道。凭据仅引用环境变量。GitHub 每个 Source 固定 owner/repo；通用 webhook 使用共享密钥认证并限定接收端，作为 IM 适配桥；timer 固定授权目标和时间间隔。外部 payload 不能携带任意模型、Shell/check、工作目录、权限或预算覆盖。

## 数据与状态

在原 SQLite 增加应用记录命名空间，保留 command receipt/CAS 和同步事务。外部事件在没有 Run 前也能落库，不创建伪 Run；创建后工单关联真实 Run，数据库 FK 防止误删仍有关联的执行。备份包含同库协作事实。

- Event：稳定 source+externalId、原文、actor、thread、动作、路由结果、接收时的配置合同摘要。相同 id 相同 payload 幂等，变更 payload 拒绝；来源 actor 必须由可信 Source 给出。
- Ticket：来源线程、原请求、固定执行合同、runId、运行状态投影、问题和明确绑定的 PR。Run 决定执行是否完成，PR 的合并/关闭独立保存；CI 失败不重开新 Run。
- Cursor：与本批接收的事件同事务提交；GitHub 使用重叠读取和稳定事件 id 去重，分页未读完不得越过游标。
- Outbox：按稳定通知 id 保存 pending/dispatched/sent/unknown 和目的地、内容摘要、远端回执。问题通知绑定 waitId/version，回答仅对原工单、原渠道、明确授权 actor 接纳。旧问题和重复回答不能回答另一题。

## 路由与执行

标准动作：run、followup、answer、pause/resume/cancel、bind PR。新请求先落事件与接单决定，再以稳定 commandId 调用原 runtime.submit；若创建成功但工单写回前崩溃，重试相同原始配置与 commandId 取得原回执。外部配置发生变化时旧事件不得套用新权限重放。线程多工单且未明确目标时标记需要澄清，由操作者选目标；模型生成的正文不是身份和权限。

任务拆分继续 single/auto/multi，接单路由不替代 assess_delegation。暂停、取消、问答和续接继续走原 commands/router/waits。禁止外部渠道修改 limits、reconcile 或授权写范围；这些操作保持宿主显式管理。

## 来源与交付

GitHub 首版轮询 Issue/PR 评论，过滤机器人和自己的通知标记，以明确命令接单；网络配置固定 GitHub API，不接收消息中的任意 URL。稳定接收后再推进来源游标。通用 IM/webhook 将经认证的标准事件交给同一 intake，使用明确配置的回调渠道；timer 每个到期窗口产生唯一事件，不能无限补齐离线期间所有窗口。

问题与最终结果由投影循环自动加入 Outbox，无需用户轮询。内容包含工单 id、状态、问题的回答指令和可核查的验收摘要；不从“模型结束”推断代码验证通过。通知只发送到工单原渠道。第一版不提供所有 IM 厂商原生账号管理；桥接器必须校验厂商签名，再调用标准入口。

PR 由已授权的人明确绑定到本 Source 的仓库，接口从 GitHub 核查真实 PR、head SHA、CI 和评审。观察记录按 head/结果去重；未 merge 的成功 Run 展示等待交付，PR merged/closed 各自展示事实。不会因为 CI 评论自动获得更大权限或自动恢复暂停 Run。

## 外部写入不确定性

发送前持久化 dispatched；响应返回后保存回执。崩溃或断网后的 dispatched 转为 unknown，不盲目重复发送。GitHub 通知带稳定 HTML 标记，可查询已发送评论并核对作者、目标、内容；查到才标记 sent，未查到不等价于可以安全重发。标准 webhook 使用相同通知 id，要求接收方幂等，仍保留 unknown 供操作者核对。首版不承诺跨系统 exactly-once。

## 验收与审阅

使用脚本模型、本机 HTTP 服务器和临时仓库，不调用真实收费模型或真实社交渠道。覆盖来源授权、越权控制、事件冲突、分页/游标、重复接单、创建后崩溃恢复、续接归属、旧题回答、暂停后回答不恢复、通知发送结果丢失、重启 unknown 不重发、PR head 变动和合并事实、退出排空、旧数据库迁移/备份。先针对性回归，再 macOS/Linux 完整验证，CI 分开记录。实现后按合同逐项审阅，记录已交付与厂商适配等剩余边界。
