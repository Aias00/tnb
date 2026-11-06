# 外部插件工具的环境与凭据引用

oneshot/stdio 工具默认不继承整份宿主环境。宿主只提供必要的执行路径、系统和终端/locale 变量，以及该工具代际独立的 HOME、临时目录和配置/缓存目录。Provider 密钥、`TNB_HOME`、SSH agent、代理、语言加载参数及其他业务变量不会因为存在于启动终端中而自动传入。

本合同只覆盖 `contributes.tools` 的子进程。可信进程内 Adapter/Application/Interface/Channel、独立 MCP、Coding Shell 和插件自行创建的进程各有自己的合同，不能从本文推断它们获得了同样的环境处理或 OS 隔离。

## 需要凭据时

在用户配置目录的 `settings.json` 中，为指定包内容和工具添加环境引用：

```json
{
  "pluginToolEnvironment": [
    {
      "plugin": "team-tools",
      "fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "tool": "team.audit",
      "variables": {
        "ACCESS_TOKEN": "TEAM_AUDIT_TOKEN"
      }
    }
  ]
}
```

先用 `tnb plugins show team-tools` 核对实际内容指纹，替换示例中的 64 位 SHA256。宿主创建工具 runtime 时，其环境中需已有 `TEAM_AUDIT_TOKEN`。该工具收到名为 `ACCESS_TOKEN` 的变量；配置保存的是宿主变量名，不保存密钥正文，也不把引用表传给模型。

包名、工具 ID 和指纹必须精确匹配，不支持通配符。包升级后，单独完成新代码信任仍不足以沿用旧凭据授权，需要明确更新或移除该引用。缺失/空值/无效引用或指纹不符会在启动子进程前拒绝，不静默以无凭据模式替代。

该字段仅接受用户 `settings.json`。项目的 `.tnb/settings.json`、`.tnb/settings.local.json` 及 `--settings` 覆盖中的同名字段会被忽略并警告，即使项目已受信任也不能自行申请宿主凭据。插件 manifest 的工具描述不能声明 `env` 或其他未知字段来授权自己。

引用值取自创建 runtime 时的宿主环境快照。修改另一个终端的环境不会更新已经运行的进程；轮换值需要更新实际宿主环境并重建 runtime。用户配置里的引用映射可以通过原资源刷新流程撤销或调整。

## 默认环境

| 类别 | 行为 |
| --- | --- |
| PATH、PATHEXT、SystemRoot/WINDIR/COMSPEC | 从宿主提供值中选取必要字段；缺失时使用有限系统路径和 Windows 系统根 |
| LANG、选定 LC 字段、TZ、TERM、NO_COLOR、FORCE_COLOR | 仅保留列明的运行/展示变量 |
| HOME、USERPROFILE | 指向该工具独立的临时 home |
| TMPDIR、TMP、TEMP | 指向该工具独立的临时目录 |
| XDG_CONFIG_HOME/CACHE_HOME/DATA_HOME/STATE_HOME、APPDATA/LOCALAPPDATA | 指向私有 home 下的独立目录 |
| 其他宿主变量 | 默认不传递；仅经明确引用提供 |

引用不能改写 PATH、HOME/临时/配置目录、已禁止的加载器参数或代理变量。宿主固定目录和启动方式，模型只提供业务输入。子进程的 cwd 仍为原包目录，不因 HOME 改变而自动授予用户工作区权限。

私有 HOME 是短期缓存和配置空间，不是持久状态 API。需要持久状态的贡献应使用[私有状态协议](plugin-data-contracts.md)或另行设计明确的业务持久合同，不能依赖临时目录在 stop、升级或重启后继续存在。这些目录不属于 runtime v2 的 plugin-state 备份覆盖。

## 撤销、刷新和关闭

引用映射发生实质变化时，宿主先拒绝新的工具调用，再取消本 runtime 的在途调用、等待受管理的直接子进程退出，最后清理旧私有目录。该流程会排空整个外部工具 runtime，包括原在途 HTTP 调用；不会自动重试任何旧操作。

工具句柄固定创建时的环境引用身份。该工具的引用变化后，旧句柄返回 `PLUGIN_TOOL_ENVIRONMENT_CHANGED`，需刷新工具目录；不会给已批准的旧调用悄悄换一组凭据。配置刷新中的 ConfigChange Hook 不能否决已执行的宿主凭据撤权。仅调整等价授权的排列顺序不会重启进程。

同一工具的并发 stdio 请求合并私有目录和进程准备；环境准备后再次检查停止状态和进程上限。正常 stop/close 会等待调用与进程退出后清理目录。清理失败会阻止后续调用；强制杀死宿主后的遗留临时目录没有自动回收承诺。

当前限额：最多 128 条授权、每条最多 32 个引用；单个引用值最多 16 KiB，一组值总计最多 32 KiB。每个 runtime 默认最多 128 组私有进程环境，可通过 `maxProcessEnvironments` 收紧。该限制是目录集合数量，不是子进程文件写入的磁盘配额。

## 诊断和输出

| 错误代码 | 含义 |
| --- | --- |
| PLUGIN_TOOL_ENVIRONMENT_INVALID | 授权结构、目标变量或引用格式不受支持 |
| PLUGIN_TOOL_ENVIRONMENT_DENIED | 指纹/传输不匹配、引用值缺失/无效/过大，或私有环境数量超限 |
| PLUGIN_TOOL_ENVIRONMENT_CHANGED | 宿主正在撤权/排空、清理失败，或旧句柄属于之前的引用身份 |

宿主不在这些诊断中拼接引用值。受管理的返回文本和错误中，与获批值精确匹配的内容会替换为 `[redacted]`；这是额外防护，不是通用数据防泄漏。编码、拆分、部分文本、插件自身的文件/日志/网络和任意进程内代码不在该替换保证内。

## 源码宿主接入

`PluginToolRuntimeManager(env, limits, grants)` 的前两个参数保持原位置，第三个参数接收相同结构的宿主授权。`configureEnvironment(grants)` 等待重新配置和排空完成；调用方应在重建目录前等待它。CLI、REPL、TUI 及 Web 的普通 Coding 对话均经同一终端执行路径接入。

环境处理不构成文件、网络、后代进程树或系统调用沙箱。工具代码仍是受信任的 OS 进程，能够自行读取其 OS 权限允许的文件或创建其他进程。POSIX 目录使用 0700；Windows 沿用用户临时目录的权限，不宣称已验证等价 ACL。强隔离、统一 MCP/Channel 凭据服务及任意秘密存储后端仍需独立合同；不能用本文代替[运行合同](plugin-tool-runtime.md)和当前平台能力检查。
