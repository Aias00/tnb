# tnb 长任务运行时设计审阅记录

日期：2026-11-03。审阅对象：[长任务运行时与按需 Agent 协作设计](2026-11-03-durable-task-runtime-design.md)。初审基线：`844f7744c3c8a1961efcbf539b2bc8e155c2d096`，版本 0.1；层级恢复补充审阅基线：`aa1957218630a2cb8b8530a8cf4745eef26dff34`，版本 1.0；当前修订版本 1.1。

结论：初审有 3 项 P0、4 项 P1，补充审阅发现 1 项层级恢复 P0，共 4 项 P0、4 项 P1 设计缺口，均在方案中修订并复查，可从 P0-A 存储与命令层开始实现。这里的“关闭”表示设计协议补齐，不表示相应代码已经实现或故障测试已经通过。

本次由同一执行者在保存设计基线后另行进行场景自审，未使用独立审阅者。方法为源码对照、状态迁移枚举与故障窗口推演；不能替代实现后的代码评审和进程故障注入。P0 表示实现前必须关闭的授权或恢复安全缺口，P1 表示会破坏长任务正确性、需要在相应模块交付前解决的缺口。

## 1 审阅范围

依据设计的 I01–I12，检查：单/多 Agent 决策、任务/会话/attempt 身份、授权与 IPC、所有权、启动与取消、恢复、预算、消息、产物、存储保留和旧格式接管。核对 tnb `49b8586` 的 `CallJournal`、`ToolRuntime`、`UsageBudget`、WorkflowManager 和 fork Skill 入口，并对照方案所列固定版本的 Superagent、Pizza 和 Pi Durable 机制。

特别区分会话配平、执行恢复、工作区恢复、外部效果核对和业务验收。事件日志、worker 心跳、模型完成报告均不能单独证明业务效果正确。

## 2 发现与修订

### R01 P0 跨存储关联身份不够具体

**基线位置：第 8、10 节，基线第 170 行。** 方案要求 journal bridge 关联 SQLite 与 JSONL，却未规定 journal invocation ID 的生成方。现有 [CallJournal.intend](../../../src/services/session/call-journal.ts) 在内部随机生成 ID，并在追加成功后才返回；“日志已写入、DB 尚未记录 ID”时不能仅凭 operation_id 精确找回记录。

**影响：** 实现可能按工具名/参数猜测记录，或重建新调用重复副作用；transcript 追加成功但送达游标未提交也可能重复追加结果。

**修订：** 第 10.1 节规定 DB 预分配 operation/journal ID，adapter v2 幂等追加与精确查询，派发前 fsync，结果先落 journal、再幂等落 DB，transcript 使用 delivery key 去重。v1 无关联记录仍保守核对，不放宽 history scope。Hook 自身副作用单独记 Operation。

**复查：** 逐项推演 DB intent、journal intended、DB 关联、journal dispatched、工具结果、DB settled、transcript 和游标之间的崩溃窗口，均有明确复用或 unknown 路径。新增 T19，关联 T03/T04。状态：设计已关闭；实现单元 B 的发布门禁。

### R02 P0 single 模式的间接委派边界不明确

**基线位置：第 7.1、17 节。** 已要求统一准入，但未明确摘要等维护模型与业务 Agent 的区别，也未定义 fork Skill 在 single 下的处理。现有 [Skill loader](../../../src/services/skills/loader.ts) 支持 `context: fork`，仅屏蔽 agent 工具无法覆盖全部业务委派。

**影响：** single 可能通过 Skill、Hook、插件或动态工具间接产生子 Agent；也可能被过严实现为连摘要模型都禁止，破坏长任务上下文管理。

**修订：** 第 7.1 节定义 business/maintenance：维护模型无业务工具、共享预算；所有业务创建路径统一 `admitDelegation`。single 下 fork Skill 明确拒绝，禁止静默改变 Skill 语义；同一逻辑 Agent 顺序执行多个任务或恢复进程仍是 single。明确宿主插件信任边界。

**复查：** agent、workflow、fork/inline Skill、Hook、插件接口、tell 和 MCP 代传均有规则；P0 尚未具备委派时显式降级 auto/multi。关联 T09/T12。状态：设计已关闭；实现单元 C/F 门禁。

### R03 P0 同用户 IPC 权限不能区分用户与 Agent

**基线位置：第 8 节，基线第 162 行。** 原方案只规定 Unix socket/文件仅当前用户可访问。Agent Shell 与 UI 可能同 UID，仅凭该权限无法证明 worker 不能调用控制命令或修改运行时数据。

**影响：** Agent 可能将自身执行身份冒充用户，追加预算、放宽权限，或绕过取消和状态机。

**修订：** 第 8 节规定用户控制能力与 attempt 上报能力分离、凭据不进入模型与子进程、代理请求保留原主体、沙箱保护状态和控制 socket；边界未验证时拒绝开放无人值守 Shell。明确不把同 UID 任意程序或受信任宿主插件宣称为已强隔离。

**复查：** 区分“谁调用”“能调用哪些命令”和“脚本能否直接访问控制面”。新增 T23，并作为 F 的 macOS 原生效果测试门禁。状态：设计已关闭；代码尚需验证 IPC 与现有沙箱的兼容性。

### R04 P1 共享账本缺少重放和累计用量规则

**基线位置：第 14 节，基线第 238 行。** 方案规定共享预算与预留，但未定义物理请求、重复 usage 和 Provider 累计快照的计量身份。现有 [UsageBudget](../../../src/services/usage/budget.ts) 对每个归一化 usage 事件累加，不能直接当成持久重放账本。

**影响：** 重启重复入账，多个累计快照被重复计费，或父子/跨工作区分别获得一份完整额度；SessionStore 与新账本也可能双重累加。

**修订：** 第 14 节规定 physical_request_id、usage_sequence、摘要冲突校验、累计转增量规则和 uncertain 保留。RunLedger 唯一计量，SessionStore 是兼容投影；子预算和跨工作区额度为原 Run 分配。区分每 Run 与进程容量并按 Run 公平准入。

**复查：** 覆盖重试、fallback、重复回报、取消缺失 usage 和双存储投影；未知真实计费不承诺账单硬封顶。新增 T22，关联 T12。状态：设计已关闭；实现单元 E 门禁。

### R05 P1 waiting 可能漏掉已到达的唤醒条件

**基线位置：第 6、15 节。** 有 waiting 原因与持久消息，但未写明“条件先满足、父任务后注册等待”的竞态，以及提交后进程在发出通知前退出的处理。

**影响：** 子任务完成或审批到达后，父任务仍永久 waiting；重复通知也可能触发多个 attempt。

**修订：** 第 6 节增加 waiting 的退出转换，注册和条件检查同事务，持久 wake key 绑定 task revision，事件通知之外由启动/周期扫描补齐。外部等待不持有模型流槽。

**复查：** 推演结果先到、等待先登记、通知丢失和重复投递四种时序。新增 T20，关联 T10/T14。状态：设计已关闭；实现单元 A/C 门禁。

### R06 P1 重启分类和旧格式接管规则存在歧义

**基线位置：第 10 节“所有未完成 task 先进入 reconciling”、第 17 节。** 若实现直接照此批量处理，可能把 paused、waiting 和从未派发的 pending 混在一起。旧工作流导入后是否自动派发也未明确。

**影响：** 暂停任务被唤醒、审批等待丢失，或者旧 running 步骤被当成未执行再次执行。

**修订：** 第 10.2 节按原状态分类，取消优先、暂停保持、等待重查条件；仅有在途工作的对象进入核对。旧格式导入本身不能派发，证据不足保持 paused/reconciling；显式恢复也必须通过适配器准入。

**复查：** running、pending、ready、waiting、paused、cancel_requested 和终态均有路径；历史验收失效创建新修订，不抹掉旧事实。新增 T21，关联 T08。状态：设计已关闭；实现单元 C/G 门禁。

### R07 P1 保留和备份缺少并发与磁盘耗尽协议

**基线位置：第 16 节。** 原方案要求备份数据库与产物，但没有防止 GC 在备份期间删除被引用内容，也未区分“磁盘到阈值”与“状态结算本身已经写入失败”。事件归档后的客户端续订也缺少规则。

**影响：** 产生可解析但不完整的备份；恢复证据被回收；未持久化的取消/完成被当作成功；客户端遗漏归档事件。

**修订：** 第 16 节明确提前水位、真实 I/O 失败停止派发、禁止伪报持久成功；备份固定快照水位与引用内容，JSONL 按固定文件身份、字节水位和前缀摘要复制，全部校验后发布 manifest，GC 尊重保留锁；历史游标要求 snapshot-required。

**复查：** 备份和 GC 竞争、孤儿产物、未知效果、到配额及实际写入失败均有保留或停止路径。新增 T24，关联 T15/T16。状态：设计已关闭；实现单元 G 门禁。

### R08 P0 父子恢复缺少稳定的委派与结果消费协议

