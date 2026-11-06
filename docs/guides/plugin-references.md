# 查看插件为何被保留

宿主运行时执行：

```sh
tnb runtime plugins --references
```

对话中可用 `/runtime plugins --references`。命令只连接当前 owner，不自动启动、重启或回收插件。宿主未运行时先用 `tnb runtime start`。

报告包含：

| 字段 | 含义 |
| --- | --- |
| `inventory.domains/channels` | 宿主提供完整清单为 `complete`，省略为 `unknown`；不是自动扫描任意插件私有数据库的证明 |
| `collection` | `phase: startup` 的启动回收结果；`disabled` 带稳定原因 `incomplete-inventory` 或 `no-history-root`，`failed` 带错误 |
| `generations[].plugin/key` | 精确包名、版本、SHA256 和该身份的目录摘要 |
| `retain` | 该代仍被至少一条持久记录保留 |
| `load` | 至少一条引用需要加载实现；不表示当前已经可用 |
| `references` | 根任务 `run`、子任务覆盖 `task` 或渠道 `channel` 的具体理由及各自的加载需求 |
| `implementations` | 当前宿主中精确匹配这一包身份的实现及状态；空数组表示没有匹配的内存实现 |

根任务理由包含 `runId`；覆盖配置另外包含 `taskId`；渠道理由包含 owner 和 Source key。包同时贡献领域和渠道时合并展示全部理由。终态任务与停用 Source 可以显示 `retain: true, load: false`，这是保留证据的正常状态。

报告每次读取当前数据库。新任务、子任务覆盖及明确 prune 后的变化无需重启就能看见。协作 Source 的加载需求按当前 owner 已生效配置计算，磁盘配置修改后仍需重启生效。旧 `tnb runtime plugins` 列表中的 `references` 是启动时计数，需要当前理由时使用新命令。

查询不校验归档字节、重新授信、连接渠道或验证远端服务。包实现显示 active 也不能代表每个渠道连接都健康。检查保存的备份材料使用 [backup-check](plugin-backup.md)；该命令同样不代表完整恢复预检。

## 自定义宿主

`openAgentRuntime(...).plugins.references()` 自动读取当前 Run 和渠道绑定，附加宿主提供的渠道引用。直接使用 `loadHostPlugins` 时：

```ts
const host = await loadHostPlugins({
  roots, trustStorePath,
  generationReferences: pluginGenerationReferences(store),
  channelReferences: channelGenerationReferences(store),
}, [], snapshotRoot);

const report = host.references({
  generationReferences: pluginGenerationReferences(store),
  channelReferences: channelGenerationReferences(store),
});
```

上述宿主 API 与两个收集函数均可从 `tnb/agent/runtime` 导入。宿主须持有 owner 锁，并提供完整事实；没有渠道时明确传 `channelReferences: []`。省略任一启动清单会禁用回收，但仍可加载已知引用。报告参数应在每次查询时重新收集；报告本身不触发加载或回收。

明确 prune 一个终态 Run 只释放它自己的引用。其他 Run、子任务或任何渠道绑定仍可保留同一代。无引用且非当前的历史包在下次完整清单启动时才可回收。停用或从配置移除 Source 不会删除其持久绑定；本轮没有 Source 退休命令，不要手动删归档。
