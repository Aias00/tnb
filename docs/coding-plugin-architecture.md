# Coding 领域插件

Coding 与 Research 现在通过同一个 DomainRegistry 和插件注册事务执行持久任务。公共执行器 `src/services/runtime/engine-core.ts` 不导入 Coding 工具、模型配置或沙箱组合。旧 `engine.ts` 是兼容装配：把历史 worker factory 转为 Coding adapter，再调用公共执行器。

## 使用

原有 `/task`、对话式持久任务、`tnb runtime submit` 继续使用。后台在 owner 锁内加载 `tnb-coding`，将 workspace/write/shell/check 参数规范化为持久领域合同。

```sh
tnb runtime submit "检查项目" --mode single
tnb runtime submit "实现修改" --allow-write --check "bun test"
tnb runtime plugins
```

`tnb runtime plugins` 或 `/runtime plugins` 查看后台实际加载的 generation；普通 `/plugins` 查看安装目录清单。默认 Coding 作为内置插件随宿主交付，通过相同注册事务加载。内置信任来自宿主产品组合，用户清单不能自行取得 builtin 身份。

构建会输出独立包 `dist/plugins/tnb-coding/{plugin.json,index.mjs}`：

```sh
tnb plugins install /absolute/path/to/dist/plugins/tnb-coding
tnb runtime restart
tnb runtime plugins
```

沿现有安装/信任机制执行；直接复制的包仍需审核并 trust。已安装的 `tnb-coding` 占用该名称：未受信任、清单错误、加载失败时，不回退内置实现。包由宿主明确传入配置目录、状态目录及瞬时环境，不把凭据存入任务。

```sh
tnb plugins disable tnb-coding
tnb runtime restart
tnb plugins enable tnb-coding
tnb runtime restart
```

禁用控制持久 Coding 插件；前台普通会话的文件工具装配仍在 CLI，没有宣称所有 CLI/TUI 功能均已插件化。插件更新、禁用或撤销信任在后台重启时生效，没有热升级或自动领域选择。

## 模块边界

| 模块 | 责任 |
| --- | --- |
| `agent/index.ts` | 独立 AgentLoop、工具执行、授权、消息和日志 |
| `runtime/engine-core.ts` | Run/Task/Attempt 状态流转、调度、预算、上下文、回执、等待、结果提交 |
| `agent/domain.ts` | 版本/来源注册、能力筛选与受信宿主策略 |
| `agent/plugins.ts` | 内置和安装包的事务初始化、信任、诊断、逆序清理 |
| `adapters/coding/adapter.ts` | Coding 配置、快照、工具能力、工作区租约、子任务范围、验收 |
| `adapters/coding/worker.ts` | 原文件工具、权限规则、provider transport、原生 Shell 沙箱组合 |
| `adapters/coding/plugin.ts` | 内置贡献和独立包默认入口 |
| `runtime/server.ts` | 默认产品组合、认证 Unix IPC 与后台生命周期 |

`DomainRuntimePolicy` 让受信插件提供配置规范化、额外准入、委派配置、指令/合同、快照摘要和验收策略。状态写入仍归 runtime commands。每个领域先获取公共精确资源租约；插件 `acquire` 只能增加额外资源约束，不能绕过公共准入。失败、等待、暂停和关闭释放相应租约。

Coding 使用原同用户工作区协调器，保留父子路径互斥、前后台互斥、同 Run 只读任务共享物理租约，最后读取者退出后才释放。验证命令即使在只读任务中也使用排他资源租约。不能用精确 workspace 字符串匹配替代重叠路径协调。

文件工具归类为 workspace.read/write/execute；模型只看到被授予的能力，每次执行仍经过原权限规则和绑定检查。读操作可安全重放，写/Shell 默认不重放。Coding 委派校验实际路径及授权工作区，重建只读子合同，不继承 write、Shell、check；公共引擎再校验来源一致和只读能力。

验收继续调用真实 Worker check，保留显式命令授权、原生沙箱和验收前后文件快照核对；通过后为 `verification-commands`。无命令的只读报告为 `report-delivered`，不伪装成代码测试通过。Research 等领域默认仍需至少一项真实检查，结果为 `domain-verified`。

## 恢复与代码身份

新 Coding 任务持久保存领域合同和插件身份。安装包使用完整包树指纹；内置包对全部 src、package.json、bun.lock、Bun 版本、平台和架构计算指纹，编译时嵌入程序。该范围保守，非 Coding 代码更新也可能暂停活跃任务；没有用固定版本号掩盖替换。

兼容配置里的 workspace/write/shell/check 字段仍保留，领域政策也能读取这份宿主配置；本轮没有进行数据库大迁移。边界检查针对公共执行器的运行时依赖，不把 TypeScript 类型引用或兼容 API 的存在说成全部数据模型已通用化。

指纹不同、插件缺失/禁用/不受信任，活跃任务暂停且 resume 拒绝。内置与独立包来源不同，不自动迁移进行中的任务。旧无 domain 配置由宿主明确选定的 legacy adapter 接管，不批量改写原配置；原工作区摘要、旧 binding 和 checkpoint 继续核对。旧请求重试仅在历史命令摘要完全匹配时返回旧回执，同 commandId 改目标仍拒绝。不能验证的能力变更继续保守暂停。

关停先停止准入、排空 Worker、释放任务资源，再释放插件、关闭数据库、释放 owner；并发关闭共享 Promise。异步准备的提交在最终落库前检查宿主关闭状态，防止关停后才确认新业务。

插件额外资源释放失败时，公共资源租约仍通过 finally 释放，运行时记录致命错误并停止继续派发，不把清理异常变成未处理的后台 Promise。退出时尝试其余租约与预算清理，owner 仍由宿主最后释放。

## Dim 源码参考

本次参考 [arcships/dim](https://github.com/arcships/dim)，本地快照 `64f877286f2b5b078d5697cda7bd0c392030388f`。没有复制其 Rust/rutis 代码或引入依赖。

- [`defaults.rs`](https://github.com/arcships/dim/blob/64f877286f2b5b078d5697cda7bd0c392030388f/crates/dim-agent-capabilities/src/defaults.rs)：`install_local_execution` 由产品 profile 组合 workspace tools、wait、recall；TNB 采用宿主装配 Coding 插件，公共引擎不导入业务工具的边界。
- [`workspace_tools/mod.rs`](https://github.com/arcships/dim/blob/64f877286f2b5b078d5697cda7bd0c392030388f/crates/dim-agent-capabilities/src/workspace_tools/mod.rs)：区分工具执行与权限/审批/沙箱，写协调器归工具插件；TNB 将工作区额外租约归 Coding generation，执行继续走原授权与沙箱。
- [`registrations.rs`](https://github.com/arcships/dim/blob/64f877286f2b5b078d5697cda7bd0c392030388f/crates/dim-agent-runtime/src/registrations.rs)：贡献归 owner 并随其退出撤销；TNB 沿现有初始化事务与 disposer，固定一代任务代码。
- [`assembly.rs`](https://github.com/arcships/dim/blob/64f877286f2b5b078d5697cda7bd0c392030388f/crates/dim-agent-runtime/src/assembly.rs)：Agent/Session/Branch Loader 分组。TNB 没有照搬多级插件实例树，也没有把持久回执改成 Timeline。

当前没有多 generation 热升级、历史包自动保留、跨平台进行中任务迁移、不受信插件隔离、分布式 owner 或数小时 soak 承诺。