**补充审阅位置：版本 1.0 第 5、10、11 节。** 已保存 parent_task_id 并要求重新关联子任务，但没有规定委派创建的唯一 key、父 attempt 更替后如何找回子任务，以及子结果在父提交前后崩溃如何去重。不能据此直接声称所有级别都能正确恢复。

**影响：** 父恢复可能重新 spawn 已运行的子任务，中间 Agent 可能丢失与孙任务的关系，或者子任务已成功但父永远等待；旧父 revision 的结果也可能错误满足新计划。

**修订：** 第 5 节新增 Delegation，以父 Task revision 与 delegation_key 唯一关联子 Task；第 10.3 节规定各层统一恢复、祖先控制意图检查、存活子任务重新关联、结果消费去重、叶到父的推进及明确阻塞结果。层级深度以实际 capability 为准，不承诺无限递归恢复。

**复查：** 对根、中间、叶、daemon 与跨工作区一侧重启分别推演；新增 T25–T27，覆盖成功未消费、运行中、unknown、祖先取消及旧版本结果。状态：设计已关闭；P0 实现持久归属数据，P1 及递归能力开放前必须完成相应层级故障测试，P3 验证跨工作区。

## 3 修订后的审阅结论

| 项目 | 结论 |
| --- | --- |
| 设计缺口 | 初审及补充审阅共 4 项 P0、4 项 P1 均在文档修订并有复查场景 |
| 未关闭的设计阻断项 | 本次检查范围内为 0；不声称不存在其他问题 |
| 可开始的代码工作 | P0-A：SQLite 事务、身份、命令、revision、outbox 和状态转换 |
| 对外持久执行门禁 | 仍需完成 P0-A 至 G 的实现和 macOS 故障验证 |
| 验收范围 | 12 条不变量，27 组故障验收场景，层级恢复及 P1–P3 专属场景按能力阶段执行 |
| 本轮验证 | 文档本地链接、代码围栏、编号、差异与源机制核对；未运行实现级测试 |

复查还统一了阶段措辞：P0 独占用户指定工作区并保留已有 dirty 内容，P2 才开放多 worktree 并行实现；P0 的 auto/multi 明确报告降级。P0-A 至 G 分别对应可独立审查的代码切片，避免以全部规划完成为由提前开放未验证能力。

## 4 实施时仍需证明的事项

以下属于实现验证义务，不以“设计已审阅”视为满足：

- adapter v2 与现有 journal/transcript 的格式兼容、fsync 与 delivery 去重是否真能跨进程崩溃恢复。
- macOS 沙箱对 runtime 数据、控制 socket 与 Agent 可写工作区的实际效果；同 UID 宿主代码的信任边界是否如实呈现。
- 现有 Provider usage 归一化与物理请求身份如何对接，流失败、重试及 fallback 是否只计一次。
- Run 总预算与进程限流是否覆盖后台 Skill、Hook、摘要和 MCP sampling，且不会在父等子时死锁。
- 10 GiB 存储配额、并发初始值及停滞阈值是否适合真实任务；需等预算对比评测后调整。
- 所有启用路径是否经过统一准入和取消检查，传统 manager 是否在接管后停止写同一业务对象。

下一次审阅应针对具体代码切片与故障证据；新增公开能力必须同时更新 capability、用户文档和阶段门禁。

## 3 本轮实现审阅与交付边界

审阅基线为存储基础提交 `aaa639aeab5a1e7bc8ed31a95bd13b5b9d04b7a3` 后的实现；本轮仍为同一执行者自审，未冒充独立审阅。可运行入口、默认值、资源上限和操作说明以[运行时文档](../../durable-runtime.md)为准。

### 3.1 实现中发现并修复的问题

| 发现 | 影响 | 修复与验证 |
| --- | --- | --- |
| JSON 键顺序跨 SQLite 序列化变化，history scope 不稳定 | 已核对的写调用可能无法匹配原 operation，产生重复执行身份 | v2 journal 自定义规范化 scope；传统 journal 协议不变。真实 AgentLoop 写入后丢确认、重启、reconcile、resume，断言原写入仅一次 |
| strict sandbox 将 PATH 的 `/bin` 扩展成 `/` | 工作区外文件可读，破坏控制面隔离 | 禁止 PATH 和 execPath 推导扩大到文件系统根；收窄持久 Shell 的共享临时目录。原生 sandbox-exec 验证工作区写入成功、控制密钥/外部文件读取和 HTTP/Unix socket 连接失败 |
| 正在运行的验证 wake 被提前确认 | worker 尚未释放时丢失下一步调度 | 保留有界 retry wake，原子保存验收后的依赖唤醒；端到端任务可完成 |
| cancelling 对 validating 直接使用非法状态迁移 | 控制排空失败，取消停滞 | 经 reconciling 后终结；覆盖候选已落盘、验证尚未启动时取消 |
| 父任务恢复未重新申请并发名额 | 子任务释放槽后被其他分支占用时超额 | waiting 排除业务槽计数，父恢复前重新等待名额；只读并行与三级恢复回归 |
| terminal report 未绑定文件版本 | 重启或外部修改后可能接受过期报告 | 持久保存 report-input；只读从执行前捕获，编码从终态时捕获；验收变化要求重新调查/修复 |
| Provider 隐藏内存重试、排队请求提前预留 | 物理请求计量不清晰，未发送请求也消耗 uncertain 额度 | 持久 worker 禁用 Provider 内部重试，Run/global gate 接纳后才分配 request ID；子任务共享账本，已排队取消不产生预留 |
| 前台 CLI 与新 runtime 的工作区锁不共用 | 不同配置目录可同时修改同一工作树 | 按用户及规范工作区路径共用合作锁；前台 invocation 覆盖主目录、声明附加目录和已恢复 worktree |
| 备份直接反序列化 WAL image、恢复一次装载所有文件 | 独立镜像无法打开或内存无界增长 | 序列化镜像包含 WAL 页并转换独立 journal header；离线 owner 锁、逐文件校验/暂存、恢复后 paused、完整性检查和损坏备份拒绝回归 |
| resume 准备、控制回执与异步恢复可交错 | 同一命令重试 revision 变化，或恢复中误派发 | 控制命令串行化，保存原 expectedRevision；恢复中的 Run 不派发；HTTP 重复 pause/resume/cancel 与重启后重复 submit 验证 |

### 3.2 I01–I12 的当前覆盖

| 不变量 | 本轮实际边界 |
| --- | --- |
| I01 / I02 | 同一 Run/task 复用，attempt/epoch 更替；单 owner 锁和派发前执行权检查。真实 SIGKILL 在叶任务执行时杀死宿主，再恢复原三级关系 |
| I03 / I04 | 已提交 intent + fsynced dispatch barrier；未知写入阻塞；结果先 journal 后 DB。租约不宣称能隔离仍存活的任意旧外部进程 |
| I05 | 新运行时的全部业务/摘要模型使用原 Run 账本。未启用持久 Skill/Hook/MCP，不能把传统会话开销称为已纳入新账本 |
| I06 | auto 默认从单任务开始，single 隐藏且拒绝委派；multi 不强制角色。接纳理由、计划序号、读权限、层级、工作区与配额有记录 |
| I07 | 编码要求显式检查；子结果验收后返回并唤醒依赖。只读 `report-delivered` 是交付证据，不替代事实正确性的人工或业务验收 |
| I08 / I10 | 控制意图、任务迁移、事件、outbox 同事务；终态 transcript/操作和回执间使用稳定身份恢复 |
| I09 | 模型不能访问控制凭据；项目文本不能增加工具；deny/ask 不被提交权限绕过。暂无新的用户审批/任务纠正消息协议 |
| I11 | 队列、深度、任务数、worker/模型流、字节数、超时、重试和磁盘水位有界；不支持无限续期或追加预算 |
| I12 | 对工作区清单覆盖的输入比较版本，拒绝过期报告和验收期间修改；排除目录、系统/依赖环境和远程效果明确不在证明范围 |

### 3.3 没有开放的设计能力

本轮交付是可使用的本机长任务模式，不把完整演进方案的每一阶段记作完成。P2 隔离并行写入/worktree 整合、P3 跨 daemon 消息/ACK、持久 Skill/MCP/Hook/Workflow、旧格式导入、在线归档、权限/预算追加和动态输入修订未开放。逻辑 Agent 当前在同一 owner 进程执行；已验证整个宿主在叶任务运行中被杀死时的三级恢复，不声称验证了三个独立 worker 进程逐个重启。

目前一个必需分支遇到不可恢复错误会保守暂停整个 Run；尚未实现设计 10.3 的“无依赖兄弟分支继续运行”。同一服务内的跨工作区只读调用已验证共享身份和预算，但不是设计 P3 的双服务投递协议。子结果消费通过持久工具结果和 delivery 去重完成；输入不可在原 task 内修改，发生输入变化须使用新 key 或新 Run，没有实现任意在线重规划。

未使用真实付费模型，因此没有 long-horizon 语义成功率、多 Agent 收益或真实账单封顶的实验结论。当前故障回归证明的是列明的协议与实现边界。备份须离线，并将恢复的活跃工作暂停供核对；维护和原 owner 不能同时操作同一控制目录。单数据库备份镜像限制 512 MiB，恢复总文件量限制 10 GiB；工作区内容和 Provider 密钥由用户另行保管。

