# 进程插件

业务插件可选择进程内或独立进程执行。进程内继续使用 `definePlugin` 注册；独立进程通过清单声明，宿主不 import 入口。每个应用/界面贡献或渠道连接拥有一个监督进程和一个业务进程；默认进程内插件没有这笔开销。

```sh
tnb plugins init ./my-app --template application --execution process --language typescript
cd my-app
bun install --ignore-scripts
bun run check
```

省略 `--language` 可使用免构建 JavaScript。`application` 和 `channel` 模板支持 `--execution process`；界面可手写 `contributes.interfaces`，合同同应用。Adapter 仍使用宿主管理的模型、工具与验收生命周期，不支持把已有任意 Adapter 函数直接序列化到子进程。

## 声明与入口

```json
{
  "name": "my-app", "version": "0.1.0", "manifestVersion": 2,
  "apiVersion": "tnb.host-plugin/v1",
  "contributes": { "applications": [{
    "id": "my-app", "version": "1", "entry": "index.mjs",
    "execution": { "mode": "process", "protocol": "tnb.process-plugin/v1", "timeoutMs": 30000 },
    "state": { "version": 1 }
  }] }
}
```

一个进程入口只声明一个贡献，不能与进程内贡献共享入口。入口 default 导出 `ProcessPluginDefinition` 对象：

```ts
import { defineProcessPlugin, PROCESS_PLUGIN_PROTOCOL } from "@tnb/plugin-sdk";
export default defineProcessPlugin({
  protocol: PROCESS_PLUGIN_PROTOCOL,
  async start(context) {
    return {
      async handle(request) {
        const row = await context.state.get("message");
        return { status: 200, body: JSON.stringify(row?.value ?? null) };
      },
    };
  },
});
```

宿主先校验来源、指纹、信任和配置，再启动自己的协议 bootstrap；只有子进程 import 插件。旧宿主拒绝新增执行字段，不会把进程对象当作进程内工厂正常运行。编译 CLI 已嵌入 bootstrap，用户不需要另装 Bun 来运行已构建的进程插件；TypeScript 构建仍需要 Bun。

## 宿主传入的内容

`ProcessContext` 只包含插件身份、贡献身份、校验后的显式配置、子进程生命周期信号，以及异步宿主能力代理。渠道的配置来自本次明确连接；应用/界面的配置来自清单 Schema 对应的宿主配置。

- `state.get/list`：只读当前贡献私有记录，返回 `{ id, revision, value }`。
- `state.command(id, input, writes)`：宿主同步事务原子提交最多 32 个 CAS 写入；命令输入包含完整写入列表。同一 ID、相同内容回放原回执；内容变化或 revision 过期拒绝。不能传回调函数跨进程执行。
- `call(ref, method, args)`：类型化服务引用仍须清单声明和宿主授权。仅允许合同中的方法以及 JSON 参数/结果。返回句柄、Response、流、函数等服务需要宿主另外提供 JSON 适配服务，不能静默丢失字段。
- `request(ref, request)`：走原有贡献依赖和授权检查，使用有界 UTF-8 HTTP 投影；没有直接 SQLite、Runtime 或宿主凭据对象。

配置不是凭据仓库。子进程默认不继承父进程环境，使用临时 HOME/TMP/XDG/APPDATA 和最小系统 PATH。需要外部业务凭据时优先通过宿主提供的服务完成操作。

## 故障、取消和边界

协议是带版本握手的 JSON-RPC 2.0 行消息。每帧 256 KiB；HTTP body 128 KiB，UTF-8 文本；单进程最多 32 个在途请求/回调；单宿主模块最多 32 个未关闭进程会话；每个 60 秒计量窗口输入和输出各 64 MiB、宿主回调最多 10000 次，stderr 最多 1 MiB，避免把长时间正常运行的渠道按累计总量终止。超限拒绝或终止进程，不静默截断业务消息。日志使用 stderr，stdout 保留给协议。

调用默认 30 秒，可声明 100–300000 毫秒。初始化至少给 5 秒，避免把冷启动误判为业务超时。关闭在正常连接范围内最多给 500 毫秒合作清理；宿主取消或超时会直接强制回收。POSIX 回收进程组，Windows 使用 `taskkill /T /F`；这些机制不能替代 OS 沙箱或 Windows Job Object 的完整后代约束。

请求已派发后取消，会使同一进程上的其他在途请求一并失败；取消发生在派发前则不必终止其他请求。崩溃、断连、超时后不会自动重启或重发。显式重启 Owner/重新连接渠道才创建新会话。已确认提交的宿主状态保留；外部调用可能已生效，必须用业务幂等键或状态查询核对。进程边界不自动为每个业务服务创建持久副作用日志。

监督进程不运行插件代码，持续观察 Owner 管道。即使业务进程卡在同步死循环，Owner 被强杀后也能触发进程组回收；POSIX 已有真实强杀验证。突然掉电或强杀时临时 HOME 可能留下，操作系统沙箱、磁盘配额及逃逸后代约束不由此监督协议提供。

进程隔离保证可回收阻塞的插件代码，但不限制同用户文件/网络访问，也不限制可信宿主服务自身的同步阻塞。插件仍需信任；需要安全隔离时应另配平台沙箱。当前不支持通过此 HTTP 投影返回 SSE、二进制或 WebSocket；同步记录迁移回调也不能跨进程传递，清单含这些迁移时会明确拒绝，需显式宿主迁移。

完整业务接入见[工单插件](../../examples/plugins/ticket-intake/README.md)；通用作者合同与测试宿主见 [SDK 指南](plugin-sdk.md)。
