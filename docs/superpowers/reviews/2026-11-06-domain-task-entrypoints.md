# 业务任务入口实现自审

对应[方案](../plans/2026-11-06-domain-task-entrypoints.md)。本轮把已经注册的领域插件接入默认产品 Owner、CLI 和对话命令，保留原 Coding 默认行为，不新增一套执行器。

## 实现

- `DomainRegistry.catalog()` 固定当前注册元数据，返回身份和可选配置 Schema 的副本；不把保留代际当作新任务候选。`defineAgent` 的 Schema 自动暴露，旧 Adapter 仍可没有该元数据。
- `runtime adapters` / `GET /adapters` 读取真实 Owner；`submit --adapter task.json --namespace NAME` / `POST /agent-tasks` 复用 `submitDomain`、资源与能力收窄、验收、日志、预算和恢复。
- CLI 在启动 Owner 前读取有界 UTF-8 JSON 并校验参数；服务端再次校验。不能混入 Coding 参数，领域专用入口也不能通过宿主 normalize 改变逻辑范围或启用 Coding 标志。
- `list/followup/routing --namespace` 及 `/runtime`、`/task` 使用相同范围语义；未指定 Run ID 的 `/task` 控制在选定范围内选择，不对逻辑命名空间调用 realpath。
- Agent JS/TS 模板生成 `task.json`，TS 构建复制描述到包。源码、独立 tarball 项目和编译 CLI 验证覆盖实际产品服务。

## 审阅中处理的关键问题

1. 新任务候选与旧回执读取不同。不能在幂等回执读取前用当前 catalog 拦截所有请求，否则升级/停用后会破坏精确重试。当前在回执重放之后执行领域入口约束；新任务仍经原代际固定规则拒绝历史代码。
2. Namespace 与文件目录保持不同语义。文件范围继续 canonical realpath；领域范围映射到 `agent:<namespace>`。追加要求保留路由的 accepted/clarify/rejected 回执，跨范围不能写入目标任务。
3. 旧 Owner 不支持新接口时，CLI 明确要求更新并显式重启，不退回 Coding，也不重启正在工作的服务。catalog 读取不会自动拉起 Owner。
4. 会话默认文件目录不能注入领域提交；描述相对当前会话工作目录解析。来源会话单独记录，不作为文件/工具权限。重复 config-dir 不再由对话包装层产生。
5. 编译 CLI 启动后台 Owner 使用私有构建身份判断执行模式，避免依赖某一种虚拟文件路径。编译冒烟真实执行启动、目录发现、提交、验收、回执重放、结果读取和关闭。
6. 原模板文件集合断言同步增加 Agent 专属 task.json，保持其他模板文件集合不变；首次全套回归仅此旧期望失败，定向修正后重新跑全套，不跳过用例。

## 验证范围

集成测试使用临时安装/信任/配置与离线模型，覆盖认证、非法能力/参数/配置、命名空间隔离、暂停后追加、未决问题通知、Owner 重启与回答、精确幂等、升级/停用、历史指纹拒绝和旧 Owner 协商。测试读取真实默认 profile，没有伪造 SDK 宿主来替代产品入口。

macOS/Linux 完整产品与恢复执行纳入全套和编译产物验证；Windows 运行类型、SDK 模板和 CLI 前置校验，Agent 完整运行仍受现有 POSIX 产物持久化屏障限制。最终精确提交的三平台 CI 为交付依据。

本机 macOS：**1347 pass、3 skip、0 fail，6007 assertions，200 files**（`TNB_REQUIRE_NATIVE_SANDBOX=1`）；类型检查、完整构建、编译 CLI 真实后台业务执行与回执重放通过。77 处本地文档链接及 diff 格式检查通过。测试均使用临时配置与离线模型，没有修改个人插件、Owner 或真实 Source。

## 边界

- 当前是显式选择业务；未建设自动业务路由或任意模型/服务自动注入。
- Namespace 是同一宿主内的业务范围，不是多租户鉴权。私有控制接口仍由本机用户持有；未开放公网服务。
- 默认终端/Web Coding 工作台没有业务范围切换，业务客户端需明确订阅相应通知范围。通知 API 与恢复已验证，不宣称所有界面自动显示业务任务。
- 模板离线模型证明接入与协议，不证明生产模型语义质量。既有包的自定义服务/凭据仍需实际宿主提供，不会为运行示例伪造生产依赖。
