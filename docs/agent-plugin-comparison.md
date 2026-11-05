# 领域插件：与 DeepSeek Harness、Pi 的源码比较及调整

本次基于本地源码，不把其他项目的能力直接归为 TNB 已有功能。Pi 快照为 `16f5f0af4d85ca583d045ceb5ed6d646fcaf7761`，DeepSeek Harness 为 `687f282e8625c6b8d11ff58211a90524be2e4317`。没有复制整套框架、引入 Cordis/jiti 或新增一套安装器；下面的实现由 TNB 自己维护。

## 比较结论

| 问题 | 源码依据 | TNB 采用的行为 |
| --- | --- | --- |
| 初始化一半失败是否留下注册 | Pi `createExtensionAPI` 暂存 runtime changes/unsubscribers；`initializeExtension` 成功才 commit，失败 discard | 一个插件的所有入口先暂存，声明、方法及重复身份全部检查后一次提交；任一入口失败全部回滚，逆序清理 |
| 谁拥有扩展产生的资源 | Pi loader 跟踪初始化订阅；DSH preset 将 mount 与 scope/generation 绑定 | factory 的 `onDispose` 归属于本次宿主 generation；关停先排空 Worker，再执行 disposer 并删除代码副本 |
| 已安装是否就能执行 | DSH inventory 分开 `enabled` 与 `fiberPhase`；TNB 原有安装/信任机制已存在 | 复用原安装、兼容性、启用和 trust store；可执行适配器必须 trusted，不能依赖 `not-required` |
| 加载失败是否可见 | DSH preset registry 保留 `broken` 诊断，inventory 暴露 failed | `host.plugins.list()` 分别返回 inactive/blocked/active/failed 等状态及错误；一个插件失败不阻塞独立插件，相关任务不能提交/恢复 |
| 升级时怎样处理使用中的实现 | DSH generation 记录 users/retired，用户归零后 collect | 当前宿主固定一代代码，适配器贡献强制 restart；先排空再释放。没有实现 DSH 的多 generation 热替换 |
| 任务重启能否换实现 | Pi 主要面向交互 session；DSH 上述 generation 管理的是活跃 scope。二者不是 TNB 持久业务回执协议的替代品 | 任务描述额外持久化插件 name/package version/tree SHA256；恢复精确匹配，不匹配暂停，不能按同名同版本静默替换 |

原始实现位置：

- [Pi extensions/loader.ts](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/extensions/loader.ts)：`createExtensionAPI`、`initializeExtension`；扩展工具、命令、事件 API 见同目录 `types.ts`。
- [DSH agent-preset-registry](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/preset/agent-preset-registry/src/index.ts)：`register`、`activate`、`retain`、`collect` 和 `broken`。
- [DSH plugin-inventory/types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/host/plugin-inventory/src/types.ts)：安装元数据、有效启用状态、Fiber phase。
- [DSH plugin-manager/types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/plugin-manager/src/types.ts)：兼容性与需要重启的管理结果。

这些参考解决了“扩展怎样装配及释放”，领域适配器另外解决“一个业务任务凭什么执行、验收和恢复”。Skill 提供说明，MCP 提供调用协议，插件负责交付代码；适配器提供 `snapshot/accept/reconcile` 和资源能力合同。这几个入口可以在同一包共存，不需要互相替代。

## 安装与声明

普通插件包增加 `contributes.adapters`：

```json
{
  "name": "company-research",
  "manifestVersion": 2,
  "apiVersion": "tnb.plugin/v1",
  "version": "1.0.0",
  "contributes": {
    "adapters": [{ "id": "research", "version": "1", "entry": "index.mjs" }]
  }
}
```

包版本必须符合既有 semver 校验。适配器版本是独立的合同版本。每包最多 32 项，每个适配器 `id/version` 唯一。Coding 现已作为领域插件接入，见 [Coding 插件架构](coding-plugin-architecture.md)。入口必须位于包内，使用打包后的 `.mjs`；多个适配器可以共享一个入口，该入口只初始化一次。入口用默认 factory 导出：

```ts
import type { AdapterPluginFactory } from "tnb/agent/runtime";

const setup: AdapterPluginFactory = api => {
  const client = createHostDocumentClient(); // 插件自己装配受信客户端
  api.onDispose(() => client.close());
  api.registerAdapter(createDocumentAdapter(client));
};
export default setup;
```

此处两个 create 函数由业务实现；完整可运行例子见 `examples/plugins/research/index.ts`。编译时将依赖一起打包，不依赖 TNB 的动态 TypeScript loader 或快照外的可变 node_modules。代码包和资源进入树指纹；凭据在宿主中取得，不写入任务描述或快照包。

