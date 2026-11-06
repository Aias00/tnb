# 外部插件工具运行合同

本合同适用于 `contributes.tools` 中的 HTTP、oneshot 和 stdio 外部工具。包准入沿用[插件宿主指南](host-plugins.md#统一准入策略和撤权)，执行时由宿主统一管理网络目标、读取限额、调用期限和资源清理。Adapter、Channel、应用内任意 JavaScript、独立配置的 MCP 和 Coding Shell 各有自己的运行合同，不能用本文推断它们已经获得相同限制。

## HTTP 目标和连接

HTTP 工具使用 JSON-RPC `tools/call` 的 POST 请求。网络声明在发现清单及实际调用时都检查：

| 声明 | 允许的目标 |
| --- | --- |
| none | 不允许 HTTP 工具，发现清单即拒绝 |
| loopback | 数字 IPv4 回环地址 `127.0.0.0/8`、IPv6 `::1`，或精确的 `localhost` |
| egress | HTTP(S) endpoint；允许回环或外部目标 |

`localhost` 固定连接到 `127.0.0.1`，保留原 Host 和 TLS 主机身份。仅监听 IPv6 的本机服务应明确配置 `http://[::1]:PORT`。其他 DNS 名称即使此刻解析到回环也不属于 loopback 合同，IPv4 映射的 IPv6 地址和 `0.0.0.0` 也不在该准入范围。URL 标准化后的数字回环写法按实际地址判断。

连接由每次调用独立创建并销毁的客户端持有，不使用 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY 或全局 dispatcher 改写连接。所有重定向均拒绝；宿主不会自动向 Location 重发 POST 或把它变成 GET。服务应配置最终 endpoint，需要更换目标时修改配置并走原信任和任务准入流程。URL 用户名/密码和 HTTP 工具的 command args 均拒绝，凭据不能通过这些字段传递。

响应头最多 16 KiB，响应正文在逐块读取时受字节上限约束。超限、连接中断或超时均失败，不把已收到的部分 JSON 作为完整成功结果；HTTP/stdio 的 JSON 回复缺少 result 和 error 时也拒绝，不返回空成功。此路径请求 identity 编码并拒绝压缩响应，避免解压后绕过读取预算，也不自动重试。

## 宿主限额

默认限额由宿主给出，不接收插件或模型申请的更大值。自建源码宿主可以通过 `PluginToolRuntimeManager` 的第二个构造参数收紧限额；选项必须为正整数，未知选项和高于默认上限的值拒绝。

| 限额 | 默认值 | 归属 |
| --- | --- | --- |
| timeoutMs | 120000 ms | 每次调用，覆盖连接、执行及读取 |
| maxInputBytes | 1 MiB | 每次输入；stdio/HTTP 同时检查协议 envelope |
| maxOutputBytes | 1 MiB | oneshot stdout、HTTP 响应正文，或单次 stdio 结果 |
| maxStderrBytes | 256 KiB | 每个子进程生命周期的 stderr |
| maxFrameBytes | 1 MiB | 每条 stdio 帧，包括未完成且没有换行的帧 |
| maxStdioBytes | 8 MiB | 每个 stdio 子进程生命周期的 stdout，通知和无关帧也计数 |
| maxConcurrentCalls | 32 | 一个工具 runtime 的全部在途调用，超出立即拒绝，不无界排队 |
| maxStdioProcesses | 16 | 一个工具 runtime 的常驻 stdio 子进程数 |
| killGraceMs | 250 ms | 直接子进程正常终止后的强制退出升级间隔 |

stdout/stderr 从子进程启动时同时读取，避免等进程退出后才读 stderr 造成管道阻塞。限制以原始字节计算，JSON 解析前先检查帧大小。生命周期累计上限达到后终止该进程；新的独立调用可以重新建立进程，但宿主不会重发旧调用。展示结果仍保留 100000 字符上限及截断标记，展示截断和读取超限失败是不同结果。

eager 激活同一包时，如果后续工具启动失败，会停止本次包代际已取得的资源并拒绝该代际继续调用。其他包的资源保留。不同代际的进程键分别管理，旧进程退出不会删除新代际的实例。

## 取消和停止

宿主先登记调用 owner，再启动传输；输入在登记时拍摄 JSON 快照，等待调度期间修改调用方对象不会改变实际发送的参数。调用取消和宿主期限都会进入相同清理流程。

HTTP 调用取消时销毁自己的连接；oneshot 取消时关闭输入、终止直接子进程并等待其退出。stdio 复用一个进程，无法证明服务正确遵守取消通知，因此取消任意在途调用会终止该共享进程并拒绝其余在途请求，不自动重试；后续独立请求才创建新进程。调用方不能把其他请求被连带取消当作未产生效果。

停止插件先阻止该代际的新调用，再取消并等待它的 HTTP、oneshot、stdio 调用和受管理进程。只有宿主显式激活才能解除该代际的停止标记；激活等待旧代际排空时若收到更新的停止请求，会拒绝该次激活，不覆盖最新停止意图。关闭整个 runtime 拒绝所有新调用，重复 close 等待同一个完成结果；同一代际同时发生的 stop 也共享完成结果。停止一个包不串行等待其他包的业务 I/O。

期限到达和取消只证明宿主已停止等待或关闭本地传输，不能证明远端写入已回滚。任务的重放与不确定效果继续由原 operation/journal 协议处理，外部工具运行时不根据退出码、限额或取消自动重派。

## 参数 Schema 与实际执行

`inputSchema` 可以内联或指向包内 JSON 文件，根必须为 `object`。内联 Schema 在发现时检查，文件 Schema 在激活/构造工具目录时检查，最多 64 KiB；文件不存在、越出包目录、非普通文件、无效 JSON 或不支持的断言都拒绝，不远程加载引用。

支持的断言与[配置 Schema](plugin-data-contracts.md)一致：`type`、标量 `enum`、`properties`、`required`、布尔 `additionalProperties`、`items`、数组/字符串长度及数字上下界。工具额外允许字符串 `title` 和 `description`，只用于模型目录。`$ref`、`anyOf`、`pattern`、`default` 等不受支持，不会被静默忽略。未声明 Schema 时使用开放对象合同；不自动补默认值、转换类型或删除未知字段。

工具 `validate` 和最终实际调用均检查同一合同。模型参数、Hook 改写及审批修改在执行器中重新校验；直接调用 `execute` 或 `runtime.call` 也不能绕过。非法参数不发送 HTTP、不启动子进程、不向 stdio 写请求。Schema 快照在当前运行时固定，改源文件或模型可见的目录对象不会削弱已有校验器；更新按原插件刷新和代际规则重新发现。

工具输入保留默认 1 MiB 字节预算，宿主可以收紧；最多 8192 个 JSON 节点、深度 16。Schema 最多 256 个节点、每对象 64 个属性，Schema 及其 JSON 表示都有深度限制。非 JSON 值、循环、`undefined`、`NaN`、自定义 `toJSON` 和超限输入拒绝，不能通过序列化丢值改变调用。错误代码为 `PLUGIN_TOOL_SCHEMA_INVALID` 或 `PLUGIN_TOOL_INPUT_INVALID`，不回显参数值或原 Schema 文件内容。

此前仅用于模型目录的 Schema 现在会约束实际执行。依赖不支持断言、缺少 `type` 或根不是 object 的旧 Schema 需要调整。具体实现与验收见[参数合同审阅](../superpowers/reviews/2026-11-05-plugin-tool-input.md)。参数格式通过仍须满足业务权限，也不表示结果已经正确。

## 隔离和后续规范

本轮管理直接子进程，不构成后代进程树、文件、网络或系统调用的 OS 沙箱。`workspace`、子进程 `network` 和 `shell` 字段仍是声明信息；启动时不加 shell 包装，也不能阻止可执行程序自行创建 shell。子进程环境沿用宿主传入值，最小环境和凭据引用尚未统一落地。

参数校验使用上述明确支持的有界方言，不宣称支持完整 JSON Schema 或输出结果验证。分端 UI SDK、最小环境、统一 MCP/Channel 预算和任意进程内扩展的强撤销仍需后续完善。整个插件规范的目标与当前已交付范围见[规范草案](../superpowers/specs/2026-11-05-plugin-specification.md)。
