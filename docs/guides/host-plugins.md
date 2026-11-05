# 插件宿主：场景、应用、交互与渠道

TNB 的执行内核管理任务、恢复、预算、权限和持久状态；插件宿主管理可替换能力。领域适配器、常驻应用、交互接口、渠道使用同一套安装、信任、私有内容快照和固定代际机制。已有 skills、commands、hooks、MCP、工具插件仍按原贡献协议使用，没有另设安装目录或另一套信任表。宿主插件注册不会自动把能力暴露为模型工具；模型仍通过原工具目录、领域能力授权和 MCP/skill 管理机制使用能力。

| 贡献 | 注册接口 | 职责 |
| --- | --- | --- |
| adapters | registerAdapter | 工具、资源、领域验收；Coding 保持旧接口兼容 |
| applications | registerApplication | 常驻应用、接单与业务状态，例如协作工单 |
| interfaces | registerInterface | 用户交互协议或视图 handler，例如本地网页工作台 |
| channels | registerChannel | receive/poll/send/find/observe 网络或本地渠道 |

## 统一包格式

新增三类贡献使用 `manifestVersion: 2` 和 `apiVersion: "tnb.host-plugin/v1"`。旧的纯领域插件继续接受 `tnb.plugin/v1`；新 API 可同时声明 adapters。旧宿主不理解新 API 时明确拒绝，避免显示安装成功却忽略应用。每项声明精确 id/version/包内 .mjs entry；应用、交互、渠道可以声明服务名称及精确依赖。完整示例见 [examples/host-plugin](../../examples/host-plugin/plugin.json)。

```json
{
  "name": "my-app", "version": "1.0.0", "manifestVersion": 2,
  "apiVersion": "tnb.host-plugin/v1",
  "contributes": {
    "applications": [{
      "id": "my-app", "version": "1", "entry": "index.mjs",
      "services": ["tnb.runtime.read/v1"]
    }],
    "interfaces": [{
      "id": "my-view", "version": "1", "entry": "index.mjs",
      "requires": [{ "kind": "application", "id": "my-app", "version": "1" }]
    }]
  }
}
```

同一个入口的 factory 只运行一次，必须恰好注册该入口声明的全部贡献。同包多个入口有一个失败，整个包注册回滚并逆序执行清理；不会留下半个可用插件。setup 完成后不能继续注册。包注册状态与各贡献启动状态分别展示；一个应用启动失败，不会把已经用于持久任务恢复的领域适配器偷偷换掉。

## 安装和查看

```sh
tnb plugins install ./examples/host-plugin
tnb plugins trust example-host --yes
tnb plugins enable example-host
```

按需在宿主的 settings.json 授予该包请求的服务：

```json
{"pluginServices":{"example-host":["tnb.runtime.read/v1"]}}
```

然后重启宿主并查看实际贡献状态：

```sh
tnb runtime restart
tnb runtime plugins
```

默认常驻宿主只扫描用户插件目录。项目插件仍沿会话原路径提供 skills/MCP/hooks/tools；使用 --project 安装不会自动获得共享后台执行权，SDK 宿主可以显式指定加载 roots。

包安装状态用 `tnb plugins list/show` 查看；后台中的贡献状态用 `tnb runtime plugins` 查看。禁用使用 `tnb plugins disable NAME`，重启后生效。没有对活跃 Agent 热替换插件代码；更新后的内容需要重新信任。显式安装的同名包不论禁用、未信任、损坏还是加载失败，都不会绕过它回退到内置实现。

默认产品 profile 在一个宿主内组合 `tnb-coding`、`tnb-channels`、`tnb-collaboration`、`tnb-web`。这些包也在构建产物的 dist/plugins 下提供可安装包，运行中的内置版本和安装版本走相同注册与生命周期。停用协作插件不会删除工单、通知或原 Run。

## 服务、状态和依赖

应用/交互的 `start(context)` 返回可选 `handle(Request)`、`status()`。context 提供：

