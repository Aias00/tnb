# 插件配置和状态版本

应用和界面可以声明版本化宿主配置；应用、界面和渠道可以声明私有记录状态版本与迁移步骤。配置验证和状态预检在贡献 start/connect 及服务取得前完成，失败只阻止相关贡献及其依赖者，不自动切换其他代码代际。API 与包版本仍遵循[插件宿主](host-plugins.md)的独立合同。

运行本地完整样例：

```sh
bun examples/plugin-data-contract.ts
```

[样例源码](../../examples/plugin-data-contract.ts)先创建旧式 `{count:7}` 记录，再通过显式 `0 → 1` 迁移得到 `{total:7}`，同时取得校验后的宿主配置。只使用本机临时数据库，不调用模型或外部服务。

## 配置声明与输入

贡献清单新增可选 configuration：

```json
{
  "name": "counter-pack", "version": "1.0.0",
  "manifestVersion": 2, "apiVersion": "tnb.host-plugin/v1",
  "contributes": {
    "applications": [{
      "id": "counter", "version": "1", "entry": "index.mjs",
      "configuration": {
        "version": 1,
        "schema": {
          "type": "object",
          "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 64 } },
          "required": ["label"], "additionalProperties": false
        }
      },
      "state": { "version": 1, "migrations": [{ "from": 0, "to": 1 }] }
    }]
  }
}
```

用户目录 `settings.json` 中按包名和贡献键传入配置：

```json
{
  "pluginConfiguration": {
    "counter-pack": {
      "application:counter@1": { "version": 1, "value": { "label": "Team counter" } }
    }
  }
}
```

贡献键为 `kind:id@version`，SDK 可以使用 `contributionConfigurationKey(ref)` 生成。默认后台 profile 读取用户配置；项目 `.tnb/settings.json` 和 `.tnb/settings.local.json` 中的 pluginConfiguration 会被忽略并产生提示，避免工作区文件改写共享后台业务配置。设置合并时整个同名包配置表替换，不把旧版 value 的字段拼进新版。修改设置通过重启生效。

SDK 自建宿主使用 `extensions.start({store, configuration})`；`openAgentRuntime` 则使用 `pluginConfiguration`。通过预检的 JSON 快照出现在 `context.configuration`，不会转成工具参数或自动增加任务授权。没有声明 configuration 的旧贡献仍使用旧接口，不能接收新的版本化配置。原 `HostPluginAPI.configuration` 继续用于宿主 transient 组合依赖，不属于本配置 Schema 或持久任务配置。

应用/界面配置版本为 1 至 999 的整数，宿主提供的版本必须精确匹配清单。本轮不自动迁移配置、不应用默认值、不转换类型。渠道 `connect(configuration, context)` 沿原领域配置/来源身份合同验证，不接受该宿主 configuration 声明；Adapter/Worker 也沿原领域配置合同运行。

配置保持在内存中，贡献 inventory 只报告 `configuration.status/version/digest`，不回显 value。配置校验错误不包含输入值、未知字段名或迁移异常正文。通用配置不是凭据保险箱，也没有凭据引用机制；业务服务仍负责凭据使用和日志脱敏，不能把 secret 当作适合持久上下文的数据。

## 支持的 Schema 子集

| type | 支持的附加关键字 |
| --- | --- |
| object | properties、required、additionalProperties 布尔值 |
| array | 必需的 items，minItems、maxItems |
| string | minLength、maxLength，按 Unicode 码点计数 |
| number / integer | minimum、maximum；integer 只接受安全整数 |
| boolean / null | 无额外类型关键字 |

type 为单个字符串。标量 enum 适用于 string、number、integer、boolean、null，最多 64 项且不可重复。未指定 additionalProperties 时允许额外 JSON 字段；需要封闭合同应明确设为 false。required 项必须在 properties 中存在。

拒绝 `$ref`、`$schema`、default、pattern、组合 Schema、类型数组和其他不支持的关键字，不下载远端资源或执行正则。Schema 最多 64 KiB、256 个节点、16 层嵌套、每个对象 64 个属性。配置最多 128 KiB、8192 个 JSON 节点及 16 层嵌套；未指定 array.maxItems 时最多 4096 项。配置输入仅接受有限数字、普通 JSON 对象及数组，undefined、函数、Date 等不通过校验。

Schema 在发现包时静态检查，不通过不会 import 入口。内置和 SDK 注册也执行同一数据合同验证。新字段不提升 manifestVersion；旧宿主原有严格字段检查会明确拒绝新声明，不能承诺旧宿主理解这些行为。

