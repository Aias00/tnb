# 插件宿主体系实现审阅

设计基于 `b046216`，先独立提交方案为 `d0b7973`，再扩展原插件加载器和迁移协作模块。审阅重点是宿主边界、原子性和恢复，而不是仅检查目录结构。没有调用额外 Agent。

## 合同与实现

| 合同 | 实现 |
| --- | --- |
| 统一安装和信任 | 沿用 loadPlugins、installLocalPlugin、trust store 和私有内容快照；loadHostPlugins 支持四类贡献，loadAdapterPlugins 保留兼容别名 |
| 显式 API 兼容 | 纯领域插件继续使用 tnb.plugin/v1；应用/交互/渠道要求 tnb.host-plugin/v1，旧宿主明确拒绝不认识的 API |
| 包内原子注册 | 同入口合并声明，只调用一次 setup；跨入口全部成功才提交领域和扩展注册，未声明/重复/晚注册拒绝，失败逆序清理 |
| 无回退绕过 | 已安装同名包阻止内置实现，即使禁用、未信任、损坏或加载失败；目录解析失败也不会绕过该选择 |
| 精确依赖 | kind/id/version 依赖图校验缺失及循环，按拓扑启动并逆序停止；失败依赖不启动，独立贡献继续 |
| 服务边界 | manifest 服务声明、宿主 grants、服务表三者同时匹配；默认不下发 env/SQLite/控制 key；协作应用显式获得高权限内部桥 |
| 原有执行协议 | Coding 注册、provenance、工具授权、恢复和验收不变；执行内核不依赖应用/网页/渠道插件 |
| 独立状态 | 包名+贡献类别+id+接口版本确定 SQLite 命名空间，沿用 command receipt/CAS 和备份，重启命令不重复累加 |
| 请求隔离 | 认证 Unix RPC 派发应用/交互；依赖内调用也校验声明；移除 authorization/proxy-authorization/cookie，handler 不接收控制凭据 |
| 协作真实迁移 | runtime/server 不再启动 CollaborationHost；默认 profile 组合 tnb-collaboration 应用和 tnb-channels 提供者，保留 /collaboration 兼容别名 |
| 渠道真实迁移 | GitHub/webhook/timer 经注册表 connect；receive 验签、poll、send/find/observe 在渠道层；协作应用消费验证后的标准事件 |
| 可安装自定义渠道 | type=plugin + 精确 descriptor/options，无需修改 runtime/server 或内置 Source 分支即可完成接单、模型执行和自动结果通知 |
| 生命周期排空 | 应用/接口 signal、在途 handler、渠道独立连接、连接启动失败清理、逆序 onDispose 和异常后继续清理；结束后拒绝新 API 调用 |
| 停用行为 | 变更在重启后生效；停用协作插件保留业务事实，普通 runtime 可启动；collaboration start 不把已停用插件报告为启动成功 |
| 构建与部署形态 | dist/plugins 同时产出 Coding、channels、collaboration 包；示例应用、交互、渠道真实可安装，编译 CLI 验证安装、信任、调用、重启及状态恢复 |

## 审阅中修正

1. 新贡献需要独立 API 标识，避免旧宿主把已安装包静默当作没有可执行贡献的包。
2. Bun 1.3.14 使用 `new Request(oldRequest, {headers: emptyHeaders})` 会保留原认证头。改为根据 URL/method/body 重建 Request，并用回归测试确认真实剥离。
3. factory 注册与启动阶段分开；应用故障不能静默替换正在为持久任务提供能力的领域适配器。清单同时展示包注册状态和各贡献启动状态。
4. 渠道 connect 同步/异步失败都要回收已创建资源；连接有独立取消、在途调用等待及清理回调，而不把所有连接资源留到整个包退出才处理。
5. 结束时禁止新服务访问/注册，已进入清理的代码仍能保存独立状态；处理在途回执后才关闭 SQLite 和释放 owner。
6. 普通 runtime 与协作应用分开启停语义：协作配置启用但插件显式禁用时，不阻止普通 runtime；专门启动协作命令则给出明确错误。
7. webhook 的验签和解码也属于渠道，不能只把出站发送插件化。
8. 代码指纹从 Coding 私有目录抽为通用宿主功能；原 codingPluginFingerprint 名称保留兼容，应用和渠道不再依赖 Coding 业务实现。

## 验证与边界

新增宿主测试覆盖安装/信任、三类贡献同入口、独立状态与重启回执、服务/依赖拒绝、循环及缺失依赖、多入口回滚、关闭后 API 失效、真实 header 剥离、慢调用退出、连接部分失败清理，以及安装渠道接入协作应用的端到端执行和重启。

保留领域插件、原生沙箱、协作和 CLI 回归。使用脚本模型、临时目录和本机 HTTP；不发送真实渠道消息。macOS/Linux 完成 typecheck、全量测试及编译；编译产物额外安装示例与 channels/collaboration 包，验证应用/交互调用和持久状态恢复。具体计数以 PR 和 CI 为准。

当前交付是插件基础和实际应用/渠道迁移。网页工作台、浏览器登录与用户隔离、现有 TUI 视图整体迁入接口插件、热更新、历史多代际并存及自动数据迁移尚未提供。受信任模块是进程内代码，服务授权不是 OS 沙箱；忽略取消且永不结束的插件仍可能阻塞退出。渠道恢复检查持久 provenance，不能用新包静默接管旧 Source；缺少旧代际时明确阻塞，旧业务事实保留。