- identity、独立状态目录、生命周期 signal；状态目录使用宿主生成的路径，不拼接插件任意路径。
- state.get/list/command：同一 SQLite 中按包名+贡献种类+id+接口版本隔离；变更沿用 command receipt 与 revision CAS。重启不重做已提交命令，冲突输入拒绝；包字节更新不自动删除同接口版本状态。需要数据迁移时由插件显式处理，接口不兼容时提升贡献 version。
- service(name)：名称必须同时在贡献 manifest 声明、宿主 grants 授予、服务表存在；默认不注入 env、SQLite、控制 token。默认 profile 提供 tnb.runtime.read/v1 和受限的 tnb.tasks/v1 工作目录任务服务；tnb.collaboration/v1 为协作应用提供限定来源、任务归属和状态命名空间的接口，tnb.channels/v1 是渠道注册表；默认宿主已移除 tnb.runtime.internal/v1。其他包使用这些服务前必须由宿主显式授权，详见 [协作服务权限](collaboration-services.md)。
- request(reference, Request)：只能调用自己声明的精确依赖，宿主再次校验目标 active 状态；自动移除 authorization、proxy-authorization、cookie。
- onDispose：清理回调，启动失败和关闭均逆序执行。部分资源创建后立即登记清理；每个插件负责自己的 timer/listener。清理可保存自己的状态，但不能重新注册贡献或取得新服务。

先校验缺失/循环依赖，再按拓扑启动；默认渠道先于应用，交互最后。依赖失败的贡献不启动，独立贡献可继续。宿主在 runtime owner lock 内加载包，Runtime 恢复就绪后才启动应用。

受信任插件是进程内 Bun/Node 代码。服务授权限制宿主 API 使用，不构成恶意模块的 OS 隔离；安装者仍需要审查并信任可执行代码。未信任或指纹改变的模块不会被 import。真实任务权限和 Coding Shell 原生沙箱继续由执行内核及领域插件约束。

## 渠道连接与协作迁移

`registerChannel({id,version,connect(configuration,context)})` 返回 ChannelPort：receive 验证入站请求并产生标准事件，poll 拉取标准事件，send 返回回执，find 只核查通知身份，observe 读取具名资源。网络请求接受 AbortSignal。每条连接独立注册 onDispose，启动失败会回收部分资源；连接关闭先取消并等待在途调用，然后清理端口及回调。宿主退出也会回收未被应用主动关闭的连接。

协作工单与 Outbox 留在应用层，渠道不能把一条网络响应直接当成任务成功。GitHub PR 观察使用 `github.pull-request` 资源；来源固定仓库、actor 权限、问题版本及未知发送结果协议沿用 [协作指南](collaboration.md)。

自定义渠道不需要修改 runtime/server 或 source 类型 switch：

```json
{
  "enabled": true,
  "sources": [{
    "id": "notes", "type": "plugin",
    "channel": {"id":"local-notes","version":"1"},
    "options": {"command":"/tnb run 分析仓库并报告"},
    "actors":["operator"], "controllers":["operator"],
    "configuration":{
      "workspace":"/absolute/path/to/checkout",
      "allowWrite":false,"allowShell":false,"checks":[],
      "provider":"configured-provider","model":"configured-model"
    }
  }]
}
```

示例 local-notes 渠道只在本机按固定命令产生一个事件，通知回执保存在插件独立状态中，不发送实际社交消息。其他外部渠道应由各自适配器验证来源身份。接收来源配置中的 actor 是准入名单，不能把模型正文当成身份。

应用保存每个 Source 的渠道包 provenance；恢复需要相同渠道代际。包或内置构建指纹改变时，不能用新实现静默接管旧 Source；保留原包，或为明确的新接入使用新 Source ID。旧业务事实留存，不丢弃旧通知身份。跨代际状态迁移、历史多代际并存尚未提供自动化工具。

## 宿主请求和关闭

认证 Unix IPC 新增 `/extensions` 清单及 `/extensions/application|interface/<encoded-id>/<encoded-version>/...` 请求派发，`/collaboration` 保留兼容别名。handler 获取业务 Request，拿不到宿主认证头。网页插件可通过 `tnb web` 按需建立独立的本机 HTTP 工作台，使用工作目录视图和单次入口/cookie，不把私有 Unix RPC 或控制 key 交给浏览器，见 [网页指南](web-workbench.md)。

停止先拒绝新请求/连接并取消信号；应用和接口按依赖逆序排空，再回收渠道连接，等待在途 handler/网络调用，最后停止 Runtime、清理包快照、关闭数据库并释放 owner lock。插件必须尊重 signal 并为网络设置超时；受信任进程内代码无法被安全强制终止，忽略取消且永不结束的 handler 仍可能阻塞退出。

已交付插件基础、协作/渠道迁移、安装示例，以及按工作目录授权的本地网页工作台。远程多用户登录、现有 TUI 视图整体迁入交互插件、热更新和自动跨代际迁移仍留作后续。
