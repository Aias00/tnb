# 本地网页工作台插件

前置：插件宿主和持久 skills/MCP 已合入 main。下一步交付可直接启动使用的本机网页交互，沿用同一持久 owner、任务数据库和执行协议。

## 组成

- `tnb-web` 注册 `interface:web@1`，由统一插件宿主加载、信任、固定代际、禁用和回收，同时提供独立可安装发行包。
- 新增宿主服务 `tnb.tasks/v1`：按 canonical workspace 打开任务视图，提供模型目录的公开字段、任务状态/报告/事件、attention 流和受限任务命令。接口插件不获得 Runtime、SQLite、env 或控制 key。
- 所有变更最终回到现有私有 RPC 的串行命令处理、idempotency receipt、revision 和预算/恢复约束。网页不创建第二套任务执行器或状态机。
- `tnb web [--cwd PATH] [--port N]` 按需启动原 owner，再通过认证 IPC 请求插件 launch。默认随机本机端口；不重启正在执行的任务，不修改全局配置，不自动注册开机服务。

## 浏览器会话

只有 launch 才建立 127.0.0.1 HTTP listener。CLI 输出带短期单次授权码的 fragment URL，浏览器立即清除 fragment，再经同源 POST 换取 HttpOnly、SameSite=Strict 的短期 cookie。授权码不是 runtime key。每个 workspace 使用独立 URL 前缀和 cookie path，多目录页面不会覆盖彼此授权。

HTTP 拒绝不匹配的 Host/Origin 和跨站 Fetch Metadata；所有 mutation 必须有精确 Origin 与 JSON Content-Type。不提供 CORS，CSP 禁止外部脚本、内联脚本和嵌入。任务、模型输出、问题和路径通过 textContent 显示。URL、页面、脚本和 API 响应都不包含 provider credentials、runtime key 或任意配置文件内容。

启动码有 60 秒有效期且只能使用一次，会话 8 小时到期，工作区/启动码/会话数设上限。刷新保留同工作区会话；退出会撤销会话及其 attention 流。owner 重启时 listener/会话失效，任务继续按原恢复协议保存，重新运行 `tnb web` 获取新入口。仅提供本机单用户工作台，不冒充远程多用户登录系统。

## 产品范围

展示工作区任务列表、执行阶段、费用与请求用量、子任务树、已验收报告、检查结果、变更预览和待核对操作。提交 Coding 任务可选模型、single/auto/multi、写入/Shell/检查、预算、skill/MCP 明确选择；附加要求、暂停/恢复/取消、版本化问答、调整已暂停任务额度以及副作用核对使用原命令。

复用 authoritative attention SSE：连接即发送当前问题与状态，断线重连不会依赖丢失的 cursor；页面自动提醒新问题，保留正在编辑的草稿，可由用户点击开启系统桌面提醒。回答不扩权，不自动恢复暂停的 Run。完成通知在用户确认后持久 ack。

提交和控制请求生成固定 commandId；网络结果未知时保留原请求并提供重试，不能生成另一个同目标任务。工作目录由 CLI launch 固定，网页不能提供新 cwd、额外 roots、source identity、任意 adapter 或宿主配置。来源路由问题按原记录的 workspace/session/revision 解决。

现有 owner/coordinator 使用 POSIX 权限及 Unix socket，本轮完整后台工作台支持 macOS/Linux；Windows 可以运行 HTTP/插件合同的便携测试，不宣传完整 owner 可用。终端现有 TUI 的整体插件迁移另行完成，不把网页实现等同于已经迁移所有界面。

## 验收与审阅

临时配置、本地模型/stdio fixture 验证真实提交→问题推送→回答→验收、重复命令、重启后原 Run 读取、多目录隔离、模型凭据不泄漏、越权字段、Origin/Host、token/cookie 过期/重放、注销流关闭和插件停用/排空。使用真实浏览器验证表单、自动提醒、草稿、重连和响应式页面。完成源码审阅、typecheck/build、macOS/Linux 全量回归与编译后启动探测后直接推送 main。