### 3.4 最终 macOS 验证

2026-11-03，Bun 1.3.14：类型检查通过；`TNB_REQUIRE_NATIVE_SANDBOX=1 bun test` 为 **745 pass / 2 skip / 0 fail，747 tests，119 files**。两项跳过分别是 Linux capability 和 Windows best-effort 专属原生测试，不是 macOS 沙箱跳过。构建通过，`dist/tnb --version` 为 0.1.0。

编译产物另行端到端验证：`dist/tnb runtime submit` 自动启动独立服务，本地 OpenAI SSE fixture 发出真实 write 调用，写入 `result.txt`，原生沙箱执行显式检查，Run 验收成功，`runtime result` 返回报告和检查证据，最后服务正常停止；共两次本地模型请求，无付费调用。日志和 fixture 验证记录保存在仓库外 `/Volumes/data/tnb-review-2026-11-03/`。这些验证不等同于长时间真实模型的任务质量测试。

## 4 对话触发补充实现审阅

在 `c3d5f8d` 基础上增加主对话 `durable_task`、Ink/终端 REPL 的 `/runtime submit`、来源 session 与对话摘要、按工作区/session 查询，以及后台占用工作区时的控制对话路径。自然语言由模型选择工具；确定命令不依赖模型解释。新建 Run 走现有工具权限链，直接斜杠命令表示用户显式提交；未把一个普通子 Agent 变成无限额度的后台新 Run。

审阅中修正的边界：

- 前台持有工作区时，后台在 outbox 等待，未预留 attempt/费用，也不消耗错误重试额度；丢掉前台回复不会重复创建同 key 的工作。
- 后台持有工作区时，控制对话使用独立 session 所有权和正常消息/计量/压缩，只有任务控制工具；不能重新打开普通文件、Shell、Skill、MCP 或项目 lifecycle。
- 子任务只继承祖先**实际已取得**的工作区 lease，不依据“祖先已加入 running Map”推断。避免恢复期间祖先尚未取锁、后代已越过资源检查的窗口。
- Plan 状态从历史工具结果恢复，deny/ask 和显式拒绝继续生效；主对话工具不进入子 Agent/fork Skill/Hook agent 的目录。
- 复用交互 Hook 时 fork 当前配置，替换其旧模型 handler：控制 Hook 仅能使用本轮受计量、无业务工具的模型；请求工作区工具的 Hook 返回阻塞，不复用旧 invocation 的闭包。已有工具前/后置、权限和停止 Hook 保留；不启动第二组文件 watcher。用户信任的 command/http Hook 仍属于宿主代码边界。
- 对话工具只能查询/控制当前规范工作区的 Run；默认优先匹配当前来源 session。旧 owner 没有 `conversationHandoff` capability 时，在查询和提交前拒绝，避免旧服务忽略筛选条件或对话上下文。
- 不可用工作区只暂停对应 Run，不把服务整体标成 fatal。斜杠命令继承当前 Provider/model，拒绝无法解释的额外参数；上下文和配置不兼容时仍使用原协议保守拒绝。

回归覆盖自然语言工具交接、前台释放后执行、忙碌时查进度、拒绝授权、Plan、重复 key、跨工作区拒绝、暂停/恢复不重复新建、子 Agent 不暴露工具、旧 owner 拒绝、历史 Plan 恢复、旧 Hook handler 不越权，以及真正的终端 REPL 斜杠路由。对话摘要有 16 KiB 上限，独立 Run 的预算会单独记录；本轮没有增加运行中修改目标或动态扩大授权的消息协议。

补充验证：macOS / Bun 1.3.14 类型检查和构建通过；完整原生沙箱测试 **758 pass / 2 skip / 0 fail，760 tests / 120 files**。两项跳过仍为 Linux/Windows 专属场景。编译后的 `dist/tnb` 使用真实双向 stream-json 对话，经一次 `can_use_tool` 确认提交，自动启动独立 owner；同一 session 下一轮在工作区忙碌时只有控制工具，能查询原 Run；关闭对话后后台继续，最终交付并验收成功。持久记录保留来源 session 和 SQLite 设计上下文，未重复创建工作。全部模型请求来自本地 SSE fixture，无付费调用。验证文件位于仓库外 `/Volumes/data/tnb-review-2026-11-03/conversation-*.log` 和 `compiled-conversation-smoke.json`。

## 5 专用长任务斜杠命令

增加 `/longtask`，别名 `/long`、`/长任务`。直接输入目标时复用 `runtime submit`，不创建另一套执行器；默认只读，写入许可和验收要求保持一致。查询和控制可省略 Run ID，优先选来源 session 最新任务，再选当前工作区最新任务；列表限定当前工作区。TUI 解析、补全和终端 REPL 使用同一斜杠目录；裸命令只显示帮助，不启动工作。

macOS / Bun 1.3.14 验证：类型检查、构建通过，完整测试 **762 pass / 2 skip / 0 fail，764 tests / 121 files**。新增回归覆盖专用命令和别名直接路由、补全、默认任务选择、工作区隔离、暂停/恢复/取消及无副作用帮助。编译后的真实终端 REPL 依次执行 `/longtask` 提交、`/long status`、`/长任务 result`、列表和帮助，只有一个后台 Run、一次本地 worker 模型请求、零次聊天解释请求，最终验收成功。验证记录在仓库外 `longtask-*.log` 和 `compiled-longtask-smoke.json`；无付费模型调用。

## 6 agent-autoloop 参考改造与实现审阅

参考源码固定为 `KKKKhazix/agent-autoloop@cecec75be3ca26e6ca1d6833b50152ee9450088d`。吸收持久提问/回答、定时复查、一轮结束后退出和最近到期调度；保留 tnb 的工具日志、未知副作用阻断、输入版本绑定验收及共享预算。未引入其 CLI 子进程适配层，也未把一轮的 done 解释为业务已完成。

实现新增 `DurableWaits`，以现有事务 records/signals/outbox 保存请求、版本、回答、定时器和子任务结果条件。`durable_wait` 支持根、中间、叶与 single；委派也使用持久挂起，替换原父任务的活动 Attempt/轮询闭包。新增 `/task questions`、`/task answer` 与对应 runtime、对话工具入口；对话回答仍需正常审批。

本轮审阅关闭的具体问题：

- 请求落盘后、本批工具回执落盘前退出：恢复时只幂等结清原控制调用，禁止新业务工具；journal 必须 settled，不能只把 Task 恢复成功却留下无法维护的 dispatched 记录。
- 回答先到、waiting 后登记：回答和信号原子提交；登记等待时同事务检查已到达的条件。暂停期间回答不唤醒，恢复后消费；取消后拒绝迟到回答。
- 信号不等于业务条件：有持久请求的 Task 还核对 answered/elapsed/resolved 状态，不能仅凭同 key 信号提前退出等待。
- 父任务结束 Attempt 后不能再让后代借祖先锁：移除祖先借锁路径。同 Run 纯只读执行以引用计数共享实际物理租约；写入或含验收命令的执行独占，最后一个持有者退出才解锁。
- 调度改为提交后通知与最近到期定时器，过期 effect 租约、Run deadline、定时等待和重试均进入到期计算；保留 30 秒磁盘检查。通知观察者不能撤销已提交事务，回滚或只读命令不发送变更通知。
- 原有中断测试改用可取消的验证阶段异步屏障，避免依赖 100 ms 轮询才能观察到的瞬时状态；仍验证同样的中断、失效验收与取消行为。

macOS / Bun 1.3.14 最终验证：类型检查、构建通过；要求原生沙箱的完整回归 **775 pass / 2 skip / 0 fail，777 tests / 122 files**，跳过项仅为 Linux/Windows 专属。新增测试覆盖题目版本与幂等、同批后续工具拒绝、回答/登记竞态、暂停回答、定时器重启、根—中间—叶全树等待恢复、取消迟到回答、读锁引用计数、编码父任务的子任务租约，以及问题已落盘但工具回执未保存时的真实 SIGKILL。

编译产物 `dist/tnb` 通过实际终端 REPL 和生产 Worker 组合验证：提交后提出问题并释放工作区，关闭对话和重启 owner 后不调用模型；新对话用 `/task answer` 提交原问题版本，沿用唯一 Run 继续并验收成功。共 2 次本地 SSE 模型请求，0 次聊天解释请求。证据在仓库外 `waits-*.log`、`compiled-durable-waits-smoke.ts/.log/.json`，没有付费模型调用或真实通知。

本轮边界：新工具集仍受能力指纹检查，旧指纹不兼容时保守停止，不能自动升级授权；默认 24 小时截止时间与预算约束仍然有效。未开放外部事件入口、问题编辑/撤回、推送通知、并行代码写入或远端协调。

## 7 长任务自动提醒与问答界面

