# 插件本地恢复预检

宿主运行时执行：

```sh
tnb runtime plugins --check
```

对话中用 `/runtime plugins --check`，SDK 用 `host.plugins.checkRecovery()`。可在检查暂停任务的恢复条件时使用。命令不会自动启动服务，不能用于离线恢复前检查。`--check` 与 `--references` 互斥；`--check` 的报告已包含当前引用快照。

本轮检查持久引用的领域、子任务和渠道包，包括终态任务与停用 Source；没有引用的应用/界面或其他当前插件不在扫描范围内。每次读取当前文件和 trust store，启用/阻止策略与 Source 配置沿用当前 owner 已生效快照。修改宿主配置仍需按原合同重启生效。

## 阅读报告

`scope` 固定为 `local-plugin-recovery`。`status: local-checks-passed` 表示被引用包的本地静态检查通过；`issues-found` 表示清单或某代发现问题。`generations` 是实际检查范围，`references` 解释每代被谁保留及是否需要加载。预检中的内存实现只带状态，不带任意插件错误正文；完整 inventory 仍可通过原 `runtime plugins` 查询。

每代失败包含稳定 `code`、`phase`、`plugin` 和 `retryable: false`。这表示没有自动重试策略；修复后可主动再次检查。一次报告给出每代遇到的首个前置问题，其他代际继续扫描。CLI 成功取得报告时退出码为 0，即使发现问题；脚本需检查 JSON 的 `status`。RPC、参数或生命周期错误则返回非零。

| 错误码 | 含义和处理方向 |
| --- | --- |
| `PLUGIN_INVENTORY_INCOMPLETE` | 自定义宿主漏传领域或渠道清单；没有该类引用应明确传 `[]` |
| `PLUGIN_HISTORY_UNAVAILABLE` | 该宿主没有私有历史目录，无法检查持久归档 |
| `PLUGIN_ARCHIVE_MISSING` / `PLUGIN_ARCHIVE_DAMAGED` | 原字节或元数据缺失、损坏、身份/指纹不符；核对可信备份 |
| `PLUGIN_HOST_INCOMPATIBLE` | 归档 manifest 无法被当前宿主接受或与包身份不符；核对 API、宿主范围和原恢复环境 |
| `PLUGIN_INSTALLATION_UNAVAILABLE` | 原安装包未被当前策略启用和信任，或同名安装故障挡住内置选择 |
| `PLUGIN_INSTALLATION_ORIGIN_CHANGED` | 历史来源与当前安装目录不一致，不能仅复制归档绕过来源审核 |
| `PLUGIN_GENERATION_UNTRUSTED` | 当前包可能可信，但原指纹批准已撤销；不会自动恢复旧批准 |
| `PLUGIN_FINGERPRINT_BLOCKED` | 宿主明确阻止了该内容指纹 |
| `PLUGIN_BUILTIN_NOT_SELECTED` | 原内置包未被该宿主选择，或被停用 |
| `PLUGIN_BUILTIN_APPROVAL_MISSING` / `PLUGIN_BUILTIN_ABI_INCOMPATIBLE` | 私有批准缺失，或原 Bun/平台/架构/协议 ABI 不匹配 |
| `PLUGIN_BUILTIN_APPROVAL_OR_ABI` | 自定义批准表只能给出布尔判断，或批准身份不符；不猜测更具体原因 |
| `PLUGIN_CONTRIBUTION_MISSING` / `PLUGIN_ENTRY_INVALID` | 找不到原 id/version 对应声明，或入口缺失/越界 |
| `PLUGIN_CHANNEL_DEPENDENCY_UNSUPPORTED` | 历史渠道声明了尚不支持恢复的贡献依赖闭包 |
| `PLUGIN_CHECK_FAILED` | 本地检查无法完成；查看宿主 inventory，修复文件或读取条件后重查 |
| `PLUGIN_CHECK_BUSY` | 另一个不同引用快照正在扫描，稍后再查 |

归档缺失时，即使精确匹配的当前安装包仍在，也先报告材料缺口。正常启动可能从可信当前包重新归档；预检不会主动修复，不据此断言任务绝无恢复方式。

## 不会由此自动完成的检查

报告始终列出 `unchecked`：factory 初始化/注册、配置和状态迁移、当前资源授权、凭据与远端服务，以及 transcript/operation 核对。通过检查不能代替实际恢复时的权限和状态校验。内存实现仍 active、磁盘包已 changed 时也可报告问题，这两项是不同事实。

扫描不运行旧代码、不迁移状态、不授信、不连接 MCP/渠道、不重发通知或工具操作。重复查询同一在途引用快照共享文件扫描，结果分别复制；检查结束后再查询会重新读文件。关闭宿主会取消并等待扫描。文件和信任可以在检查后继续变化，实际加载和执行仍须按原合同复验。

该功能与[引用诊断](plugin-references.md)、[备份材料检查](plugin-backup.md)互补。离线完整恢复预检、Source 退休和跨存储恢复仍未交付，不能通过手动删除绑定/归档绕过缺失项。

直接 `loadHostPlugins` 的宿主使用 `host.checkRecovery({ generationReferences, channelReferences })`，两份清单须是当前完整宿主事实。自定义批准表的 `approved`/可选 `inspect` 必须只读；扫描从不调用 `approve`。
