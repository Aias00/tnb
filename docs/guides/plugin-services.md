# 类型化宿主服务

插件通过服务取得宿主明确开放的能力。类型化服务引用固定名称、版本、作用域和公开方法；宿主选择工厂，检查声明、授权、依赖及返回接口，并管理调用与清理。插件仍是受信任的进程内代码，服务合同不构成 OS 沙箱。

本轮支持 host 和 contribution 两种作用域。现有 `manifestVersion: 2`、`tnb.host-plugin/v1` 和清单中的 services 字符串保持兼容，不为代码类型增加持久 JSON 字段。可运行的完整样例是 [typed-plugin-service.ts](../../examples/typed-plugin-service.ts)：

当前入口为应用、界面和渠道的 ExtensionContext；Adapter/Worker 继续使用原领域准入合同。服务实例和连接是运行时资源，重启后重新创建，不把旧 active 记录当作已恢复实例。

```sh
bun examples/typed-plugin-service.ts
```

该样例只使用本地临时存储和普通宿主插件，输出 `greeting-example: Hello TNB`，不会调用模型或外部渠道。

## 引用和工厂

SDK 的公开入口是 `tnb/agent/services`；运行时组合入口 `tnb/agent/runtime` 也导出引用和工厂辅助函数。

```ts
import { createServiceRef, provideService } from "tnb/agent/services";

type Greeting = { greet(name: string): string };
const GREETING = createServiceRef<Greeting>({
  id: "example.greeting", version: 1, scope: "contribution",
  methods: { greet: true },
});

const provider = provideService(GREETING, scope => ({
  greet(name) {
    if (typeof name !== "string" || !name.trim() || name.length > 128) {
      throw new Error("Invalid greeting name");
    }
    return `${scope.consumer!.plugin.name}: Hello ${name}`;
  },
}));
```

`GREETING.name` 为 `example.greeting/v1`，仍是清单 services 和宿主 grants 使用的名称。服务版本是 1 至 999 的正整数，与包 SemVer、清单版本、贡献 version 和内容指纹分别管理。改变不兼容的方法语义或参数合同应发布新的服务版本。

公开接口只包含方法，所有方法必须在 methods 中声明。宿主检查工厂结果包含这些函数，绑定它们原始的 this，并只返回冻结的方法门面；工厂内部数据、私有方法和底层 Runtime 不随对象一起泄露。引用按 id、版本、作用域和排序后的方法名匹配，独立 bundle 不需要共享同一个对象或 Symbol。

TypeScript 会推导 `context.service(GREETING)` 的返回类型，参数类型错误或调用未声明方法会被类型检查拒绝。运行时的方法检查不等于 JSON Schema 或业务权限校验；服务仍须验证不可信参数，正如示例中的 name。正常调用保留方法本身的返回值；准入失败会在调用前抛出 `PluginServiceError`，异步服务的调用方也应使用 try/await/catch 处理。

## 声明 授权和依赖

贡献的清单继续使用服务名称：

```json
{
  "id": "welcome", "version": "1", "entry": "index.mjs",
  "services": ["example.greeting/v1"]
}
```

宿主通过 `extensions.start({ store, serviceProviders: [provider], grants })` 或 `openAgentRuntime({ serviceProviders, serviceGrants, ... })` 选择提供者并授权插件。声明、grant、提供者存在和合同匹配同时满足后才可取得句柄。声明只表达需求，不授予权限；插件不能通过该 API 注册或替换宿主工厂。

服务表和 grants 是本次启动的快照，修改设置文件通过重启生效；本轮不提供设置文件的即时热撤权。

工厂在首次取得该作用域的服务时同步创建接口。需要异步初始化的资源通过接口方法打开；原生 async 工厂在执行前拒绝。伪装成同步函数但返回 Promise 的工厂也不会发布服务，宿主会追踪已经开始的 Promise 并等待它结束，不能假定报错就没有代码还在运行。

提供者之间的依赖通过 `provideService(REF, create, [DEPENDENCY_REF])` 声明，工厂只能通过 `scope.service(DEPENDENCY_REF)` 取得已声明依赖。它与贡献 manifest 中的 requires 是两张不同的依赖图。提供者依赖由宿主审核，不会自动把底层依赖作为插件可直接取得的服务；需要直接使用时，插件仍要另行声明并获 grant。

宿主装配时拒绝重复提供者，以及 services 旧值表和 serviceProviders 新工厂同名。缺失、循环、合同不匹配及 host 依赖 contribution 作用域在工厂执行前检查，受影响的贡献失败，其他独立贡献仍可启动。无效或缺方法的工厂只初始化一次，不因为另一处 service lookup 自动重试。

