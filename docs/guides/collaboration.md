# 常驻协作模式

协作能力现在由 `tnb-collaboration` 应用插件与渠道插件组合，沿用原命令和配置，扩展方式见 [插件宿主指南](host-plugins.md)。

TNB 原有形态是终端交互客户端 + 按需启动的持久任务后台 + Coding/其他领域插件。协作模式在同一个后台中增加 Source → Event → Ticket → Run → Outbox 应用层，持续接收外部请求并自动回传问题、执行结果和明确绑定的 PR 状态。它复用原有 AgentLoop、任务拆分、权限、沙箱、预算、上下文压缩和恢复协议。

## 启动 GitHub 协作

1. 将 [示例配置](../../examples/collaboration/collaboration.json) 复制为 `$TNB_HOME/collaboration.json`（默认 `~/.tnb/collaboration.json`）。替换仓库、登录名、模型和绝对工作目录，确认允许的写入权限、验证命令及预算。工作目录必须与运行时控制目录分开。
2. 在启动后台的终端设置 `TNB_GITHUB_TOKEN`。配置文件只保存环境变量名，不保存 token；token 需能读取目标仓库 Issue/PR 评论、PR、Checks、commit statuses、reviews，并能写入 Issue 评论。GitHub 账号应使用专门的机器人账号；机器人账号自身的通知不会重新接单。
3. 验证配置并启动：

   ```sh
   tnb collaboration validate
   tnb collaboration start
   tnb collaboration status
   ```

   开发时可将 `tnb` 替换为 `bun src/entrypoints/cli.ts`。所有命令支持 `--config-dir PATH`。前台排查使用 `tnb collaboration serve`。
4. 在目标仓库的 Issue 或 PR 评论中单独发送：

   ```text
   /tnb run 分析这个问题，修复后执行约定的检查，报告修改和剩余风险
   ```

后台会主动回复工单 ID 和 Run ID。第一次启用 GitHub Source 时，持久化“从现在开始”的水位；不会批量执行历史评论。后续完整分页读取并重叠五分钟，用稳定评论 ID 去重。分页失败不推进水位；超出扫描上限、原评论 ID 内容冲突、过大 payload 等错误会出现在 `collaboration status`。GitHub API 没有事务快照；重叠扫描降低并发编辑/删除引起的分页风险，不保证保留上游已经删除或从未被 API 返回的消息。编辑已接收命令会产生身份冲突；新指令请发新评论。

`start/serve/restart/stop` 管理的就是 `runtime` 后台，不是第二个 daemon。关闭客户端不会取消任务。停止后台期间无法接收新 webhook，定时任务不无限补跑；GitHub 会在恢复后继续从持久水位读取。这里不安装 launchd/systemd 开机服务。配置和环境变量变更后执行 `tnb collaboration restart`；同一个 Source ID 的类型、仓库、回调渠道、凭据环境变量名和定时合同固定，迁移渠道需使用新 Source ID。允许发起者、控制者及后续新任务的执行权限可调整；已接纳事件始终保留原合同。

## 对话指令与权限

| 指令 | 发起者 | 行为 |
| --- | --- | --- |
| `/tnb run <目标>` | Source `actors` | 使用宿主固定配置创建任务，mode 仍为 single/auto/multi |
| `/tnb followup <工单ID> <内容>` | 原发起者或 `controllers` | 通过现有 Router 追加需求，不修改权限或预算 |
| `/tnb answer <工单ID> <问题ID> <版本> <答案>` | 原发起者或 `controllers` | 回答指定问题，保留暂停状态 |
| `/tnb pause\|resume\|cancel <工单ID>` | `controllers` | 使用原运行时控制协议 |
| `/tnb bind <工单ID> <PR号>` | GitHub Source `controllers` | 绑定本仓库真实 PR，观察 head、CI、评审、合并/关闭 |

问题通知会给出可复制的完整回答指令，也会列出可选项。无需另行轮询问题。普通补充文本只能接入原 Source/线程已有的工单，且需要贡献权限；多个可能工单时会发澄清通知。未建立关系的普通聊天不会启动任务。显式工单 ID 也不能跨线程、跨 Source 控制工作。

外部消息不能修改 workspace、模型、工具、Shell、验证命令、limits、reconcile 或预算。需要这些决定时在本机使用 `tnb runtime` 原管理入口。授权验证命令可能在恢复时重跑，应可安全重复执行。Coding Shell 和 checks 继续使用原生沙箱并阻止网络访问；本版不宣称 Agent 能自行创建/推送 PR。执行成功与 PR merged/closed 分别展示，CI 失败不会自动重开或恢复 Run。PR 评审保留对应 commit，不把旧 head 的批准当成新 head 批准。

## 通用 IM/webhook 桥

原生飞书卡片、账号管理、Slack 等厂商适配未包含在这一版。适配桥先验证厂商消息签名和真实 actor，再调用 TNB 的标准签名接口。桥的密钥等价于该 Source 的身份断言权限，不能下发给普通用户。

配置增加 `listen`，并使用 webhook Source：

