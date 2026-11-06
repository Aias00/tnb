# 默认 Coding 插件的升级与恢复

默认 `tnb-coding` 现在以独立代码包执行。包包含工具/模型/沙箱装配、manifest、随包 Skill 和运行时标识；身份按包内容计算，不再直接使用整个 TNB 源码树的指纹。新任务使用当前包，已有任务和子任务按原包指纹恢复。

构建 CLI 时，先生成 Coding 包，再将完整字节嵌入可执行文件。`dist/plugins/tnb-coding` 与嵌入版本包含同样的内容；运行时不从可替换的 dist 路径取回内置代码。源码运行按同一流程生成包，在当前进程缓存。默认包确实由加载器从私有副本执行，不是为另一套内存 factory 保存一个名字。

## 升级行为

正常使用不需要安装或信任内置包。宿主在获得 owner lock 后校验包并初始化，先保存历史字节，再在 SQLite 私有表登记宿主批准，最后开放新任务。升级后重启时，非终态任务引用的旧领域包可以与当前包并存；原 Run、Task、问题版本、能力固定记录和创建命令回执不改变。

```sh
tnb runtime restart
tnb runtime plugins
```

清单显示 `generation: current|retained`。只有终态任务引用的旧包保持 inactive，不执行旧 factory；明确 prune 终态任务后，无引用的历史包在后续启动回收。停止仍等待工具与 Worker 退出，随后清理临时代际，保留历史包。

随包 Skill 的身份使用包指纹和资源内容，不依赖每次启动产生的临时目录名；用户/项目 Skill 保持原来的路径与内容校验。恢复旧包不允许改变原模型配置、权限、工具合同或 MCP 代际。

## 信任、停用和兼容性

历史包必须拥有独立的宿主批准记录，且包身份、manifest、内容和恢复 ABI 均匹配。当前恢复 ABI 固定领域协议、Bun 版本、平台和架构。缺记录、改字节、跨 ABI 或当前宿主不再选择此 builtin 时，任务明确阻塞，不能把当前实现贴上旧指纹。恢复 ABI 是兼容性门槛，宿主领域协议发生不兼容变化时仍需提升协议。

整体停用仍使用 `enabledPlugins`。也可以在用户 settings.json 中阻止一个具体领域代际，随后重启：

```json
{
  "blockedPluginFingerprints": ["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"]
}
```

将示例指纹替换为 runtime plugins 显示的目标完整指纹。列表同时约束当前和历史领域包；项目/临时配置不能用空列表清除用户的阻止项。配置错误会明确报错。它不构成对已经导入 JavaScript 的强制卸载，修改后需重启宿主。

显式安装的同名包继续拥有选择优先权，即使它未信任、禁用或损坏，也不能回退到内置历史包。如果同一份完整包字节先由内置交付，后又被明确安装、信任和激活，归档可以记录两个已激活来源；新目录不能仅通过修改 metadata 获得宿主 builtin 批准。

## 已有任务和边界

本轮之前创建的默认任务使用旧的全宿主指纹，而且没有对应独立历史包。它们不会自动迁移：应使用原版本完成任务，或明确建立新任务。自定义 SDK `workerFactory` 仍是 inline 实现，除非 SDK 宿主自己提供对应可恢复代码包，否则不能保存内存闭包。

SDK `openAgentRuntime` 自动提供批准表；直接使用 `loadHostPlugins` 的宿主需在持有 owner lock 时提供 `builtinGenerationAuthority(store)`、私有快照目录和完整任务引用。这个服务不会出现在插件的 factory API 或普通服务授权表中。

macOS/Linux 验证完整运行与跨升级恢复；Windows 只验证安装、装载、归档与恢复选择，不扩大现有 owner 支持边界。默认 channels 后续也增加了独立包和固定来源恢复，详见 [渠道代际](channel-generations.md)。历史应用、Web 交互、热替换与插件进程隔离尚未实现；领域和渠道仍分别校验原 provenance。

runtime backup v2 已包含历史可执行包及插件私有文件，`backup-check` 会区分材料完整性和当前恢复 ABI；v1 不具有该覆盖。内置宿主批准随原 SQLite 保存，恢复仍须满足当前 ABI、配置和原执行合同。详见[备份指南](plugin-backup.md)。
