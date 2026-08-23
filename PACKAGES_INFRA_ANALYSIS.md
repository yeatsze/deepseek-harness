# packages 基础设施层深度研究文档

> 覆盖 api / typert / sdk / boot / bundle / util / runtime-diagnostics / identity 八个子文件夹。

## 1. packages/api — API 传输层

### 1.1 dsh-api-remotes（src/ 共 327 行）

Host BFF 组装层和 Remote 贡献装配入口。

#### remote-events.ts（29 行）

定义 API_REMOTE_FORWARDED_EVENTS 允许列表——11 个宿主事件被原样转发到浏览器端：

    agent-preset/selected
    commands/change
    credentials/updated
    cordis/request-run
    cordis/request-run-resolved
    cordis/dynamic-package
    cordis/dynamic-retract
    cordis/inspect-query
    cordis/inspect-query-resolved
    llm/adapters-updated
    settings/document-updated

这是唯一的事件转发控制点。转发一个新事件只需要在这个数组中添加一行。

index.ts 中 `API_REMOTE_FORWARDED_EVENTS satisfies readonly TypertForwardableEvent[]` 编译期断言确保每个事件名是真实声明的非 scoped 单向事件。

#### client/index.ts

平台无关的 Client 端组装挂载五个生成的 Remote namespace：

- commandsRemote（来自 dsh-commands/remote）
- goalsRemote（来自 dsh-goal/remote）
- dynamicRemote（来自 dsh-cordis-host-runner/remote）
- pluginInventoryRemote（来自 dsh-host-plugin-inventory/remote）
- messageFeedbackRemote（来自 dsh-message-feedback/remote）

每个通过 ctx.remote.$mount(contribution) 挂载失败时逆序 unwind 已 mount 的。

同时 re-export Connection 的全部 wire 类型使业务包只需 import 这一个 assembly 包。

### 1.2 dsh-api-gateway（src/ 四个文件）

Typert Gateway 是 transport independent 的 RPC 调度器。

#### types.ts

InvokeRemoteRequest 接口：

- namespace: Remote namespace 名（如 "commands"）
- method: Service 方法名（如 "execute"）
- args: named wire values 必须精确匹配 descriptor
- signal: carrier 或 direct caller 取消信号仅注入 cancellation aware 方法

17 种 TypertGatewayErrorCode 覆盖了从 endpoint 解析到结果验证的完整错误谱系：

ambiguous-endpoint / arguments-invalid / binding-invalid / context-failed / context-not-found / context-unavailable / definition-unavailable / input-invalid / invocation-unavailable / lookup-failed / lookup-not-found / lookup-unavailable / method-unavailable / provider-mismatch / result-invalid / service-unavailable / signature-invalid

#### index.ts — TypertGatewayService

注入 typert registry 提供 invoke(request) 方法。

invoke 完整流程：

1. 从 registry 查找 namespace 对应的 binding（generated descriptor）
2. 验证 method 存在于 descriptor.methods 中
3. 用 codec.validateArgs(descriptor, args) 校验参数
4. 通过 lookup provider 解析 service instance：
   - 例如 commands namespace 的 lookup 是 session lookup
   - resolve(sessionId) 返回活的 CommandRegistry 实例
   - lookup 拒绝时保留 TypertLookupFailure payload 不折叠为 infrastructure failure
5. 从 service instance 上取出方法函数
6. 构造调用参数：按 descriptor.parameters 顺序从 args 中取值 cancellation-aware 方法额外注入 signal
7. await method(...args)
8. codec.validateResult(descriptor, returned) 校验返回值
9. 返回结果

carrier cancellation 竞态处理：如果 signal 在业务执行期间 abort 结果被丢弃并抛出 RemoteInvocationCancelled。

Gateway 不知道 HTTP WebSocket 的存在物理 transport 由 client-connection 包包裹。

## 2. packages/typert — 类型化远程调用框架

四个子包构成完整的 RPC 类型安全基础设施。

### typert-protocol（3 文件）

远程装饰器和显式 Gateway 绑定 backed only by private module state。

核心类型：

- TypertCodec: validateArgs + validateResult + encode + decode
- TypertContextMap / TypertLookupMap: declaration merging 表声明哪些 scope key 存在
- TypertRemoteNamespace: 方法描述符集合
- TypertLookupDefinition: parameter/wire/hostTypeSymbol/wireTypeSymbol/resolve