上一轮只完成持久提问协议，用户还需要查询问题。本轮把已打开的 TUI/REPL 接入同一鉴权本地 `/attention` SSE：初次连接与重连返回未回答问题的状态快照，后续只在内容变化时推送，不需要模型解释通知或定期查询有没有问题。快照限定规范工作区，最多 64 个问题，回答后继续呈现队列中的下一批；切换工作区撤销旧交互。没有启动第二个 owner 或执行器。

TUI 复用 QuestionController 和选择/自由输入弹窗。空闲时自动询问；前台忙碌、已有草稿、权限/MCP 问题或其他弹窗时显示提醒和数量，保留原交互，之后依次询问。后台 notice 不改变前台 busy、流式文本或费用。Esc 只在当前界面暂缓，未把服务端问题确认成已处理；重新打开界面仍会补提醒。REPL 保持单一输入请求，空闲时直接显示选项并接收答案，有草稿时先完成原输入；`/later` 暂缓。直接选择或输入属于用户本人作答，不调用聊天模型或增加一层审批，服务端仍核对问题身份、版本和 Run 状态。

审阅关闭了两个 UI 时序问题：快速“方向键＋回车”按最新选择提交，不读取尚未更新的旧 React state；另一窗口回答/取消当前问题后，撤下旧弹窗并继续呈现下一问题，不把迟到输入关联到新问题。通知连接和对话退出清理订阅、AbortSignal 与定时器，owner 重启后使用新控制密钥重连。

macOS / Bun 1.3.14 最终验证：类型检查、构建通过；要求原生沙箱的全量测试 **786 pass / 2 skip / 0 fail，788 tests / 124 files**，跳过项仅为 Linux/Windows 专属。新增回归覆盖自动提醒与直接答案、草稿保留、owner 重启与重新打开、多窗口回答撤回、多问题队列和本地暂缓、工作区切换，以及前台流式状态不被提醒打断。真实 PTY 覆盖自动选项弹窗、方向键选择、草稿先提交、问题失效后继续聊天、撤下当前问题后自动呈现下一问题。

编译后的 `dist/tnb` 使用生产 Worker 和本地 SSE 模型走通两条流程：打开对话后自动询问并输入编号继续；关闭对话、留下另一个问题、重启 owner、新开对话后自动补提醒并输入编号继续。**手动问题查询命令 0 次、手动回答命令 0 次、聊天模型请求 0 次**，两个 Run 都成功，共 4 次本地 worker 请求。证据在仓库外 `attention-*.log` 和 `compiled-question-notifications-smoke.ts/.log/.json`。没有付费模型调用、真实桌面通知或对外消息。

提醒呈现在打开的 tnb 界面中；界面关闭后问题持久保留，下次打开补提醒。本轮没有实现系统桌面或外部通道通知。旧 owner 必须重启到具备 `questionNotifications` capability 的版本。

## 8 生命周期提醒、连接诊断与经济限制调整

本轮落实前三项优先改进：完成/失败/阻塞等生命周期提醒，后台连接状态可见，原 Run 续期与预算调整；同时统一过期问题的展示和回答条件。使用原 schema v2 的事件与 records，不引入另一套业务状态或模型循环。

生命周期提醒按工作区从当前 Run 状态和稳定持久事件 ID 生成，区分 succeeded、failed、blocked、paused、cancelled；budget、deadline、storage、unknown-effects、execution-error 有明确暂停原因和后续操作。客户端展示后确认送达，确认记录在同一数据库持久保存；断线或 owner 重启补发未确认状态，已确认的提醒不再反复显示。TUI 先提交带稳定 notice ID 的视图条目，再发确认；提醒不改变前台 busy、流式内容或计量。确认不是用户已读、问题回答或业务恢复授权，确认前崩溃仍允许重复提示。

连接明确区分 connecting/online/stopped/offline/incompatible/unauthorized。初次未启动也展示启动入口；旧 owner 缺少完整生命周期协议、控制凭据变化、连接断开或调度 fatal 均有可见说明。离线收起问题弹窗，保留输入，恢复后重新读取快照。新增显式 `runtime start/restart` 与交互入口；restart 排空旧 owner、等待所有权锁释放，再启动当前版本，保留已暂停/取消状态，不自行恢复暂停任务。未安装 launchd/systemd 托管或发送桌面通知。

新增 `/task limits`、`runtime limits` 和需要正常审批的 `durable_task limits`。只允许完全暂停、无活动 Attempt 的原 Run 调整未来截止时间或预算总上限；支持绝对带时区日期或有界时长延长，两者互斥。更新与命令回执、修订号、审计事件同事务提交，重复 command ID 不重复加时。所有 reported/uncertain/reserved 账目保留，新上限不能低于已有报告与预留。调整后保持暂停，resume 是独立授权；未知副作用屏障不受影响。

实现审阅特别修正了预算兼容性：新预算同时写入基础配置与 `run-limits`，使旧配置读取路径也能看到后来设置的上限；`binding-limits` 保存原预算值，仅兼容原安全能力指纹，不用于当前费用准入。模型、工具、文件/Shell 权限保持原值。任务级自定义预算覆盖需要明确迁移，不能令旧读取路径绕过 Run 上限。预算不足暂停的既有 Task 可以沿原绑定恢复，无需为加额度重新创建任务。过期问题隐藏并拒绝作答；续期后原 waitId/版本重新呈现，暂停期间回答仍不自动恢复。

macOS / Bun 1.3.14 最终验证：类型检查、构建通过；要求原生沙箱的完整回归 **801 pass / 2 skip / 0 fail，803 tests / 125 files**，跳过项仍仅为 Linux/Windows 专属。新增验证覆盖总额度更新与 uncertain 保留、事务/修订/重复加时、首次设限的配置兼容、绑定不变继续执行、过期问题续期后恢复、完成提醒持久确认、失败不误报完成、预算阻塞提醒、断线与新 owner 重连、旧协议/凭据/fatal 状态、真实服务 start/restart 保留暂停状态，以及真实 PTY 的完成提示、确认送达、离线撤下弹窗和草稿保留。

编译后的 `dist/tnb` 使用真实 CLI、独立 owner 和本地 SSE 模型走通：极小预算在模型请求前阻止执行并主动提醒；同 command ID 重复续期只生效一次，预算更新后仍暂停；显式恢复、直接回答问题，原 Run 验收成功并自动提醒；在对话内 restart 更换 owner 后不重复完成提示。全程 2 次本地 worker 请求、0 次聊天模型请求、无付费调用。证据在仓库外 `p0-*.log`、`compiled-runtime-p0-smoke.ts/.log/.json`。

后续仍包括系统桌面通知/系统服务托管、持久里程碑与防空转、业务级验收清单、失败分支隔离与公平调度、持久 Skill/MCP 和隔离并行编码。本轮不将这些后续能力标记为已完成。

## 9 Magpie free 分组真实启动验证

本轮经用户明确授权，在 macOS 上使用现有 Magpie 网关的 `group/free-models` 做真实模型调用。保留原分组成员、顺序路由和 turn affinity，不切换付费模型，不修改 Magpie 配置。最终成功流程的 5 次请求均 HTTP 200，响应头实际路由为 `workbuddy-ai/hy3`。没有为该路由虚构零价格；未配置美元预算，费用硬限额不在本次验证范围内。记录的 UTC 时间为 2026-11-04 03:30，当地日期仍为 2026-11-03。

真实调用发现并修复了两处本地模拟没有覆盖的问题：

- OpenAI Chat 流的 reasoning、text 和 `tool_calls[0]` 原来共用 canonical index 0，AgentLoop 因块类型冲突抛出 `Stream block type changed`。现在按内容类别和工具的 wire index 分配独立 canonical index，保留分片身份和参数拼接。回归通过真实 AgentLoop 同时覆盖思考、正文和两个身份分片完成顺序不同的工具调用，没有放宽块类型校验。
- durable Worker 的系统提示缺少实际工作目录，模型曾尝试写入虚构的 `/workspace/startup-proof.txt`。路径守卫拒绝，未知副作用屏障使任务暂停，没有越界写入。现在每个 Task 的系统提示均包含自身规范工作目录和文件路径规则；回归覆盖从提示中的目录生成绝对路径完成写入，以及跨工作区子任务收到自己的目录。保持原权限、沙箱和未知效果核对规则。

最终使用重新构建的 `dist/tnb`、生产 Worker、独立 owner 和真实终端 REPL 走通：`/task` 以 single 模式提交 → 自动呈现持久问题 → 关闭对话并重启 owner → 新对话自动补提问 → 直接输入选项编号 → 模型写入文件 → 已授权命令在原生沙箱内验收 → 自动完成提醒。重启前后 Task ID 和 wait ID 相同，等待期间重启没有新增模型请求；没有手动查询问题或运行回答命令，也没有调用聊天解释模型。最终 Run 为 succeeded，acceptance 为 verification-commands，真实文件内容逐字节为 `TNB_FREE_LIVE_OK\n`，验收命令 `/usr/bin/grep -Fxq TNB_FREE_LIVE_OK startup-proof.txt` 成功。用时约 24 秒，测试创建的对话、owner 和转发器均已停止。