## 状态版本和预检

私有记录版本独立于包 SemVer、内容指纹、贡献 version 和配置 version。宿主把版本保存在 `host.plugin-state-schema`，不放在插件可访问的 state 命名空间里。贡献只能使用 `context.state` 的 get/list/command，不能通过这些句柄改写版本事实。

| 已有状态 | 新声明 | 行为 |
| --- | --- | --- |
| 无版本且没有私有记录 | state.version=N | 初始化为 N，不执行历史步骤 |
| 有记录但没有版本 | state.version=N | 以 0 为来源，必须存在显式迁移路径 |
| 已版本化且相等 | state.version=N | 直接恢复，不重新迁移 |
| 已版本化且较旧 | 更高版本 | 完整路径存在才逐步迁移 |
| 已版本化且较新 | 较低版本 | 拒绝降级 |
| 已版本化 | 无 state 的旧声明 | 当前宿主拒绝旧代码读取该空间 |
| 版本元数据损坏 | 任意声明 | 阻止恢复，不视为新状态 |

贡献 state 诊断包含 `status`、当前 `version` 和 `target`，状态分别为 legacy、migrating、ready、blocked。未声明 state 且无版本元数据的旧贡献仍是 legacy，不声称已做版本恢复预检。`tnb plugins show NAME` 的 extensions 显示安装清单合同；`tnb runtime plugins` 的贡献 inventory 显示运行预检结果。

渠道仍按原历史代际的状态所有权规则选择命名空间，新代际不占据旧渠道游标和回执。新旧代际可分别保存不同 state.version；升级不自动迁移 Source 绑定、通知身份或原任务。历史应用/界面的代码留存没有因本轮开放。

## 注册迁移

入口必须精确注册清单声明的步骤，不得缺失、重复、额外注册或使用原生 async 迁移。每个来源版本最多一个下一步，to 必须大于 from 且不超过目标版本；最多 32 步。

```js
export default api => api.registerApplication({
  id: "counter", version: "1",
  migrations: [{ from: 0, to: 1, migrate(tx) {
    const previous = tx.get("counter");
    if (!previous || typeof previous.value.count !== "number") {
      throw new Error("Unsupported legacy counter record");
    }
    tx.save("counter", { total: previous.value.count }, previous.revision);
  }}],
  start(context) {
    return { handle: () => Response.json({
      label: context.configuration.label,
      counter: context.state.get("counter").value
    }) };
  }
});
```

迁移只取得当前贡献记录空间的 get/list/save，同步回调结束后所有事务句柄失效。list 返回该空间的全部有界记录。没有 delete、服务查找、文件路径和网络句柄，不能借迁移取得宿主原始事务。普通 state.command 也要求同步回调，缓存事务句柄不能跨命令使用。

完整迁移路径在第一步前预检。每一步的记录写入、宿主版本和命令 receipt 在同一 SQLite 事务中提交；异常或进程被强杀时一起回滚。成功步骤保留，后续步骤失败时下次从已提交版本继续。初始化或迁移后应用 start 失败不会逆向回滚已经提交的数据；修复应用后按原版本恢复，不能自动运行旧版代码。

命令身份固定到记录空间和 from/to，输入包含代码指纹。重新启动根据版本记录跳过已完成步骤，不重放业务网络动作。迁移失败的异常正文不会进入公开诊断；返回稳定 `PLUGIN_STATE_MIGRATION_FAILED`，并说明该步骤记录及版本保持原状态。不能把失败解释成任意外部效果已撤销。

## 迁移预算与剩余边界

单步最多读取 256 条已有记录、执行 256 次 save，已有值与写入值累计最多 4 MiB；每条值继续受 128 KiB 上限和 CAS 约束。超过预算则整步失败，不能在没有批次恢复协议时半迁移后向业务开放。需要处理更多数据时应设计后续批次协议，本轮没有无界自动扫描或自动分页迁移。

stateDirectory 中的文件不在记录事务内。没有文件暂存、原子发布和恢复标记，也不把 SQLite 提交宣称为文件/网络原子提交。迁移回调运行于可信进程内，虽然宿主只传入记录接口，代码仍能自行 import 文件或网络模块；作者必须遵守纯记录迁移合同。同步函数无限循环或异步 Promise 的外部副作用无法由本轮强制隔离。

本轮配置和记录预检并非完整备份/恢复诊断器。跨存储迁移、降级转换、Run/call 作用域和受限执行进程仍留在[插件规范](../superpowers/specs/2026-11-05-plugin-specification.md)的后续范围。
