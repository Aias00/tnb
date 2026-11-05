# 持久 skills/MCP 实现审阅

审阅范围：Coding 插件能力装配、任务描述符与资源权限、CLI/对话交接、MCP 连接与 replay、安装包资源、恢复与验收边界。此次为实现者源码审阅及自动化验证，没有调用另一位审阅 Agent。

## 已发现并处理

1. 文件工具曾把整个 descriptor 的所有资源作为 workspace 能力的范围。增加 skill/MCP 资源后，`selectDomainTools` 会正确拒绝这个过宽声明，表现为 read 工具消失。修复为只声明当前 `workspace:<canonical path>`；安装式 Coding 插件真实模型/文件传输回归覆盖。
2. MCP 原始工具的 `bindExecution` 会返回原始包装，丢失新增的 durable capability/effects 与目录冻结检查。先固定一次原始执行 revision，再移除二次 bind，保留外层受权包装；测试断言外层不再被替换，list_changed 后不产生第二次外部调用。
3. 子配置与父配置按字段合并，省略 skills/MCP 并不代表清除。Coding delegation 显式返回空选择和空 pins；测试验证合并后无额外权限。
4. 新的 skill 依赖会在安装式插件 import 时提前寻找内置资源。改成实际加载 skill 时才解析目录，并让独立 Coding 发行包包含 bundled 资源；安装式插件带 skill 的真实读取流程通过。
5. stdio 默认继承宿主所有环境。持久 worker 显式提供最小基础环境，普通对话行为兼容；fixture 同时验证真实进程环境中的未授权变量被去掉和显式服务器变量可用。
6. MCP 初始化可能正在等待响应时被取消。manager 新增可选 AbortSignal，取消会关闭已有客户端，错误/正常关闭移除 listener；初始化挂起场景有专门回归。

7. MCP manager 的工具数组还包含客户端生成的资源读取辅助工具，不能把它当成服务器原始 tools 白名单。新增普通工具投影，durable 只从该投影选择；同名资源辅助工具不会获得原始工具的授权。

## 校验结果

- macOS：1015 pass / 2 skip / 0 fail，1017 tests / 153 files。
- Ubuntu 24.04 ARM64：1010 pass / 7 skip / 0 fail，1017 tests / 153 files；启用原生沙箱要求。
- 两端 typecheck/build 通过。
- macOS 与 Linux 编译后 CLI 使用独立临时配置、本地脚本模型和真实 stdio MCP 完成提交→skill→MCP→报告→验收：3 次模型调用、1 次 MCP 调用、Run succeeded。
- 所有外部系统均由本地 fixture 替代，没有使用真实模型、实际消息或外部 MCP 服务。
- Windows 工作流加入 MCP manager 和本轮 durable capability 集成测试；平台 CI 结果以 PR checks 为准。

本地证据目录：`/Volumes/data/tnb-review-2026-11-04/durable-capabilities/`。

## 当前限制

- 指令型 skill 支持不代表 fork/model/hooks 的持久化执行。`allowed-tools` 在任务级取交集；恢复需要匹配原内容，未实现 skill 目录归档迁移。
- MCP 配置在提交时 pin；工具 schema/description 在首次 admission 时 pin。未验证服务器代码或远程数据不会变化，不宣称配置摘要等于服务行为身份。
- 默认 unsafe 的不确定结果会暂停，需要人工证据核对。`safe` 是宿主显式策略，不根据 server annotations 猜测。
- stdio MCP 是宿主信任的外部进程，不能宣传成 Shell 沙箱内部工具。服务端主动返回的秘密仍可能进入 transcript。
- Coding adapter 原有报告/checks 验收不等于所有外部业务效果的验收。新的业务应实现独立 domain adapter。
- 本轮没有实现 Web 工作台、全局连接池、跨机器技能迁移或子 Agent 的 MCP 传递。