本次以实际文件和宿主验收作为成功依据：模型先做了只读检查，没有严格遵守“第一步提问”，最终报告仍误写 `/workspace/startup-proof.txt` 并声称第一步已提问。这些属于报告准确性和指令遵循的剩余问题，不能用模型自述作为通过证据。本次覆盖短时单 Agent 的完整执行和等待重启恢复，不能代表数小时稳定性、所有分组成员或真实模型多层委派均已验证。

最终 macOS / Bun 1.3.14 验证：类型检查、构建通过；要求原生沙箱的完整回归 **802 pass / 2 skip / 0 fail，804 tests / 125 files**。两项跳过为其他平台专属测试。两处缺陷均先通过回归复现，再验证修复。前两轮失败证据保留，未将其隐藏或重新归类为成功。

测试程序为仓库外 `/Volumes/data/tnb-review-2026-11-03/magpie-free-live.ts`，本地转发器仅允许所选 free 分组和最多 12 次请求，原样转发真实上游响应；每次请求 120 秒、整体 330 秒边界。成功证据在 `/Volumes/data/tnb-review-2026-11-03/magpie-free-live-2026-11-04T03-30-01-645Z/`，包括 summary.json、requests.json、events.jsonl、result.json、原始响应和终端日志。失败证据分别在同级 `03-20-34-156Z` 和 `03-23-59-728Z` 目录。完整回归日志为 magpie-live-full-tests.log；未向第三方发送消息或通知。

## 10 普通会话、SDK、扩展与完整终端入口验证

用户要求扩大到完整功能验证后，在 `dde9ef9` 基线上对普通执行链、扩展与交互入口建立覆盖矩阵。不是把上一节的任务模式测试推广为其他模式已通过。当前 **29 组场景均取得通过证据**，覆盖实际编译 CLI、SDK 子进程、真实 PTY、独立安装包和 Magpie free 分组。普通会话与 durable Worker 分别验证，配置、工作区、插件、MCP 服务、进程及文件均在隔离测试目录中创建。

所有真实模型请求仍只允许 `group/free-models`，没有修改 Magpie 分组路由。响应头实际记录到 `workbuddy-ai/hy3` 和 `tokenharbor/deepseek-v4.1-flash:free`。29 组的探索、失败与复测共 185 次请求，另有最终 durable 回归 6 次，共 191 次；包括测试脚本修正前的请求，未仅统计成功轮次。没有为这些模型补写虚构零价格，CLI 的零费用估算不能充当服务商账单证据。

| 功能面 | 实际验证与判断依据 |
| --- | --- |
| 启动、配置和管理 | help/version、models/status/doctor、skills/agents/hooks/plugins/MCP/sessions/jobs、三种 shell 补全，以及 config set/get/unset。管理命令没有调用模型。 |
| 普通对话与输出 | 普通 JSON 输出、实时 JSONL、多轮对话、真实 usage；不通过 `/task` 转接。 |
| 编码闭环 | 模型实际调用 glob/grep/read/edit/write/notebook_edit/bash，修复加法，清除 Notebook 的旧输出，执行 `bun test`；独立检查实际文件与测试结果，拒绝把只有工具请求或完成报告算执行成功。 |
| 权限与沙箱 | SDK 允许与拒绝回调；plan 拒绝写入；显式 deny 优先；符号链接写入不能逃逸；原生沙箱拒绝工作区外写入。 |
| SDK 控制 | 有限输入流的两轮独立写入均获得审批；context usage、任务 CRUD、非运行任务 stop 拒绝、插件 reload、MCP 添加/启用/重连/删除、权限和模型切换；真实流开始后取消。迟到审批与监听清理另有进程回归。 |
| 会话与上下文 | 进程重开后 resume、fork 不修改来源会话、continue 选择最新分支；真实模型自动摘要把测试历史从约 3,945 tokens 降到 371，并在重开后保留历史代号；TUI 手动压缩从约 3,460 降到 453，导出和会话分支均有磁盘证据。自动压缩使用预先构造的历史，不宣称这些旧消息全部来自真人交互。 |
| Agent 与计划 | 实际 explore 子 Agent 读取文件，限制子 Agent 工具；进入 plan、读需求、强制 exit_plan_mode 审批后才写入；待办和持久 work-item CRUD。 |
| Skill | 元数据发现、按名称授权、独立 fork、仅 read 子工具、按需读取支持文件。父请求没有提前注入资源代号。 |
| MCP 与 Hook | 本地真实 stdio 服务进程和 HTTP 服务完成握手、工具发现与调用；Hook 的 SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/SessionEnd 有日志，模型实际收到 Hook 注入的上下文。服务为受控本地实现，不是假称联通过第三方 MCP。 |
| 插件 | 未信任插件不激活，显式信任后贡献 security_scan 并被模型调用；内容变更后原信任失效。 |
| Shell 与分发包 | 后台进程启动/读取/停止；真实 PTY 启动、输入、读取、90×24 resize 和停止。重新构建后通过 `install:local --prefix` 安装到源码仓库外，验证随包 JS/native 资源可用；依然需要系统 Node。 |
| 搜索与工作区 | 本地符号索引、独立安全扫描命令和插件扫描工具；实际 HTTPS 读取 example.com；独立 Git worktree 启动，来源跟踪文件没有变化。 |
| TUI 与文本 REPL | 完整 CLI 在真实 PTY 中自动提问、方向键选择 BLUE、允许一次写入、限制模型只看到两个工具、退出还原终端；TUI 本地 slash 不调用模型，并完成 rename/export/compact/fork。文本 REPL 验证普通多轮与其实际支持的任务命令。 |
| 最终 durable 回归 | 最终构建再次走通 `/task` 自动提问、关闭对话、owner 重启、原 Task/wait 恢复、直接回答、写文件、原生验收和完成提醒，6 次真实请求，约 26 秒，succeeded。 |

### 本轮发现并修复的实现问题

1. **fork 启动丢失管道输入。** readline 在异步 fork 准备期间已经流动，稍后订阅会遗漏输入和 EOF。现在先取得迭代器，再做异步初始化。进程回归验证 fork 继承上下文、只调用一次模型且不修改来源。
2. **SDK 取消路径及资源清理。** 单轮取消曾调用仅供双向会话的 interrupt 并同步抛错；结束后取消监听仍保留；取消后迟到审批会写入关闭的输入。现在 signal 终止整个查询并关闭子进程，移除监听，忽略迟到回调。
3. **有限多轮输入提前关闭审批通道。** 输入生成器完成不等于所有工具已获得审批。现在按已提交轮次与终态结果计数，在最后一轮结果到达后才关闭 stdin。回归包含两轮审批均异步完成的场景。
4. **SDK 模型 ID 中的 `/` 被错误解释。** `group/free-models` 曾被拆成 Provider `group`。现在复用配置模型解析，先匹配完整 ID，也支持显式 provider/model；非法切换不污染原选择。
5. **按 Skill 名称的权限规则没有匹配内容。** 现在 `skill(review)` 使用规范小写名称，真实授权可生效，显式 named deny 仍优先于 broad allow 和 YOLO。
6. **TUI 丢弃 `--tools`。** 构造实际对话参数时误删显式工具选择。现在保留限制；新增完整 CLI 的真实 PTY 回归，核对 Provider 请求中的工具目录，而不只测试参数解析器。
7. **编译后的 PTY 无法加载模块。** Node 子进程不能 require Bun 虚拟文件系统。build 现复制 node-pty JS 与对应平台原生包，运行时从二进制旁的真实目录加载，隔离安装测试验证完整生命周期。
8. **跨文件系统精度缓存使正常锁失效。** `/tmp` 与挂载工作区时间戳精度不同，proper-lockfile 在共享 fs 对象上缓存首个探测值，导致正常续租后 mtime 不匹配。现在每把锁使用独立 fs facade，独立探测精度，没有放宽所有权检查或忽略失效。新增混合精度回归先复现错误再验证修复；最终真实 TUI 多轮、审批和退出未再出现 ECOMPROMISED。

macOS / Bun 1.3.14 最终结果：类型检查、构建通过；要求原生沙箱的完整回归 **811 pass / 2 skip / 0 fail，813 tests / 128 files**。新增 9 个回归，跳过项仍为其他平台专属。后续只修改文档和仓库外测试驱动，没有在这个结果后调整生产代码。隔离安装位于 `/Volumes/data/tnb-review-2026-11-03/full-installed/`，没有替换用户正常安装；测试进程和本地服务已清理。

### 验证边界与保留问题