isTypertRemoteSegment(value) 验证名字符合 Connection endpoint grammar /^[A-Za-z0-9_$.-]+$/ 且不为 . 或 ..

TypertLookupFailure 泛型 Error 保存 adapter owned failure payload Gateway 保留而非折叠为 infrastructure failure。

### typert-generator（9 文件）

构建时代码生成器从带 @typert 标记的 Service 类生成 JSON schema 和 TypeScript client stub。扫描 JSDoc @typert 标记解析方法签名生成 wire descriptor。

### typert-loader（2 文件）

Cordis loader entry 扫描所有包的 generated remote contributions 并注册到 typert registry。

### typert-registry（5 文件）

Host side registry 管理 namespace 到 binding 的映射处理 $mount $on $dispatch 生命周期。Client 端的 ctx.remote 就是这个 registry 的 client face。

## 3. packages/sdk — SDK 协议与服务端

三个子包实现 ACP 底层的 JSON-RPC 传输协议。

### sdk-protocol（4 文件）

JSON-RPC 2.0 wire 协议的 zod schemas 和类型定义包括 request/response/notification/error 的完整编码解码。

### sdk-server（3 文件）

通用 JSON-RPC server over duplex stream 可以跑在 stdio WebSocket 或任何 Node.js duplex stream 上。处理 request routing error formatting notification broadcasting。

### sdk-client（6 文件）

TypeScript SDK 客户端连接管理 typed method proxies 自动重连 pending request tracking。

## 4. packages/boot — 启动胶水

### dsh-cmdline

解析 process.argv 并提供 ctx.cmdlineArgs 服务。各 surface bundle 的 startup provider inject 此服务来读取自己的 flags。支持 --help 自动生成和 flag validation。

### dsh-app-boot

addHarnessSourceSection(ctx, root) 注册源码目录到 system prompt 使 agent 能读取自身代码。其他共享的 boot-time 初始化逻辑。

## 5. packages/bundle — Profile 组合包

三个预置组合包每个包含一个 cordis.patch.yml 和可选 src 运行时 glue 插件。

### dsh-base

共享核心插入所有基础插件行：模型适配器 tools persistence 策略 settings credentials telemetry host-level subagent providers。不依赖不挂载 Codex Claude Code provider——这些由 Agent Preset 决定是否给 agent 加对应的 delegation tools。

### dsh-web-app

叠加在 base 上设置 coding persona 插入 Web host rows webserver apiproxy workspace projection cache storage 浏览器插件 roster HMR chain frontend-static。

web-runtime glue 插件（src/index.ts）职责：

1. resolveDistIndex(): createRequire(import.meta.url).resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
2. resolveLanTrust(bindHost, extra): bindHost 为 0.0.0.0 时收集非 internal IPv4 地址作为 lanAddresses；trustedHosts = [...lanAddresses, ...extra]
3. FrontendStatic 挂载 dist serving
4. surfaceContext=true 时注册 app:web-surface prompt section 和 DSH_WEB_URL shell env variable
5. printUrl=true 时等 Loader tree settled 后打印 URL 行避免 sibling failure 时公告 dead app

web-startup provider（src/startup.ts）解析 --host --port --trusted-host flags 注入 ctx.cmdlineArgs 提供 webStartup service。flag-configured 行通过 !!js ctx.webStartup.host 等 lazy expression 读取确保 help 不绑端口。

### dsh-headless

同 base 但不挂 web 相关行用于一次性 headless 任务。

## 6. packages/util — 零依赖工具集

七个子包全部无外部运行时依赖：

| 子包 | 核心导出 | 用途 |
|---|---|---|
| brand | Branded T 类型函数 | 编译时品牌化字符串防止混用 |
| home-paths | dshHomePath() | ~/.dsh 下的标准路径 |
| launch-environment | 环境检测 | Node 版本平台检测 |
| timeout | AbortSignal timeout 辅助 | 可组合的超时控制 |
| output-retention | 截断策略 | 工具输出大小限制 |
| 其他 | ... | 各类小工具 |

## 7. packages/runtime-diagnostics

dsh-invariants 提供 InvariantInstaller 接口。每个 package 可有一个 invariant.ts companion plugin 在启动时注册运行时不变量检查器。检查失败 fail loud 报告违反的具体不变量。

## 8. packages/identity

dsh-anonymous-user-id 生成并持久化匿名用户 ID 用于遥测去重。不涉及真实身份信息。
