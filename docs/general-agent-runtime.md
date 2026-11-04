# 通用 Agent 执行能力

TNB 的执行内核可以嵌入非编码应用；持久任务运行时通过场景适配器接入资源、能力和验收。当前提供 Coding 兼容适配层，以及不依赖业务项目目录、Git 或 Shell 的 Research 适配器。仍为 Bun、本机 SQLite、单 owner，不是分布式工作流服务。仓库保持 private，没有发布新的 npm 包。

## 模块与入口

| 入口 / 源码 | 职责 |
| --- | --- |
| `tnb/agent` / `src/agent/index.ts` | 无界面执行内核：模型流、工具调用、授权边界、压缩回调、消息和调用日志接口；不加载 CLI/TUI/Coding 工具 |
| `tnb/agent/runtime` / `src/agent/runtime.ts` | 先获得 owner 锁再开 SQLite，注册适配器，提交持久任务和重启恢复 |
| `src/agent/domain.ts` | 可序列化场景描述、资源声明、能力授权、适配器版本注册和宿主验收接口 |
| `src/services/runtime/` | 原 Run/Task、调度、等待、上下文、预算、回执、产物和恢复协议 |
| `src/adapters/coding/` | 原编码 Worker 组合、文件摘要、编码提示词、工作区及 Shell 验收策略；旧 `runtime/worker.ts` 入口继续转发 |
| `tnb/adapters/research` | 版本化资料读取和报告引用验收；资料客户端由宿主注入 |

`RuntimeConfiguration` 保留旧编码字段以兼容已有 Run 和调用方。通用调用方使用 `host.submit({ namespace, adapter, ... })`，无需填写项目目录、Shell 或编码验收参数。内部 `workspace = agent:NAMESPACE` 仅作为原路由存储的命名空间键，不对它调用 realpath、目录扫描或文件锁。普通 TNB CLI 和 Unix 服务仍默认装配 Coding；本轮通用入口是嵌入 API，不把 `/task` 默认改为研究任务。

## 运行示例

```sh
bun run agent:research-demo
# 传入上一次输出的 directory 重开：复用相同 commandId，不新建同一业务。
bun run agent:research-demo /path/from/previous/output
```

`examples/research-agent.ts` 是可直接执行的离线示例，模型为明确标注的脚本 transport，不调用外部模型。实际运行资料工具、持久调用日志、输入版本检查和适配器验收，输出 Run/Task ID、报告、检查和状态目录。接入真实模型时替换注入的 `transport`、`model`、`route` 和上下文窗口；接入资料库时替换宿主 `readSource` 客户端，核心循环与恢复协议不变。

```ts
import { openAgentRuntime } from "tnb/agent/runtime";
import { createResearchAdapter, researchTask } from "tnb/adapters/research";

const host = await openAgentRuntime({
  directory: "/private/agent-state", // 控制状态，不是业务项目目录
  adapters: [createResearchAdapter({
    model, transport, route,
    readSource: async (id, signal) => documentClient.readVersioned(id, signal),
  })],
});

const { run } = await host.submit({
  commandId: requestId, // 重试沿用；不同业务使用不同身份
  namespace: "team/research",
  objective: "比较两份资料，给出引用与不确定项",
  adapter: researchTask(["docs/account-A/design", "docs/account-A/operations"]),
  mode: "auto", // 也支持 single；multi 仍允许评估后不拆分
  maxTurns: 50, maxModelRequests: 64,
});

// 原持久接口继续可用。
host.store.events(run.runId);
host.runtime.waits.questions(run.runId);
// 退出应用时排空并关闭；下次用同一 directory、原版本适配器重开。
await host.close();
```

上述代码中的 `documentClient`、`transport` 是宿主依赖，不是框架内置服务。`route` 配置价格后才可使用美元预算；未知计价不能视为免费。示例 Research 每任务最多 16 份资料，每份文本最多 8 KiB；更大资料应通过单独的分页工具适配器接入。

## 适配器合同

`AgentDomainAdapter` 包含固定的 `id/version`、同步配置校验、`createWorker`、`snapshot`、`accept`，以及可选的 `reconcile` 查询。描述数据只保存 JSON，包括配置引用、资源和能力授权；连接、凭据、回调和实例留在宿主。不要把密钥放进可持久配置，使用宿主凭据引用。版本代表宿主提供的实现合同，框架无法证明宿主用同一版本号替换的任意代码语义相同。

