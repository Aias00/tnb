# 已安装领域插件的跨升级恢复

默认内置 Coding 也已支持独立包留存与宿主批准，见 [默认 Coding 的升级恢复](builtin-generations.md)。以下安装目录与 trust store 约束针对独立安装的包。

已安装包的领域适配器现在支持历史代际留存。新任务默认绑定当前包；旧 Run 和它的子任务按原来的包名、包版本和 SHA256 指纹解析，不把升级后的实现伪装成旧实现。即使包版本和 adapter version 没改、只改了代码，也可以区分两代。

宿主启动时在 owner lock 下读取任务引用，将通过信任、兼容性和初始化校验的当前领域包保存到 runtime 目录的 `plugin-generations/<identity digest>/`。完整包字节和来源元数据在暂存目录写完、校验并刷新后再原子发布；运行时从独立临时副本 import。关闭删除临时副本，保留历史包。Windows 刷新文件后 rename，不承诺 POSIX 目录 fsync。

## 使用与信任

继续使用原命令，不需要为每个旧任务手动选择版本：

```sh
tnb plugins install ./my-plugin
tnb plugins trust my-plugin --yes
tnb plugins enable my-plugin
tnb runtime restart
tnb runtime plugins
```

更新包后审核并重新 trust，再重启宿主。`runtime plugins` 显示 `generation: current|retained`、`references` 及加载状态。非终态 Run 需要的历史适配器会加载；只有终态 Run 引用的历史包保持 inactive，不执行其 factory。所有 Run 配置和子任务覆盖配置都计入引用，不能只检查根任务或 active 状态。

历史加载同时要求：原安装目录仍存在、当前包启用且已信任、原指纹仍有批准记录、归档来源/manifest/字节匹配、当前宿主接受原插件 API 和兼容性声明。缺失或损坏时显示 blocked，旧任务暂停。当前包初始化失败不会把历史实现提升为默认；新根任务不能选择只为恢复加载的旧代际。子任务可以继承原父任务代际。

`trust` 会保留同一目录以前明确批准过的指纹，仅供固定代际恢复；当前包仍只按最近一次批准判断 trusted/changed，历史批准不会让未审核修改自动激活。`untrust` 撤销该目录全部代际，之后只重新信任当前包不会复活旧授权。禁用或移除安装包也会阻止历史恢复。已经加载的可信 JavaScript 仍需停止宿主才能退出。

## 命令、回收与备份

本版本新创建的任务会在同一事务内保存原提交摘要和规范化命令。精确重复提交可以验证并返回原回执，不需要重新加载终态任务的旧代码；更改 objective/configuration 等输入不能复用原命令身份。历史任务仍沿原规范化命令校验，不放宽旧回执摘要。

仍被任何 Run 引用的包不会自动删除，包括 paused、failed、cancelled 和 succeeded 的记录。明确 prune 终态 Run 后，无引用且非当前的历史包会在下一次启动时回收；中途崩溃遗留的暂存目录也会清理。SDK `openAgentRuntime` 自动收集引用；直接使用 `loadHostPlugins` 时，没有完整的宿主引用清单就不自动回收。

历史目录与任务数据库是不同的数据。现有 runtime backup 不包含插件可执行包；迁移或灾备还需要保存历史目录、原安装包、信任文件及所需配置。恢复到不同路径需要重新审核来源，不能只复制 SQLite 就宣称恢复完成。

## 范围

安装包的历史恢复只初始化包含适配器的入口，不启动历史应用、交互或渠道。默认内置 Coding 另使用随宿主交付的独立包与私有批准表；未提供代码包的自定义 inline factory 仍不能归档。旧任务不会自动转换到已安装包。历史渠道、应用、交互、多进程隔离、热替换和跨 ABI 自动迁移仍未实现。旧包的外部依赖、凭据和远端服务也需要继续满足原执行合同。

macOS/Linux 验证完整 owner 执行和跨升级恢复；Windows 验证包安装、归档、注册表、多代际引用与回收。现有 owner 的 artifact 持久屏障依赖 POSIX 目录 fsync，Windows 完整执行/恢复不在本轮支持承诺内。
