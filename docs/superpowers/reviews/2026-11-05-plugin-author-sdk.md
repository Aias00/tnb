# 独立插件作者 SDK 审阅

审阅对象为[规格](../specs/2026-11-05-plugin-author-sdk.md)及[操作指南](../../guides/plugin-sdk.md)。本轮由实现者审阅，未委派其他 Agent。

作者入口与宿主入口分开：作者获得 factory、领域/模型/工具/扩展类型和三个帮助函数，owner、存储、服务提供者和业务组合留在宿主。definePlugin 只保留 factory 的上下文类型，实际注册、准入、权限和生命周期继续由原宿主实现校验。

SDK 的 JavaScript 从正式帮助函数构建。类型化 ServiceRef 的定义和校验抽离到无宿主实例的公共模块，原 services 导出保持兼容；SDK 不再打包未使用的服务 Registry。类型声明用固定工具从源码生成，完整检查后验证没有 import、动态类型 import、外部 reference 或 Bun/RuntimeStore/DurableRuntime。生成的本地 tarball 没有运行时依赖和安装脚本。

模板使用真实 SDK 类型：领域 Worker 返回值、配置 JSON 收窄、状态记录泛型和渠道参数都通过严格编译。项目默认无需全局 Bun/Node 类型，编译脚本单独由 Bun 执行。正式 `package/` 只含 bundled ESM、manifest 和测试场景；先移除旧输出，再暂存发布，构建失败不会留下可误用的旧清单。

5 项独立 SDK 集成测试实际打包、安装 tarball，覆盖三类模板类型检查、故意错参报错、打包、删除开发 node_modules 后宿主试跑、失败构建清除旧包和缺 SDK 时不留半成品。测试在不可用注册表下仅安装本地 SDK，编译器取已有 PATH，以证明没有隐藏的 SDK 网络/类型依赖；普通生成项目也已通过实际安装编译器后的完整流程。SDK 与既有接入、服务专项合计 38 项通过、0 失败。

编译版 CLI 从自身目录定位 tarball，在三个仓库外项目完成 init、正常依赖安装和 `bun run check`，没有建立用户配置目录。本机直连注册表曾出现连接失败，使用已配置代理完成了正常安装流程；不据此把 TypeScript 编译器下载表述为离线可用。没有调用付费模型或外部业务服务。

macOS 开启 `TNB_REQUIRE_NATIVE_SANDBOX=1` 的最终完整回归为 接入远端执行宿主整合后的 1231 项通过、3 项跳过、0 失败，176 个文件、5246 次断言。类型检查、完整构建、62 处本地文档链接及 `git diff --check` 通过；远端平台结果以对应提交 CI 为准。Windows 同样执行 SDK 独立打包/编译测试，Agent 任务执行的既有平台边界没有放宽。日志保存在 `/Volumes/data/tnb-review-2026-11-05/plugin-sdk-*.log`。

尚未发布到 npm；单独二进制分发没有 SDK 时须显式提供 tarball。项目本地 file: 依赖移机需重新提供路径，生产模型和服务仍由业务接入。类型检查不证明远端服务、业务验收或旧状态恢复已就绪。