`snapshot` 必须从真实资源取得版本/摘要，不能使用模型总结；执行前/报告提交时和验收前后检查版本。`accept` 为可安全重放的只读验证，收到候选报告、输入摘要和最近最多 128 项成功工具回执。每项结果预览最多 16,000 字符并显式标记是否截断；缺少必要证据时拒绝，不能从截断内容推断完成。验收至少提供一项检查，最多 64 项，另可附 JSON 证据，整体仍受 1 MiB 产物上限约束。运行时提交 `domain-verified` 表示宿主检查已通过，具体语义由适配器声明。

Research 实际检查每个声明资料是否有成功读取回执和 `[source:ID]` 引用，版本摘要在验收前后保持一致。它不把“引用存在”当成所有论断语义正确的证明。资料客户端必须返回可靠版本和有界文本；模型只能接触其被授权的资料工具。

## 权限、资源与委派

通用工具需通过 `capability: { name, resources, mode }` 声明业务能力。只有描述中明确授予的能力/资源/读写范围才向模型暴露，随后每次调用仍走宿主 `authorize`。资源 ID 必须包含真实后端、账户或租户身份；不同名称指向同一对象时，由适配器负责统一身份。当前只处理精确资源 ID，不自动推断目录、父子关系、别名或远端分布式锁。

资源租约使用同用户协调 SQLite，独立于各运行时状态目录；读读可并行，任一写入与同资源其他访问互斥，多资源原子准入。所有需要的租约获得后才启动 Worker，等待期间不占模型流，暂停/取消和 deadline 仍生效。进程死亡或可验证的 PID 出生身份变化后回收，无法验证的活跃持有者保守保留。这是同机合作协议，不约束非参与客户端，也不保证读写公平排队。

通用子 Agent 沿用现有按需委派、一层只读和父复核协议，scope 改为父合同中的资源 ID。子任务只获得所选资源的 read 声明和原有 read 能力，不继承 write 授权，不允许借 workspace 参数切换到另一命名空间。single 不暴露委派工具；auto 默认直接执行；multi 必须在有界调查后记录策略评估，保留选择单 Agent 的能力。

持久 Worker 不默认接入 Skill/MCP。宿主适配器可以复用原 MCP 桥接器，但须分类能力、限制资源、绑定连接/工具版本并负责重连。未分类的 MCP 工具不会暴露给模型；业务工具授权与 runtime 的等待、回忆、策略和委派控制相互独立。宿主工具实现是受信代码，必须对自身参数、资源范围和执行依赖进行校验；声明不是操作系统沙箱。

## 外部副作用与恢复

工具通过 `effects.replay` 显式声明 `safe` 或 `never`，默认不重放。`execute` 第四参数中的 `operationId` 来自持久调用身份，工具将其作为远端幂等键。使用 `safe` 的外部写入必须由远端幂等协议支持，不能只根据工具名称或 HTTP 方法猜测。

```ts
async execute(input, signal, progress, context) {
  return service.create(input, {
    signal,
    idempotencyKey: context.operationId,
  });
}
```

远端已提交但响应丢失时，日志保留 unknown，Run 暂停。只有宿主显式调用 `runtime.reconcileDomainOperation(taskId, operationId)` 才使用适配器 `reconcile` 查询原操作；查询必须只读，不得重发业务，也不会隐式恢复。未查到确定结果返回 false，继续保持未知。确认后沿原日志保存结果，随后显式 `runtime.resume(runId)`。没有查询能力时，沿原 `runtime.reconcile` 提供人工核对证据。没有实现自动补偿或跨系统 exactly-once 承诺。

重启只重建已注册的精确适配器版本；缺失版本的活跃任务暂停，resume 拒绝。工作期间和验收时核对模型、路由、工具 schema、业务能力、说明及宿主 binding；不兼容变动不能继续旧任务。适配器应将后端稳定身份放入 binding，临时连接版本则通过工具的 `bindExecution` 在每次执行时检查，避免把正常重连误当新业务。

本轮复用原上下文压缩、原始证据归档、持久 wait 和预算，不把摘要作为权限来源。通用运行时支持在 TUI、HTTP 或其他入口之上自行接入，当前没有新增 Web 服务、远端多 owner、任务迁移协议、后台 Skill/MCP 生命周期或自动补偿。