- 非 TTY 文本 REPL 只原生处理 `/task` 及别名、`/runtime`、`/exit`、`/quit`，其他输入沿普通 prompt 路径；它与 TUI 的完整 slash 管理不等价。README 已明确，自动化应使用 CLI 子命令或 stream-json SDK。
- 短对话的模型摘要可能比源历史更大；手动压缩会明确拒绝，不替换历史。足量历史的手动与自动压缩均另行通过，没有为了测试而取消缩小检查。
- free 模型偶尔只描述计划、不调用工具，或者在普通文本里打印伪工具标记，也可能额外做只读检查。本次判断以实际 tool execution 回执、磁盘状态及宿主检查为准，文字中的工具名和自述没有视作执行证据。编排框架不能单凭模型遵循提示来保证业务完成。
- Workflow、Team、goal loop、远程控制、重试/fallback、断流/崩溃窗口、LSP、其他 MCP 协议及 OAuth、图像与多模态适配仍由完整自动化测试中的受控 fixture 验证；本轮没有把它们标为真实外部服务全部联通。未调用 Brave 或付费图像接口，未登录外部 OAuth/IDE，未发布更新、反馈或对第三方发送消息。
- 真实调用均为短流程；不代表连续数小时稳定性、Linux/Windows、全部 free 成员或任意项目已经验证。

汇总为仓库外 `/Volumes/data/tnb-review-2026-11-03/full-functional-verification.json`，列出 29 组各自通过的证据目录、全部探索/失败/复测记录、实际路由和限制。测试驱动为 full-live.ts、full-live-extra.ts、full-live-tui.ts；每个目录保留请求/响应、JSONL、服务器协议日志、真实终端原始及还原文本。最终 TUI 证据在 `full-live-2026-11-04T04-13-02-973Z/`；最终 durable 证据在 `magpie-free-live-2026-11-04T04-13-23-143Z/`。完整回归日志为 full-regression.log，类型检查与构建日志为 full-typecheck.log、full-build.log。

## 11 Linux 原生与真实模型补充验证

本节记录首轮验证。下文“9 组、未重跑其余 20 组”和未执行的补充探针是当时状态；第 12 节已补齐同一份 29 组矩阵和原生探针，并保留首轮证据。

本轮使用独立 Colima `tnb-verify` 虚拟机，在 Ubuntu **24.04.4 LTS / Linux 6.8.0-117-generic / aarch64** 内直接执行，使用普通 UID 501，Bun 1.3.14、Node 18.19.1、bubblewrap 0.9.0。没有使用特权容器，没有切换主机默认 Docker context。源代码以 `95512f0` 为基线传入，再同步本轮明确列出的修复；主机和 guest 没有共享整个用户目录。

| 验证项 | 结果 |
| --- | --- |
| Linux 类型检查、全量测试、构建、隔离安装 | **806 pass / 7 skip / 0 fail，813 tests / 128 files**，其余检查通过。7 项跳过为 6 项 macOS 专用 Shell 生命周期测试及 1 项 Windows 沙箱测试。 |
| Linux bubblewrap 实际效果 | 工作区写入成功；restrictive/strict 模式下后代越界写入被拒绝；网络 blocked 与 open 行为不同；子进程 effective capabilities 为零；Worker 不能读取控制凭据、访问控制 socket 或无关文件，且 Shell 环境没有模型密钥。 |
| 不可启动后端的保守拒绝 | 未获命名空间许可的后端副本被 launch probe 拒绝，目标文件未创建。没有静默转为无沙箱执行。 |
| Linux 编译产物真实模型 | **9 组通过**：普通 JSON 对话；文件/Notebook/Shell 编码与测试；SDK 允许/拒绝；resume/fork/continue；Skill 按需资源与 fork；stdio MCP；HTTP MCP；后台 Shell 和 PTY 输入/resize/停止；真实 TUI 问答、BLUE 选择、允许一次写入、工具目录限制和干净退出。 |
| Linux 长任务重启恢复 | 实际提出问题、关闭对话、重启 owner、原 Task/wait 恢复、不在等待期间调用模型、直接回答、写文件、原生 grep 验收及完成提醒通过。Run succeeded，约 23 秒，6 次真实请求。 |
| macOS 回归 | **811 pass / 2 skip / 0 fail**，类型检查、构建通过。 |

Linux 真实调用仍仅通过现有 Magpie `group/free-models`，实际响应头为 `workbuddy-ai/hy3`。9 组初次验证及会话复测共 41 次请求，durable 回归 6 次，共 **47 次真实请求**。使用只转发到主机原网关的 SSH loopback 通道，没有向 VM 复制真实 Provider 密钥，也没有把新的代理端口暴露到局域网。

Ubuntu VM 的 AppArmor 默认策略起初拒绝 bubblewrap 设置 UID map。按其逐程序许可机制，只在该独立 VM 为 `/usr/bin/bwrap` 加载测试 profile 的 `userns` 许可；全局 `kernel.apparmor_restrict_unprivileged_userns=1` 与 `kernel.unprivileged_userns_clone=1` 保持不变。普通用户在该前提下运行所有测试；不能据此声称未配置许可的 Ubuntu 24.04 会自动工作。策略依据见 [Ubuntu 官方说明](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces)，实际设置、用户与版本保存在 environment.log。

首轮 Linux 全量测试为 794 pass / 14 skip / 5 fail。本轮关闭的差异：

- 未设置 `TNB_SHELL`/`SHELL` 时，原 POSIX 默认路径固定 `/bin/zsh`，Ubuntu 没有该程序，导致 3 个实际 Shell 执行测试失败。现在 Linux 回退 `/bin/sh`，macOS 保留原选择，显式配置仍优先。
- 两个真实终端测试使用 BSD `script -F`，GNU util-linux 参数不同。新增共享 PTY 启动 helper，分别使用 BSD 和 util-linux 参数，Linux CLI 工具目录与终端生命周期测试实际执行通过。
- 六项自动提问/提醒测试和生产 Worker 凭据/控制面沙箱测试原来只在 macOS 运行，现对 Linux 同样开启，没有通过跳过消除问题。
- 原问题测试夹具依赖对触发文件的 watch 通知，Linux 上可能在完整内容可读前通知、或不能按原假设观察 rename。夹具改为带响应确认的本地控制请求，测试核对实际输入草稿、选项和回答；清理时撤回问题并回收实际 TUI PID。生产自动提醒仍走原持久协议和 SSE。
- Linux CI 从局部原生沙箱回归扩展为 `bun test` 全量，安装 ripgrep/util-linux；Windows 保留原局部检查。本轮未推送或触发远程 CI。

会话首轮真实模型曾输出文本形式的伪工具调用，未返回要求的代号。没有把这种文本当执行或会话恢复成功；复测使用“仅在本会话保留的临时数据”明确区分长期记忆，重新核对原 session、分支父子关系、来源消息不变与 continue 选择后通过。失败原始请求和响应均保留。模型指令遵循和长期记忆策略仍不能替代确定性验收。

仍未覆盖：真实连续数小时与多任务并发的 soak；真实模型驱动的多层 Workflow/Team/goal loop；第三方 OAuth/MCP/IDE、Brave、图像生成/多模态真实服务及更新/反馈发布；Linux x86_64、其他发行版、Windows，以及任意挂载/内核策略组合。这些维度中已有的 fixture、故障注入与协议测试不提升为真实外部联通或所有平台保证。持久 Skill/MCP 和并行编码等尚未开放的能力，也不列为已验证。

Linux 本轮真实模型为上述 9 组及 durable 恢复，没有将 macOS 的 29 组真实模型矩阵全部重跑。Linux 上的真实模型自动/手动压缩、Hook/插件、Agent/Plan、工作区分支、公共网页读取和其余 SDK 控制组合等，仍只有本轮 Linux 自动化回归及此前 macOS 真实调用证据；不能据此标为 Linux 真实联通均已完成。

证据根目录为仓库外 `/Volumes/data/tnb-review-2026-11-03/linux/`：verification.json 汇总条件与通过场景；environment.log 记录实际捕获的平台、用户、版本和策略，未取得构建/安装二进制 SHA256；evidence/logs 保存全量回归、构建、安装、fail-closed 与真实调用日志；evidence/live 保存请求/响应、工具回执、终端及状态记录；evidence.tar.gz 是 guest 证据归档。全部必需验证完成、证据归档后发现主机系统盘空间紧张，已停止并删除本轮 VM 和专用 SSH 通道，释放其磁盘占用；原 Docker context 保持 default。额外的根挂载补充探针因主机空间问题未执行，未将其算作通过项。

## 12 Linux 完整功能矩阵补齐

在冻结的产品提交 **`63cb7ac`** 上，重新建立独立 Colima `tnb-full` VM，执行与第 10 节 macOS 相同的 **29 组功能矩阵，最终 29/29 通过**，通过名称集合比较确认没有遗漏。此轮不修改产品代码。Linux 首轮只执行 9 组，不能当作平台完整矩阵；本节补齐该缺口。

环境为 Ubuntu 24.04.4 LTS、Linux 6.8.0-117-generic、ARM64，普通 UID 501，Bun 1.3.14、Node 18.19.1、bubblewrap 0.9.0。直接在 VM 执行，没有使用特权容器。再次执行类型检查、`TNB_REQUIRE_NATIVE_SANDBOX=1` 全量测试、构建及隔离安装，结果 **806 pass / 7 skip / 0 fail，813 tests / 128 files**，其他检查通过。跳过项仍为平台专用测试。实际产物为 Linux ARM64 ELF，构建与安装二进制 SHA256 相同：

```text
160bd57ca4a810186ba9e53ddbc899421e7e0117d39be2bfc138a4847e4994b0
```

