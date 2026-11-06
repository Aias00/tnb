# 插件备份检查与恢复

运行时备份 v2 覆盖数据库、执行证据、历史插件包和插件私有文件。它解决旧备份只有任务绑定却缺少原代码或私有文件的问题。备份检查分开报告材料完整性与当前宿主的静态兼容性；通过检查不自动授予信任，也不证明外部服务或原工作目录已经可用。

## 操作流程

停止后台服务后创建备份，目标必须位于运行时目录之外：

```sh
tnb runtime stop
tnb runtime backup /absolute/path/tnb-backup
tnb runtime backup-check /absolute/path/tnb-backup
```

`backup` 与原服务使用同一个 owner 锁，活跃 owner 存在时拒绝执行，避免复制活跃 WAL 或仍在写入的插件状态。自建 SDK 宿主调用 backupRuntime 时也必须持有离线 owner 锁。

`backup-check` 只检查已生成的备份，不启动 owner，不 import 插件入口、不运行迁移，不调用模型、工具或远端服务，也不打开可写 RuntimeStore。对话中可使用 `/runtime backup-check /absolute/path/tnb-backup`，SDK 可从 `tnb/runtime` 导入 `checkRuntimeBackup`。检查备份不要求停止其他正在运行的服务，也不会修改其数据库。

恢复沿用原命令，要求目标配置的 runtime 目录为空：

```sh
tnb runtime restore /absolute/path/tnb-backup --config-dir /absolute/path/recovery-config
```

宿主先在独立 staging 复制和校验实际材料，包括插件指纹，成功后才发布目录。原处于 active/pausing 的 Run 恢复为 paused，并记录 `run.restored`；终态、问答、命令身份与未知效果继续保留。恢复过程不执行业务，不自动 resume。安装包、配置、信任及原工作目录满足后再显式检查和恢复任务。

## v2 覆盖范围

| 材料 | 内容 |
| --- | --- |
| state.sqlite | Run/Task、来源绑定、命令回执、schema 版本及宿主批准等已有数据库事实 |
| 任务证据 | transcript、operation journal 和内容寻址 artifacts |
| plugin-generations | 历史包字节、generation.json、包内目录及可执行标记 |
| plugin-state | 各贡献/代际私有目录中的普通文件，包括二进制与空目录 |

控制 key、IPC socket、插件临时快照、未完成的 `.stage-*` 归档不进入备份。配置目录下的安装包、plugin-trust.json、settings/models/渠道配置、环境、原生依赖及工作目录仍需单独准备。插件私有文件按原样保存，其内容可能包括该插件自行存储的业务数据或秘密；备份格式不对这些文件进行业务识别、脱敏或加密。

v2 校验数据库中根任务、子任务和渠道绑定引用的全部包身份，缺少归档即拒绝发布备份，不把当前新版代码当成旧实现。归档中未再被引用但尚未回收的完整包也会保存。仅有 SQLite 或 generation.json 不能代替原始代码字节。

私有状态遵循[状态版本合同](plugin-data-contracts.md)的原命名空间和版本事实。复制私有文件只保证离线材料覆盖，不证明插件自建数据库、文件协议或网络游标具有额外的业务一致性；插件仍须在关闭时完成自己的 flush 和清理。

## 检查结果

命令输出 JSON，关键字段如下：

| 字段 | 含义 |
| --- | --- |
| integrity=verified | 已检查清单路径、校验和、SQLite 一致性、必要日志覆盖及历史包指纹 |
| plugins.coverage | included 表示 v2 包含插件文件；not-covered 表示 v1 不具备该覆盖 |
| pinnedGenerations / archivedGenerations | 数据库引用的包身份数与归档包数 |
| privateStateDirectories | 私有状态顶层目录数 |
| compatibility.status | compatible 或 review-required，仅针对当前清单和本地恢复 ABI 等静态检查 |
| requirements | 仍需当前信任/批准、原安装来源、配置/凭据、工作目录和外部服务 |

文件缺失、校验和不符、不安全路径、符号链接或归档指纹不符时检查失败，命令返回非零，不报告 verified。

材料完整但当前宿主不能静态确认兼容时，返回 verified 与 review-required，检查命令仍返回 0：

| issue.code | 需要处理的条件 |
| --- | --- |
| PLUGIN_HOST_COMPATIBILITY | 当前宿主不接受归档清单/API/版本，或包身份与可发现清单不匹配 |
| PLUGIN_RECOVERY_ABI | 内置归档的原 Bun、平台、架构或恢复协议与当前宿主不同/缺失 |
| PLUGIN_EXECUTABLE_MODE | 实际文件权限与清单记录的可执行位不同 |
| LEGACY_PLUGIN_ASSETS_NOT_COVERED | 旧 v1 备份没有历史包和私有文件覆盖 |

静态 compatible 不等于业务 ready：检查不会连接 MCP/渠道，不验证账户、不执行插件验收，也不重新批准归档。恢复后当前宿主仍会检查启用、blocklist、原指纹信任、原安装路径和恢复 ABI；本机已经撤销的信任不会因为复制包而恢复。

## 路径 权限和限额

清单只允许运行时证据路径及以 SHA256 身份命名的插件归档/私有目录，拒绝 `..`、反斜线、冒号、空路径段和过深路径。来源中的符号链接、目录祖先符号链接和特殊文件拒绝，不跟随到 runtime 外。恢复只生成普通私有文件和目录，不恢复任意权限、setuid、组授权或外部链接。

v2 记录目录和可执行标记。代码指纹包括空目录及文件是否可执行，检查不会只比较文件内容 checksum。传输工具若丢失 POSIX 权限，清单仍可核对原内容身份；POSIX 恢复使用 0600/0700 重建相应普通/可执行文件。Windows 不能表示全部 POSIX 语义，可能报告权限兼容问题；代码能否运行仍由恢复宿主再次检查。

单文件最多 512 MiB，全部文件最多 10 GiB，清单最多 16 MiB、100000 个文件和 10000 个插件目录，路径最多 32 段。超出限制不会发布部分备份。检查按代际索引归档，避免每个包重复扫描整个文件表。

POSIX 发布前同步文件和目录；Windows 只使用文件 flush 和 staging 发布，不宣称等价的目录 fsync 或完整后台 owner 执行支持。当前测试分别标明平台范围。

## 旧备份和恢复边界

恢复继续接受 v1，但必须显示插件材料不在其覆盖范围。旧备份即使仍保存 pinned Run，也不会凭空生成丢失的代码和私有文件；需要补齐原材料或保持任务暂停。v2 不接受同样的缺失冒充完整覆盖。

恢复到其他安装路径、账户、Bun 版本或系统，需要重新核对来源、批准、ABI 和业务配置。备份校验和用于完整性检查，不是来自可信第三方的数字签名。备份也不提供跨文件/网络事务、自动配置迁移、历史应用/界面代码恢复或跨 ABI 自动转换。相关合同见[领域代际](plugin-generations.md)、[内置代际](builtin-generations.md)和[渠道代际](channel-generations.md)。