继续使用原命令 `tnb plugins install ./package`、`show`、`enable/disable`、`trust/untrust`、`update/remove`。安装器不执行适配器入口。已审核的内容指纹信任与启用都满足，且宿主配置了领域插件加载，才会导入执行。普通 Coding CLI 会识别清单，但本轮没有把非编码任务自动接到 `/task`，也没有自动从用户文字选择领域插件。

## 宿主调用与验证

```ts
import { openAgentRuntime } from "tnb/agent/runtime";
import { researchTask } from "tnb/adapters/research";

const host = await openAgentRuntime({
  directory: "/private/agent-state",
  plugins: {
    roots: [{ directory: "/home/me/.tnb/plugins", source: "user" }],
    trustStorePath: "/home/me/.tnb/plugin-trust.json",
    enabled: { "company-research": true },
  },
});
console.log(host.plugins.list());
const { run } = await host.submit({
  commandId: "business-request-123", namespace: "team/research",
  objective: "比较资料并提供实际引用", adapter: researchTask(["docs/design"]),
  mode: "auto",
});
// 适配器来源由受信宿主补入描述，不由模型自行选择或修改。
console.log(host.runtime.configuration(run.runId).domain?.plugin);
await host.close(); // 应用退出时调用；提交本身不会等待任务完成。
```

`adapters` 代码注册仍支持，与插件注册发生相同 `id/version` 冲突时拒绝该插件，不能覆盖宿主实现。同身份的多个插件不支持优先级覆盖。初始化 API 只在所属 factory 执行期间有效，成功或失败后都封闭；不能用延迟回调或另一个入口重新注册。适配器方法在注册时绑定，但业务对象内部状态仍由受信代码负责。

执行 `bun run agent:plugin-demo` 可以完成编译、使用原安装服务安装、本例显式信任、加载、真实资料工具调用、持久回执与验收。模型明确为离线脚本，不调用外部服务。输出 `directory` 后再次运行 `bun run agent:plugin-demo DIRECTORY`，复用同一 Run/Task。示例只在首次安装仓库自带代码时记录信任；后续修改不会自动重新信任。

## 代码绑定与恢复流程

1. 宿主先持有 owner 锁，再清理上次崩溃留下的私有代码副本、发现清单和检查 trust；双 owner 被拒绝时不导入代码。
2. 对已信任包重新计算指纹，复制到宿主 `plugin-snapshots/` 下的私有目录；复制后重算相同指纹，才从副本导入，初始化后再核对。符号链接和包外入口拒绝。
3. 每包所有 factory/注册成功后才发布。失败时逆序清理，所有 disposer 都尝试执行，错误留在 inventory；不能依赖回滚撤销任意已发生的远端副作用，初始化应只建立可释放的连接和注册。
4. 新提交由 registry 补上 `{name, version, fingerprint}`，随 configuration 持久化。子任务沿原配置继承来源。恢复只调用精确 resolve，不会把旧的 inline 任务自动改成插件，也不把插件任务降级到 inline。
5. 包被更新、禁用、撤销信任或删除，当前宿主已加载的副本和 registry 保持原代；重启时重新检查。实现缺失或指纹不同的活跃 Run 暂停，resume 拒绝；需要恢复原受信字节，或显式建立新任务。本轮没有自动迁移，也没有持久保存所有历史插件包。
6. 关闭先停止准入并等待 Worker/工具退出，再逆序 dispose、删除代码副本、关闭数据库，最后释放 owner。并发 `close` 共用同一完成 Promise；即使 disposer 失败，也执行剩余清理并释放锁，调用方收到异常。

撤销信任不是对已导入 JavaScript 的强制隔离或卸载。发现问题时应停止宿主，之后重启不会再激活它。私有副本保证本代读取包内资源时不受原目录升级影响，不对包外依赖、外部服务状态或插件行为提供完整性证明。插件内代码仍具备宿主进程权限；需要执行不受信业务代码时，应另做进程/容器隔离，本实现没有声称提供该能力。

## 当前边界与后续取舍

Pi 的交互事件、命令、快捷键、渲染器 API 更完整，DSH 的作用域依赖与 preset 动态组合更完整。插件初始化暴露 `registerAdapter/onDispose/identity`，并可接收宿主状态目录及显式瞬时配置；适配器另提供受信 DomainRuntimePolicy，不为“通用插件”开放任意 runtime 状态修改钩子。预算、授权、checkpoint、调度、回执与结果提交继续由原运行时负责。插件 inventory 为当前宿主内存视图；任务来源和恢复事实持久化在原 configuration/事件日志，不把 inventory 当作任务事实。

没有新增多 generation 热升级、历史包自动保留与垃圾回收、分布式 owner、任意不受信插件沙箱或自动任务迁移。若需要不停机升级，应先增加 generation 引用与历史包存储，解决活动任务如何 pin、旧包如何撤销和保留，再开放热替换；目前重启并明确暂停不匹配任务更容易核验。
