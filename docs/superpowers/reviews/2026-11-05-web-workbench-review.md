# 网页工作台实现审阅

范围：按工作目录授权的 TaskService、统一接口插件/安装包、独立本机 HTTP listener、浏览器认证、实时问答、命令/版本与重试、退出资源和平台范围。此次为实现者源码审阅与自动化/真实浏览器验证，没有调用其他审阅 Agent。

## 已处理的问题

1. 浏览器入口不能成为私有 RPC 的透明反向代理。新增受限 `tnb.tasks/v1`，逐个动作白名单字段；提交的 cwd、roots、source、adapter、configuration 由宿主决定，跨目录 read/control 拒绝。模型目录只投影 provider/model 的公开名称和 ID。
2. 扩展入口本身是串行私有 RPC。若在扩展 POST handler 中调用私有 mutation 会产生重入等待。插件 IPC handler 仅处理 launch/status；浏览器 mutation 经独立 HTTP listener 调用原串行命令，测试完成同一 Run 的提交、幂等重试、回答和恢复。
3. 多工作目录若共用一个 cookie 范围，新登录会覆盖另一个目录的身份。改为 workspace digest URL 前缀和 cookie path，服务端再次匹配 session scope，不能通过改 URL/字段取得另一个目录的任务。
4. 不把后台 control key 或 provider credential 交给网页。单次 60 秒 fragment 码换取 HttpOnly/SameSite cookie，立即清除 fragment；所有 POST 要求精确 Origin 和 JSON，Host/Fetch Metadata 校验与 CSP 独立存在。恶意报告 `<script>` 在真实浏览器中保持纯文本。
5. 网络请求结果未知时，换 commandId 会生成第二个 Run。网页持久化原请求并明确提供重试；真实浏览器拦截了“服务已提交、响应被丢弃”的请求，再次提交只存在同一 Run。命令处理中禁用变更控件，避免连续点击被 busy guard 静默丢弃。
6. 问答提醒不能覆盖正在输入的内容。关注栏/标题/通知实时更新；无编辑对话框时主动打开问答，已经展示后用户延后不反复强制弹出。提交、模型选择、追加要求和回答草稿按目录恢复，成功回答清理原草稿。
7. 不能让隐藏的验收字段继续执行。取消写入选择后 UI 提交空检查列表；Shell 选择和写入选择联动，权限最后仍由 Coding adapter/runtime 验证。
8. 二次包装 SSE body 的 reader 会在 Bun 1.3.14 的取消/stop 交界拖住 listener。复用原 attention response body，增加 close 回调清理流配额；退出先撤销信号，再让关闭通知进入 HTTP 传输阶段后 join stop。并发实时流上限、断开释放、注销、owner 关闭和重启都有回归。
9. 不能让新 UI 自动重启老服务。CLI 检查 owner 的 web capability，旧版本给出明确 restart 指引；正常 launch 不重启活跃 owner。禁用/未信任的同名安装包不回退到内置网页；独立安装包沿现有信任、服务 grant 和生命周期工作。

## 验证证据

- macOS：1024 pass / 2 skip / 0 fail，1026 tests / 155 files；typecheck/build 通过。
- Ubuntu 24.04 ARM64：1019 pass / 7 skip / 0 fail，1026 tests / 155 files；typecheck/build 通过，启用原生沙箱要求。
- macOS/Linux 编译后 CLI：自动拉起持久 owner，通过 HTTP 工作台提交同一命令两次，仅 1 个 Run；真实 read 工具、本地脚本模型、实时问题推送/回答后完成，共 3 次模型请求；停止后确认 owner lock 已释放。
- Chromium 真实浏览器：提交、模型/任务草稿刷新恢复、主动问答、离线重连、回答与报告、XSS 文本惰性、响应丢失后的同命令重试、手机布局、暂停、暂停时回答、额度调整保持暂停、恢复、取消、退出通过。共创建 3 个 Run，含一次提交响应丢失重试。
- 定向验证：工作目录隔离、越权字段、provider/key 不泄漏、Origin/Host、链接重放/过期、会话过期、实时流配额/释放、独立安装/未信任/禁用/回收。
- 本地证据：`/Volumes/data/tnb-review-2026-11-05/web-workbench/`，含 browser-test.log、desktop.png、mobile.png、编译后启动探测与平台日志。
- 所有模型使用本地脚本替身，没有调用真实收费模型、发送实际渠道消息或连接外部 MCP。

## 实际边界

工作台是本机单用户界面，不提供公网监听、远程多用户身份、角色/租户隔离或跨主机登录。完整 owner 沿用 macOS/Linux 支持范围；Windows 的 HTTP/session/插件合同测试不等于完整 owner 可用。首次打开链接必须在 60 秒内，会话 8 小时到期；重启后重新 launch，任务事实按原协议恢复。

网页创建表单目前面向 Coding；其他业务仍通过 domain adapter/API 接入。现有 TUI 尚未整体迁入接口插件。新工作台不改变旧 Run 的插件代际约束，缺失原代际时仍需明确恢复/迁移，不能宣传跨版本无条件续跑。
