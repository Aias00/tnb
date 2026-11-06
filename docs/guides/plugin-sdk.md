# 插件 SDK 与 TypeScript 开发

TNB 现在随构建产物提供独立 `@tnb/plugin-sdk` 包。作者统一从这个入口导入，无需依赖宿主内部目录。SDK 包含 `index.js`、从宿主真实接口生成的 `index.d.ts`、说明及许可证，没有运行时依赖，不拉起宿主、SQLite、Coding 或界面模块。

目前交付本地目录和 `.tgz`，尚未发布到 npm；不要直接假定注册表中的同名包就是此 SDK。完整 TNB 分发目录包含 SDK，单独复制 CLI 可执行文件时需通过 `--sdk` 指定本地 tarball。

## 创建有类型提示的项目

```sh
tnb plugins init ./my-app --template application --language typescript
cd my-app
bun install --ignore-scripts
bun run check
```

三种 `agent|application|channel` 模板都支持 TypeScript。默认仍是原来的免构建 JavaScript 模板，方便快速试验。TypeScript 模板会自动查找 CLI 同目录的 `tnb-plugin-sdk-<version>.tgz`；也可显式指定：

```sh
tnb plugins init ./my-agent --language typescript --sdk /absolute/path/tnb-plugin-sdk-0.1.0.tgz
```

SDK tarball 是本地开发依赖；项目移动到其他机器时，重新提供 tarball 并更新 `package.json` 的 `file:` 路径。创建命令只生成文件，不自动下载依赖或运行项目脚本。`bun install` 安装本地 SDK 和模板中固定的 TypeScript 编译器，需要编译器下载时须有可用注册表连接；无模型 API Key 要求。

项目包含 `src/index.ts`、manifest、测试场景、严格 `tsconfig.json`、`scripts/build.ts` 和 package scripts。执行顺序如下：

| 脚本 | 验证内容 |
| --- | --- |
| `bun run typecheck` | 严格检查作者代码与完整 SDK 声明，`skipLibCheck: false`，不依赖 Bun/Node 的全局类型 |
| `bun run build` | 用 Bun 打包源码与 SDK 到 `package/index.mjs`，复制清单和测试文件 |
| `bun run validate` | 用当前 CLI 的真实 parser 校验 `package/` |
| `bun run test` | 在临时宿主中执行明确的业务场景 |
| `bun run check` | 顺序执行以上四步，任一步失败就停止 |

运行 validate/test 需把 TNB CLI 放在 PATH。构建过程需要 Bun；这里只对插件运行时源码 `src` 做 TypeScript 检查，构建脚本由 Bun 执行。Node 专属 API、Bun 专属 API 的业务插件可以按需显式增加相应类型依赖，不由 SDK 隐式带入。

构建删除上次输出，在暂存目录完成打包和清单复制后发布 `package/`。构建失败不会留下可误安装的旧包。只把 `package/` 安装进宿主；源码、编译器和开发 `node_modules` 无需一起交付。业务额外的运行资源需自行纳入构建，当前模板只复制实现、manifest 和测试文件。

## 统一作者 API

```ts
import { definePlugin, type HostPluginFactory } from "@tnb/plugin-sdk";

const setup: HostPluginFactory = api => {
  api.registerApplication({
    id: "my-app",
    version: "1",
    start(context) {
      return {
        handle: () => Response.json({ ready: true }),
      };
    },
  });
};

export default definePlugin(setup);
```

`definePlugin` 保留工厂及上下文类型，不引入第二套注册或生命周期。清单仍需声明相同贡献；类型检查不代替真实注册校验。

| 导出 | 用途 |
| --- | --- |
| `definePlugin`、`HostPluginFactory`、`HostPluginAPI` | 定义插件工厂及四类贡献注册 |
| `defineTool`、`AgentTool`、工具能力/副作用类型 | 构造领域工具，声明资源与重放合同 |
| `createServiceRef`、`ServiceRef` | 定义和消费类型化服务引用；不会替宿主提供或授予服务 |
| Adapter、Domain、Worker、Model 类型 | 自定义领域、模型传输、工具与验收 |
| Application、Interface、Channel、ExtensionContext 类型 | 应用处理器、渠道、私有状态与清理 |
| 配置 Schema、记录迁移和 JSON 类型 | 声明配置/状态合同 |

作者入口不包含 `openAgentRuntime` 或服务提供者管理。业务宿主继续从 `tnb/agent/runtime`、`tnb/agent/services` 组装；作者包与宿主 SDK 职责分别明确。原公开入口保留兼容。

SDK 包版本跟随交付宿主版本；真正的执行兼容性仍由 `manifestVersion`、`apiVersion`、宿主兼容范围和贡献版本决定。SDK 安装或编译成功不自动授信、增加权限或把新实现切换进旧任务。

## 在源码仓库生成交付包

```sh
bun install --frozen-lockfile --ignore-scripts
bun run sdk:setup
bun run sdk:build
# 或完整构建：bun run build
```

输出为 `dist/plugin-sdk/` 和 `dist/tnb-plugin-sdk-<version>.tgz`。SDK 声明工具使用单独的锁文件与固定 TypeScript 版本，避免替换宿主原有的编译器。构建从源码生成声明并检查声明不能引用宿主内部模块或外部类型包，再创建实际 tarball；没有执行 npm 发布。

验证使用独立临时项目安装 tarball，在注册表不可用时仅安装本地 SDK，以现有编译器检查三种模板，故意写错注册参数确认报错，再删除 `node_modules` 验证产物实际可加载。普通作者流程另验证了正常安装编译器后的 `bun run check`。平台范围沿用[快速开始](plugin-quickstart.md)：Windows 验证所有模板类型/构建及应用/渠道运行；Agent 完整任务运行仍限 macOS/Linux。