## 实例和生命周期

| 作用域 | 工厂实例 | 工厂可见身份 |
| --- | --- | --- |
| host | 一个宿主共享一个实例 | 只有宿主 signal，没有消费者身份 |
| contribution | 每个应用或界面贡献独立实例；渠道按每条连接独立实例 | 原包身份和贡献 kind/id/version |

共享 host 实例不意味着消费者共享权限：每个根句柄都检查自己的消费者生命周期和 grant。贡献停止后，保存的根对象或提取出来的方法不能开始新调用；另一个仍活跃的贡献继续使用自己的句柄。调用方不能依赖不同 lookup 返回对象的引用相等性，稳定的是工厂实例及其作用域。

工厂 context 提供 `signal`、`consumer`、`assertActive()`、受声明约束的 `service(ref)`、`track(operation)` 和 `onDispose(callback)`，不自动注入 env、原始 SQLite、Runtime 或宿主控制 key。取得部分资源后立即登记清理。异步打开的资源在返回时如果作用域已关闭，必须先关闭资源再失败，不能把失效资源交给插件。

根方法返回的 Promise 自动纳入等待。返回的嵌套业务句柄需要服务作者明确实现生命周期，并使用 track 管理异步方法：

```ts
return {
  open() {
    scope.assertActive();
    return {
      work: () => scope.track(async () => {
        const prepared = await prepare(scope.signal);
        scope.assertActive();
        return commit(prepared, scope.signal);
      }),
    };
  },
};
```

track 在派发前检查作用域，取消可以阻止尚未开始的工作。已经开始的业务写入仍需原有幂等和回执协议；取消不证明效果被回滚。共享 host 服务不得借嵌套对象永久保存用户、Run 或调用权限，需要这种能力时应通过 contribution 服务建立受限句柄。当前没有通用 Run/call 作用域，也不会递归代理任意返回对象。

关闭先拒绝新调用并取消 signal，再等待在途方法和嵌套 track 工作，之后按依赖逆序释放实例；即使依赖是后续方法中才首次取得，顺序也不依赖创建时机。贡献实例先于共享 host 实例关闭。所有清理回调都会执行，错误汇总报告；重复关闭等待同一完成结果。进程内方法若忽略取消，关闭继续等它实际结束，不能用超时伪造静止。

## 默认产品服务

| 服务 | 作用域 | 已实现的边界 |
| --- | --- | --- |
| tnb.runtime.read/v1 | host | 只发布 runs/status/configuration 三个读取方法，消费者结束后根句柄失效 |
| tnb.tasks/v1 | contribution | 工作目录视图检查 owner signal；info/detail/command 纳入等待，attention 流随 owner 关闭 |
| tnb.collaboration/v1 | contribution | 业务 bridge 和嵌套异步任务纳入等待；保留原 Source/actor/Run 所属校验及排空记账 |
| tnb.channels/v1 | contribution | 连接继承消费者 signal，按连接拥有服务实例和清理；关闭一条连接不影响其他连接 |

渠道注册表的 `connect(descriptor, configuration, signal?)` 新增可选取消信号。旧两参数调用仍有效，原渠道包身份、历史绑定及通知回执不变。宿主等待完整的连接构造及失败清理，不只等待 port 被创建。

## 旧接口兼容

`context.service<T>("name")` 可以继续取得新工厂的受管理根句柄，但类型仍由旧调用方自行断言。只提供 `services: Map<string, unknown>` 的宿主保留旧原始值语义，不被描述为已具备新作用域和撤销保证；类型化引用不会把该值表冒充已验证提供者。

迁移时由宿主显式选择服务合同和适配方式：

```ts
const provider = provideService(REF, scope => createScopedService(scope.signal));
// serviceProviders: [provider]，并移除旧 services Map 中同名条目。
```

若仅返回一个既有共享对象，作者必须选择符合其真实生命周期的 scope，并处理其嵌套资源；provideService 不会凭空隔离任意闭包。

服务 API 的错误区分不可用、合同不匹配、依赖错误、作用域结束和工厂无效。现有贡献 inventory 仍用 error 字符串展示，包含这些错误码；这不表示全部插件诊断已迁移成统一结构化协议。配置 Schema、持久状态迁移、Run/call 作用域、强制热撤销和受限进程执行仍是后续规范，见[插件规范](../superpowers/specs/2026-11-05-plugin-specification.md)。