29 组包括：管理命令、普通 JSON 对话、文件/Notebook/Shell 编码与验收、SDK 允许/拒绝、Plan/显式拒绝、resume/fork/continue、Skill 发现/fork/资源、前台 Agent、结构化输出、自动压缩与恢复、stdio MCP、HTTP MCP、Hook 生命周期、SDK 多轮运行控制、沙箱越界拒绝、文件 symlink 逃逸防护、Task/Todo 工具、隔离 Git worktree、Plan 审批切换、后台 Shell/PTY、语义索引与安全扫描、SDK 有限多轮审批、真实取消、插件信任与工具、公共网页读取、自定义命令展开、文本 REPL 对话与 `/task`、真实 TUI 提问/权限/退出、TUI slash/session/手动压缩/export。管理命令本身无需模型；依赖模型的场景均使用真实请求，并核对结构化执行回执、文件或状态结果。

真实调用仅经守卫转发到已有 Magpie **`group/free-models`**，响应路由出现 `workbuddy-ai/hy3` 和 `tokenharbor/deepseek-v4.1-flash:free`。核心批次 36 次、扩展初测 45 次、终端批次 11 次、三项复测 6 次、durable 7 次，总计 **105 次真实请求**，包含失败与复测。没有复制真实 Provider 凭据到 VM；SSH 通道仅绑定 guest loopback，未更改原 Magpie 路由配置。

扩展批次初测有 3 项未通过，原始失败均保留，修正测试/环境后逐项复测通过：

- 沙箱负向断言原先只识别 macOS 错误文本，Linux 实际返回 `Read-only file system`。改为核对真实 bash `tool-execution-end`、`isError`、EPERM/EACCES/EROFS 对应错误和目标文件不存在。
- worktree 夹具缺少 Git identity。只在夹具仓库设置 `Verification / verification@localhost`，不修改主机或 guest 全局 Git identity。
- VM 的 `/etc/resolv.conf` 指向缺失的 systemd-resolved stub，公共 HTTPS 解析失败。备份原链接，确认 DNS 可达后仅在 VM 配置有效解析器；实际读取 example.com 成功，没有绕过 TLS 或 SSRF 检查。

驱动也收紧了成功判断：Task 工具必须有成功执行回执；REPL 临时数据记忆核对最终持久化 assistant 消息，不从包含提示回显的整段终端文本匹配。没有把模型文字中提到工具当作已调用工具。

长任务独立验证实际提问、等待期间不请求模型、关闭前台并重启 owner、恢复原 Task/wait、回答、写文件、原生验收与完成提醒，Run succeeded，约 24 秒、7 次真实请求。补充原生探针验证 strict 根挂载为只读、未授权根路径写入报 EROFS；沙箱 PTY 隐藏工作区外秘密、允许工作区写入、resize 至 90x24 并正常关闭；未获许可的后端副本被 launch probe 拒绝且命令效果不存在。首轮探针驱动误用了 `writePty` 参数 `input`，更正为实际 API 的 `chars` 后执行通过，旧日志保留。

本轮仍需第 11 节所述逐程序 AppArmor `userns` 许可，全局两项 sysctl 保持 `1`。这验证该环境前提下的隔离效果，不保证未配置的 Ubuntu 默认可启动。

证据目录：仓库外 **`/Volumes/data/tnb-review-2026-11-03/linux-full/`**。`verification.json` 汇总全部 29 组证据与请求统计，`matrix.json` 保存基准名称；`evidence.tar.gz` 与 `evidence/` 保留初测、失败、复测、请求/响应、终端及全部原生回归日志；`environment.log` 记录环境、ELF 与两份哈希；`tnb-linux-arm64-63cb7ac.tar.gz` 保存完整安装运行包，归档内二进制亦已校验相同 SHA256。

VM 存储及临时目录均置于 `/Volumes/data/tnb-linux-vm/`，避免继续占用紧张的系统卷。归档完成后关闭本轮专用 SSH 通道并停止 `tnb-full`，保留数据卷中的已停止磁盘供复查；主机默认 Docker context 仍为 `default`，未操作其他用户 VM。

剩余边界：29 组是完整执行已定义矩阵，不是所有功能穷尽覆盖。仍未实际执行连续数小时、多任务并发 soak，真实多层 Workflow/Team/goal loop，第三方 OAuth/IDE/Brave、其余 MCP 协议、图像与多模态、更新/反馈发布，也没有验证 Linux x86_64、其他发行版/内核/挂载组合及 Windows。已有 fixture 和故障注入测试不提升为这些维度的真实联通保证。长任务当前也不开放持久 Skill/MCP 或并行编码能力。

## 13 长任务窗口预算与持久上下文补齐

针对长任务固定 24k 阈值、未计系统/工具开销、摘要请求本身超限和重复摘要遗忘目标的问题，接入独立的 Durable Context 管理，并复用现有分层压缩流程。生产 Worker 显式提供模型窗口；按完整请求保守估算输入，扣除输出和安全余量。实际发送前再做准入检查，固定指令本身无法容纳则记录错误、暂停 Run，不盲目丢弃任务目标。

摘要按有界证据片段递进合并，禁用工具、限制单次输出和总请求数；Provider 上下文拒绝时缩小分块。完整调用与结果轮次可作为长任务切分边界；巨大工具结果只裁剪活动上下文，原始 delivery 不删除。分层摘要失败可折叠旧证据，但取消、执行权失效、预算/用量错误不得降级为继续运行。复核修正了一个小预算边界：裁剪提示本身也必须计入结果字节上限，避免替换反而超限。

任务目标、工作区、验收命令、执行权限、原始对话参考、最近等待检查点和最近用户答案固定注入每次请求。独立 `task-progress` 记录最近工具回执，与消息投递完成在同一事务更新；压缩不覆盖它。delivery 摘要校验包含新增压缩元数据，重启沿原压缩边界恢复。旧格式 delivery 未添加元数据时保留原摘要算法，不要求改写历史。

新增 `durable_recall` 对本 Task 已确认投递的消息进行有界搜索/分页，区分原始结果与压缩边界，防止只留归档却无法由 Worker 取回。工具不接受其他任务、文件路径或 SQL，不开放控制目录的普通文件读取。它仅投影本任务原有上下文数据，不改变既有外部能力 binding；外部工具、模型、权限及项目指令仍按原规则校验。搜索也可能命中历史搜索请求，调用者可用 `toolResults`、`compact`、preview 和 `before` 选择实际原始证据。

复核边界：估计器采用 UTF-8 字节和消息开销，偏保守且不是精确 tokenizer，可能增加摘要频率；网关实际窗口比配置更小时，有限恢复仍可能暂停。检查点回执不等于验收通过，历史输出和答案不能提升权限。摘要具有损失性，需按需取回原证据并核对当前文件。默认截止时间、费用/轮次、每 Task 64 MiB transcript 和全局存储限制继续生效，未宣称无限任务或数小时稳定性。

验证包括小窗口/中文/Unicode、完整工具轮次保留、巨大结果裁剪、分块摘要及 Provider 窗口不符、主请求超限强制压缩重试、摘要失败降级、取消/执行权/预算拒绝、输出限额与费用预留一致性。真实运行时集成测试覆盖压缩后提问、关闭 owner 与 SQLite、重新打开后消费原答案、分页取回被压缩的真实工具回执、沿原任务完成且不重做已完成操作；另注入 transcript fsync 后崩溃，验证回执与检查点恢复只提交一次、跨 Task 证据不可检索。

本轮 macOS 类型检查、完整构建通过；全量回归 **820 pass / 2 skip / 0 fail，822 tests / 130 files**。新增 9 项回归与既有测试共同验证上述路径。日志在仓库外 `/Volumes/data/tnb-review-2026-11-03/context-full-tests-final.log`、`context-build.log`。第 12 节 Linux 矩阵对应冻结提交 `63cb7ac`；本节新增逻辑本轮未重新在 Linux VM 上运行，不把旧平台验证冒充本次结果。

另通过守卫仅允许 Magpie `group/free-models` 的真实调用，向生产 Worker 注入明确标注的合成旧对话以触发压缩，要求实际读取工作区文件后返回首行标记。初轮及裁剪提示修正后的最终复测均为 4 次真实请求、2 次持久压缩，合计 **8 次真实请求**；实际路由 `workbuddy-ai/hy3`，两次 Run 均 succeeded。独立读取 SQLite，确认 read 操作 settled 且 `outcome.result.isError=false`，交付包含实际文件标记。初轮证据在 `/Volumes/data/tnb-review-2026-11-03/context-live-2026-11-04T06-22-19-786Z/verification.json`，最终证据在 `/Volumes/data/tnb-review-2026-11-03/context-live-2026-11-04T06-24-40-933Z/verification.json`，请求均留档。重启/分页和故障边界由前述确定性测试验证；此短流程不代表真实数小时 soak。


## 14 Router 参考遗漏与设计兑现复核

日期：2026-11-04。复核基线：`d7cb45e`。本轮仅修订文档，未改变产品运行行为。修订规格见[输入路由与委派策略](2026-11-04-task-routing-and-delegation-design.md)。