```json
{
  "enabled": true,
  "listen": { "hostname": "127.0.0.1", "port": 8789 },
  "sources": [{
    "id": "team-chat",
    "type": "webhook",
    "actors": ["vendor-user-id"],
    "controllers": ["vendor-user-id"],
    "webhook": { "secretEnv": "TNB_BRIDGE_KEY", "outboundUrl": "https://bridge.example.com/tnb/replies" },
    "configuration": {
      "workspace": "/absolute/path/to/checkout", "allowWrite": false,
      "allowShell": false, "checks": [], "provider": "configured-provider", "model": "configured-model"
    }
  }]
}
```

入站请求为 `POST /sources/team-chat/events`，原始 UTF-8 JSON body：

```json
{"externalId":"vendor-message-123","actor":"vendor-user-id","thread":"vendor-thread-456","text":"/tnb run 分析故障"}
```

请求头 `x-tnb-timestamp` 是 13 位 Unix 毫秒时间戳；`x-tnb-signature` 是 `HMAC-SHA256(secret, timestamp + "." + rawBody)` 的小写 hex。允许五分钟时间差。Source 密钥至少 16 字符。相同 externalId + 相同 body 幂等；变更 actor/thread/text 会拒绝。成功返回 202 和持久事件 ID，只表示接收状态，执行/通知状态需看后续回传。接收体上限 32 KiB，正文上限 8,000 字节，run 目标上限 4,000 字节；额外字段拒绝。

出站 POST 到固定 outboundUrl，body 包含 `notificationId, thread, ticketId?, text`，使用相同签名协议，并带 `idempotency-key: notificationId`。桥必须按 notificationId 去重，成功返回：

```json
{"notificationId":"原通知ID","receipt":"可核查的渠道消息ID"}
```

生产回调要求 HTTPS；HTTP 仅接受本机回环地址供测试。入口只绑定 loopback；跨机器部署由受控 HTTPS 反向代理转发，禁止重定向和消息中任意回调 URL。GitHub API 地址固定为官方 API。

定时来源使用 `type: "timer"`，仍配置 `actors: ["timer"]`、固定 `configuration` 及 `webhook` 回调，同时增加：

```json
{"timer":{"everyMs":3600000,"objective":"检查项目状态并报告变化","thread":"scheduled-reports"}}
```

仅发送报告的 timer 不需要 listen。需要在渠道中回答 timer 问题时，配置 listen，并让桥回送到同一个 timer Source 的 `/sources/<定时来源ID>/events`；将可回答/控制的真实用户加入该 Source 的 controllers。每个时间窗口只有一个事件，首次启用立即执行当前窗口，重启只处理当前窗口，不无限追赶历史。问题和结果自动发送到配置的回调渠道。

## 恢复与人工处理

```sh
tnb collaboration events
tnb collaboration tickets
tnb collaboration outbox
# 每次最多 256 条；按最后一条 id 翻页
tnb collaboration events --after EVENT_ID
# 选择原澄清候选中的工单
tnb collaboration resolve EVENT_ID --ticket TICKET_ID --revision N
# 临时容量/依赖故障解决后，使用同一事件和原合同重试
tnb collaboration retry EVENT_ID --revision N
```

`retry` 不更新原配置、问题版本或控制时的 Run revision。过期的答案、已发生冲突的控制应重新读取状态并发送新的明确指令，不能靠重试绕过 CAS。

发送通知前先保存 dispatched。发送异常或重启遗留的 dispatched 会变成 unknown，后台不自动重发。GitHub 通知带稳定 HTML 标记，本机可查询完全匹配的作者、目标线程及正文：

```sh
tnb collaboration reconcile NOTIFICATION_ID
```

查询未找到并不能证明外部未发送。明确检查渠道记录后，可记录已发送证据，或显式授权一次重试：

```sh
tnb collaboration outbox-resolve NOTIFICATION_ID --revision N --decision sent --evidence "渠道消息ID及核对依据"
tnb collaboration outbox-resolve NOTIFICATION_ID --revision N --decision retry --evidence "已确认此通知ID未送达，授权再次发送"
```

已过期的问题通知会标记 suppressed；不会把旧问题再交给用户。轮询、接单投影、通知发送和 PR 查询分别推进，慢来源不会阻塞其他渠道通知。PR 每轮最多并发查询 4 个，每 30 秒轮转检查；通知每轮最多发送 16 个目标线程，每线程按持久序号发起发送。unknown 不阻止后续独立问题/结果通知，因此跨渠道不承诺严格送达顺序或 exactly-once。

协作事实和原执行事实在同一 SQLite 中。沿用 `runtime stop/backup/restore`；备份运行时数据库与证据，不包含配置文件或凭据，需要单独保管 configuration/env。仍被工单引用的 Run 不能直接 prune。每个应用命名空间最多 10,000 条、单条最多 128 KiB，达到容量后明确停止接收/投影并暴露错误，不静默丢弃或解除去重身份。自动归档/清理策略留待后续；本版上线前应根据事件频率评估容量并保留离线备份。

## 当前交付与后续

已交付的是显式接单和现有执行内核的完整协作链路。独立模型 Router、厂商原生卡片、自动创建/推送/合并 PR、启动服务注册、无人值守的外部写入重试和自动归档未包含。机器人回复的成功报告以 Run 的实际验收证据为依据，不把模型自然结束当成验证通过。
