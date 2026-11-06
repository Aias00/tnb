# 独立插件作者 SDK

目标是让插件作者在独立项目中获得统一导入、类型提示、标准构建和真实接入验证，不要求安装宿主全量源码或依赖。

1. 统一作者入口 `@tnb/plugin-sdk`，源码对应 `tnb/plugin-sdk`。提供 definePlugin、defineTool、createServiceRef 与真实工厂/领域/模型/工具/扩展合同类型；不提供 owner、SQLite、服务提供者管理或默认业务组合。
2. 运行时代码只包含作者帮助函数，不启动或实例化宿主。声明从当前宿主接口生成，不能手抄另一套放宽的接口；声明独立可用，无宿主内部路径或外部类型包导入，严格检查不依赖 skipLibCheck。
3. 生成标准包目录和带 license/exports/types 的 `.tgz`，随完整 CLI 分发目录交付。构建不执行注册表发布。SDK 包版本跟随宿主，执行兼容仍由 manifest/API/贡献合同决定。
4. `plugins init --language typescript` 适用于 Agent、应用/界面和渠道。生成严格 tsconfig、源码、SDK 本地开发依赖、build/typecheck/validate/test/check 脚本。CLI 自动从自身目录找到同版 tarball；也可 `--sdk` 显式指定。缺少 SDK 时，在创建目标前拒绝并给出操作建议。
5. 构建把 SDK 和源码打包为单一 `.mjs`，先删除旧包，在暂存目录完成内容和清单后发布 `package/`；失败不能留下可误安装的旧包。发布产物不需开发 node_modules。业务额外资源仍需作者纳入自己的构建。
6. 原 JavaScript 模板保留免构建路径，原公开宿主 API 保留兼容。脚手架只写文件，不自动安装依赖、授信或修改正式宿主配置。
7. 声明工具及其固定 TypeScript 版本置于独立、锁定的构建依赖目录，不替换宿主现有编译器。CI 先准备这些工具，实际打包生成声明并检查其闭包。
8. 用真实 tarball 安装到仓库外项目验证类型推导；错误注册参数必须报错，删除 node_modules 后打包产物仍须通过实际宿主验证。Windows 检查所有模板类型/构建及应用/渠道执行，Agent 完整任务执行沿原 macOS/Linux 支持边界。

本阶段不发布 npm、不增加任意领域默认提交路由、不隐式提供模型供应商或业务服务。完整自定义宿主仍通过原 SDK 组合。操作见[作者 SDK 指南](../../guides/plugin-sdk.md)。