原设计第 4 节已有身份路由，第 7.2 节已有续接识别和完整委派提案要求，因此“此前完全没有路由概念”不准确。实际遗漏是：对已提供的 Superagent 参考重点采用领域模型和 Effects，却未把 Router 的原文归属、attach、职责边界与幂等决定落实为 TNB 的输入/决策/交付协议；实现复核又未将这些未兑现项列为退出缺口。此前的文档级审阅与实现测试不能被表述为该设计已经完整兑现。

| 差距 | 源码与影响 | 本次修订 |
| --- | --- | --- |
| 输入归属缺少完整协议 | conversation-tool 的动作没有通用 followup；最近 Run 回退不能证明自然语言输入的真实归属 | 输入实体、结构化决定、目标依据、歧义澄清和安全 inbox 交付 |
| auto/multi 语义未兑现 | engine 对两模式设置相同容量和委派门控；运行时文档却描述 multi 优先分工 | 使用文档改为当前事实；方案明确一次有界评估及可保持单 Agent 的验收 |
| 持久路由与在途操作关系未细化 | 直接追加活动上下文可能破坏调用 scope，新增要求与旧 candidate 竞争也未定义 | 路由与 outbox 事务提交，安全轮次消费，输入修订使旧验收不能满足新要求 |
| 结果证据强度表述不足 | report-delivered 证明报告交付，不证明分析语义正确 | 证据核实、必要/辅助失败语义和父验收额度预留 |
| 多终端限制范围不完整 | 前台 UsageBudget 是进程内；同 runtime 的上限不是机器级协调 | 资源域租约、跨进程公平排队与目录祖先/后代冲突作为后续交付 |

新增 R01–R09 验收分别覆盖幂等崩溃、模糊归属、inbox 交付、验收输入竞争、终态/权限、模式区别、提案与容量、证据强度、多终端资源和目录冲突。以上均为待实现退出条件，没有标为已通过。本轮只核对源码映射、文档内部状态、相对链接和差异格式，不重跑无代码变更的产品测试，也不调用真实模型。

## 15 输入路由与委派策略实现审阅

日期：2026-11-04。本节接续第 14 节，审阅 R1–R4 的实际代码，不改写前节历史结论。实现以 `3692f99` 文档基线为起点，产品基线为 `d7cb45e`；本节与产品同次本地提交，未推送远端。

输入由 `routing.ts` 保存原文、来源身份、会话、工作区、目标与决定。schema v3 的路由表与原命令事务协作，新工作或补充接纳同时产生关联记录和 outbox。`followup` 进入 Task inbox；完整工具轮次后按稳定 delivery identity 交付，重启修复消费回执。新增要求提升 inputRevision，旧 candidate 或竞争中的验收均不得接纳，增量继续不消耗错误修复次数。控制歧义与 Worker 业务等待分开保存，通过原 SSE/inbox/终端组件自动询问，不伪造 waitId。最终复核补齐了跨会话/工作区输入身份冲突、澄清候选范围、自然语言定向控制原文审计。

新策略 v2 的 auto 从 direct 开始，容量/批次 2；multi 容量/批次 4，四回合内通过显式评估或完整提案确定是否分工；single 仍由代码拒绝业务委派。默认深度 1，旧 Run 不改策略/schema 指纹。提案、scope、来源证据、交付、验收、必要性与限额持久保存。子调查增加 `complete_investigation`，提交后以原回执结束，无需多一次模型请求；父任务明确复核当前子结果。必要分支失败阻塞，辅助失败需明确接管并在最终产物披露。最后两次 Run 请求及估算费用留给父整合，uncertain 费用不归零。

同用户跨进程 coordinator 与 TNB_HOME 无关；资源域由实际 endpoint、API、凭据与规范化请求头哈希确定，每域 4、总计 8 个活跃请求，队列 256。同域项目轮转，排队前不预留持久费用；进程死亡及出生身份不匹配可回收租约，无法验证的活跃进程保守保留。工作区真实路径检查覆盖相同、父子与符号链接别名，保留旧精确目录锁。协调协议不是同 UID 隔离或远端配额。

| 要求 | 实现与直接证据 | 证据边界 |
| --- | --- | --- |
| R01 | `task-routing.test.ts`：事务回滚、身份重投、提交后真实 SIGKILL 再开 SQLite | 与既有 command/store 故障测试共同覆盖，不是任意磁盘故障证明 |
| R02 | 多 Run 澄清、持久重开、原文选择；两平台真实 inbox 自动问答 | 自然语言归属质量未作大样本评测 |
| R03 | 在途物理请求收到补充、scope 不变；transcript 已交付而消费回执丢失的恢复 | 确定性故障注入不冒充所有工具中断点实测 |
| R04 | 验收检查与新输入竞争，旧候选失效，重验且不消耗 retry | 业务语义完整性仍需验收与模型核实 |
| R05 | 暂停不恢复、取消/跨工作区拒绝；既有迟到答案及控制测试 | successor 是显式新建，不回退原终态 |
| R06 | 新 single/auto/multi 策略、multi 选择 direct、四回合上限与真实分工 | 未完成同任务同预算的质量/成本比较 |
| R07 | 稳定委派身份、提案拒绝事件、合同请求上限、父预留；结构化报告回执故障恢复 | 沿用原队列与层级恢复测试，没有真实数小时资源压测 |
| R08 | 无效引用拒绝、辅助失败接管/披露、输入修订校验、父显式复核 | 工具引用校验只证明实际来源，不能证明分析语义正确 |
| R09 | 独立进程 SIGKILL、PID 重用身份、取消清票、项目顺序、目录重叠；六个实际前台 CLI 进程共享四请求上限 | 六进程使用本地 HTTP fixture，不是六路真实外部模型压测 |

最终 macOS 类型检查、全量测试及构建通过：**844 pass / 2 skip / 0 fail，846 tests / 134 files**。Linux Ubuntu 24.04.4 ARM64、Bun 1.3.14，在 `TNB_REQUIRE_NATIVE_SANDBOX=1` 下类型检查、全量测试及构建通过：**839 pass / 7 skip / 0 fail，同 846 tests / 134 files**。macOS 跳过 Linux capability 与 Windows 测试；Linux 跳过 Windows 和六项 macOS Seatbelt 生命周期专用测试，Linux 原生隔离效果未跳过。既有 engine/waits 回归显式使用 v1 验证旧协议，新 v2 由 `durable-routing.test.ts` 独立覆盖。

macOS 一次完整复跑中，既有 Hook 配置文件监听测试出现预期日志未产生，结果为 843 pass / 2 skip / 1 fail；本轮没有修改该监听模块。独立复测 8/8 通过，再执行完整复测确认最终结果，原失败日志保存为 `routing-final-tests-hook-watch-failure.log`，不作已确定根因的归因。

真实 Magpie 验证仅允许 `group/free-models`，未改路由配置。首次 9 请求发现子调查自由文本报告不合协议，保留失败；增加结构化完成工具和最多两次修复后，复测 10 请求、3/3 场景通过。随后 macOS 15 请求、Linux 14 请求均 3/3 通过：实际委派/文件读取/父复核、在途 followup 最终同时包含原标记与补充标记、双暂停候选自动问答且选择后仍暂停。独立读取 SQLite 核对成功 read 的 settled 回执，不从模型文字猜测工具效果。本轮合计 **48 次真实请求**（含失败），实际成员均为 `workbuddy-ai/hy3`；这里不作收费或账单保证。两平台实测之后仅补充定向控制原文审计，由最终两平台完整回归及原文断言验证；不把这条新审计路径冒充新增真实模型实测。

真实跨版本升级使用 `d7cb45e` 旧二进制建立 schema v2、绑定能力并在物理请求中暂停，再由新版迁移 v3，原暂停 Task 接纳 followup 后恢复完成；Run/Task ID 与原 agent schema 能力指纹保持一致，实际成功读取文件。该测试使用三个本地 HTTP fixture 请求，不计入真实 Magpie 用量；未确认 usage 的原请求仍留 uncertain。旧包初次缺 bundled skill 资源属于验证夹具打包错误，更正为完整构建后通过，初始日志保留。

证据保存在仓库外 `/Volumes/data/tnb-review-2026-11-04/`：`routing-final-{typecheck,tests,build}.log`、两平台真实调用记录、跨版本 `routing-upgrade-2026-11-04T11-09-11-053Z/verification.json`、Linux 归档及最终汇总。失败、复测与成功记录均保留，不覆盖失败来制造通过率。

剩余边界：路由直接存有界原文，chat/query 不逐句落路由表；没有通用 DAG 重规划器。scope 为调查合同而非额外文件沙箱，父复核依赖模型与原验收。没有持久 Skill/MCP、并行子 Agent 写入或跨机器 owner。路由记录上限 10,000，当前 Run prune 不删除路由身份，尚无独立清理/撤销命令。多轮摘要、短流程与故障测试不证明真实数小时 soak 或语义无损；Linux x86_64、Windows 和其他发行版也不在本轮新增验证范围。
