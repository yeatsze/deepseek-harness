# packages/core/agent-loop 全部源码深度分析

> 覆盖 src/ 下全部 6 个文件共 1643 行。每个函数逐行解读，标注行号和设计决策。

## 文件清单与依赖关系

```
index.ts (713)     ← AgentLoop Service：工厂、生命周期管理、配置启动
agent.ts (496)     ← ReactLoopAgent：turn/step 驱动器（另有独立文档）
tool-calls.ts (289) ← 工具调用调度器
runtime-context.ts (76) ← RuntimeContextProjection
constants.ts (6)   ← DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10
invariant.ts (63)  ← 请求重建不变量检查器
```

依赖方向： index.ts → agent.ts → tool-calls.ts → tools registry
           index.ts → runtime-context.ts → session surface
           invariant.ts 独立注册为 companion plugin

---

## 1. constants.ts（6 行）

```ts
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10
```

默认并行工具调用上限。可通过 cordis.yml `maxParallelToolCalls` 配置覆盖，也可通过 settings namespace 运行时修改。

---

## 2. index.ts（713 行）— AgentLoop Service

这是插件入口，负责三件事：
1. 作为 AgentFactory 生产和管理 Agent 生命周期
2. 处理 declarative config agents 的启动
3. 注册 settings section 支持运行时调整并行度

### 2.1 INACTIVE_STATES 常量（行 33-37）

```ts
const INACTIVE_STATES: ReadonlySet<FiberState> = new Set([
  FiberState.UNLOADING,
  FiberState.DISPOSED,
  FiberState.FAILED,
])
```

这三种 Cordis fiber 状态意味着插件正在关闭或已失败不能再接受新的 Agent 创建请求。PENDING 和 ACTIVE 状态视为活跃。

### 2.2 FactoryOwnership 类（行 40-90）

管理工厂级别的所有权跟踪包括活跃 agent 的 teardown 和配置启动任务。

**私有状态**：

- `accepting = true`：是否仍接受新工作
- `teardown: AbortController`：工厂 teardown 时 abort 所有等待的操作
- `inactive: PromiseWithResolvers<void>`：teardown 开始时 resolve 让 waitWhileActive 返回
- `liveAgents: Set<() => Promise<void>>`：每个活 agent 的 dispose 函数
- `startupTasks: Set<Promise<void>>`：尚未完成的启动任务

**signal getter（行 50-52）**：返回 teardown.signal 供外部监听工厂卸载事件。

**isActive()（行 54-56）**：
```ts
return this.accepting && !INACTIVE_STATES.has(this.fiber.state)
```
双重检查内存标志和 fiber 状态。

**track(dispose)（行 59-62）**：将一个 dispose 函数加入 liveAgents 集合返回移除函数。每个已发布的 agent 通过此方法注册其清理函数确保 factory dispose 时能等待所有 agent 完成 teardown。

**trackStartup(job)（行 65-69）**：追踪配置启动任务。job settle 后自动从集合中移除。这确保 factory dispose 会等待所有仍在进行的启动操作完成。

**trackWrapper(job)（行 72-74）**：包装 createAgent/resume 的返回 promise 使 factory dispose 等待这些公共 API 调用完成。

**waitWhileActive(job)（行 77-79）**：
```ts
await Promise.race([job, this.inactive.promise])
```
等待 job 完成或工厂开始 teardown 以先到者为准。用于 waitForDrainingConfiguredIdentity 中避免在 factory 关闭时永远等一个不会释放的 identity。

**dispose()（行 81-89）**：
```ts
async dispose(): Promise<void> {
  this.accepting = false                                    // 停止接受新工作
  this.teardown.abort(new Error('agent loop is not active')) // 广播 abort
  this.inactive.resolve()                                    // 释放 waitWhileActive
  await Promise.all([
    ...[...this.liveAgents].map(dispose => dispose()),       // 等 all agents teardown
    ...this.startupTasks,                                    // 等所有 startup tasks
  ])
}
```

顺序关键：先设 accepting=false 阻止新创建，然后 abort 通知等待者，最后并行等待全部清理完成。

### 2.3 raceAbort 函数（行 93-106）

```ts
async function raceAbort<T>(operation, signal, id): Promise<T>
```

让一个 Promise 与 signal abort 竞争。如果 signal 先触发则抛出错误（保留原始 reason 如果是 Error 否则包装）。使用 `{ once: true }` 的 listener 在 finally 中移除防止泄漏。

### 2.4 raceAbortCall 函数（行 109-130）

```ts
async function raceAbortCall<T>(operation, signal, id, releaseAbandoned?): Promise<T>
```

比 raceAbort 多一个能力：当 signal abort 导致操作被放弃时可以通过 releaseAbandoned 回调释放操作产生的值（如 SessionPreparation 需要 Symbol.dispose）。

流程：
1. 检查 signal 是否已 aborted 是则立即 throw
2. 启动 operation 为 pending promise
3. raceAbort(pending, signal, id)
4. catch 中如果 signal.aborted 且有 releaseAbandoned 则 fire-and-forget 地释放 pending 结果

### 2.5 resolveMaxParallelToolCalls（行 133-139）

验证并解析 maxParallelToolCalls 配置值。必须是正整数否则 throw。默认 DEFAULT_MAX_PARALLEL_TOOL_CALLS=10。

### 2.6 assertAgentOptions（行 142-147）

验证 maxTokens 必须是正 safe integer。undefined 表示不限制。

### 2.7 PreparedAgent 接口（行 150-158）

```ts
interface PreparedAgent {
  agent: ReactLoopAgent
  signal: AbortSignal          // 融合了 caller cancel + factory teardown + owner unload
  publish(source): AgentHandle // 进入 registries 并启动机器
  dispose(): Promise<void>     // 反向 teardown（memoized）
}
```

prepare() 返回此接口调用者可以选择 publish 或 dispose。

### 2.8 Context 扩展声明（行 160-185）

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoop: AgentLoop
    configuredAgentIdentities?: ConfiguredAgentIdentities
  }
  interface Events {
    'agent-loop/config-start-failed'(payload): void
  }
}
```

configuredAgentIdentities 由 launcher（如 apps/cli）在 Loader entry mount 前 provide允许 launcher 控制 configured agent 使用哪个 session ID。

config-start-failed 事件通知 identity-bound consumers 某个配置的 agent 启动失败了使其可以 reject 排队的工作而不是永远等待。

### 2.9 LauncherAgentIdentity 和 applyLauncherIdentities（行 195-234）

LauncherAgentIdentity:
```ts
{ id: SessionId; resume: boolean }
```

applyLauncherIdentities(agents, identities):
遍历配置的 agent 条目如果 launcher 提供了对应 id 的 identity 则替换 sessionId/resumeSessionId 字段。resume=true 设 resumeSessionId false 设 sessionId。同时删除另一个字段保证互斥。

### 2.10 Settings Namespace（行 237-253)

```ts
AGENT_LOOP_SETTINGS_NAMESPACE = settingsNamespace('agent-loop')
AgentLoopSettings { maxParallelToolCalls: number }
```

用户可修改的运行时设置严格子集于 Config——agents 数组是 boot-time 的一次性消费存储变更不会有实际效果所以故意排除。

### 2.11 Config 接口（行 255-272）

```ts
interface Config {
  maxParallelToolCalls?: number
  agents: (AgentOptions & {
    id: string              // 配置标签用于日志和新 session ID 前缀
    sessionId?: SessionId   // 可选固定 ID remount 恢复历史
    cwd?: string            // 新 session 的工作目录
    resumeSessionId?: SessionId  // 要恢复的持久化 session
  })[]
}
```

sessionId 和 resumeSessionId 互斥。

### 2.12 validateConfiguredAgents（行 278-293）

检查两个约束：
1. 同一 agent 不能同时指定 sessionId 和 resumeSessionId
2. 不同 agent 不能使用相同的 exact session identity

exactIdentity 计算 resumeSessionId 优先于 sessionId 都没有则跳过检查（匿名 agent）。

### 2.13 AgentLoop Service 类（行 296-711）

#### 构造函数（行 319-382）

```ts
static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']
```

五个必需服务。llm/tools/systemPrompt 通过类型空导入激活 Context merge 但不需要在此处显式引用——ReactLoopAgent 通过 loopCtx 访问它们。

构造函数详细流程：

**行 321-334：构建 config 和 settings**

```ts
const entry: AgentLoopSettings = {
  maxParallelToolCalls: resolveMaxParallelToolCalls(config.maxParallelToolCalls),
}
let source: () => AgentLoopSettings = () => entry
this.config = {
  ...config,
  agents: applyLauncherIdentities(config.agents, ctx.get(CONFIGURED_AGENT_IDENTITIES_KEY)),
  get maxParallelToolCalls() {
    return source().maxParallelToolCalls
  },
}
```

关键设计 maxParallelToolCalls 用 getter 而不是静态值——settings 变更通过 setSource 替换 source 函数使下次读取拿到新值。tool-calls.ts 中 runGroup 在每个 group 开始时解构这个值所以 committed change 影响下一个 group 不影响 in-flight group。

**行 335-345：installSettingsSection**

```ts
installSettingsSection(ctx, AGENT_LOOP_SETTINGS_NAMESPACE, AGENT_LOOP_SETTINGS_SCHEMA, entry, {
  validate: value => void resolveMaxParallelToolCalls(value.maxParallelToolCalls),
  setSource: (current) => { source = current },
  onChange: () => {},
})
```

validate 回调拒绝非法值保持 running scheduler 使用 last good cap。setSource 替换 source 函数使 config getter 读到新值。

**行 346-350：核心 effect 注册**

```ts
validateConfiguredAgents(this.config.agents)
this.ownership = new FactoryOwnership(ctx.fiber)
this.runtime = { ctx }
ctx.effect(() => () => this.ownership.dispose(), 'agentLoop.transactions()')
ctx.effect(() => ctx.agents.setFactory(this), 'agentLoop.setFactory()')
```

runtime 用 plain holder 包裹 ctx 防止 Cordis service proxy 将 factory 的 dependency context 通过 caller shadow 重绑定。

两个 effect 的顺序很重要：先注册 ownership.dispose 再 setFactory。fiber unload 时按 LIFO 顺序执行 disposer 所以 setFactory 的 disposer 先执行（撤销 factory registration）然后 ownership.dispose 执行（teardown all agents）。这保证了在 agents 还活着时 registry 就不再暴露 factory。

**行 351-353：注册 prompt variables**

```ts
ctx.systemPrompt.variable('provider', context => context.agent?.options.provider)
ctx.systemPrompt.variable('model', context => context.agent?.options.model)
ctx.systemPrompt.variable('cwd', context => context.agent?.session.header.cwd)
```

全局变量供 persona template 使用如 "Your working directory is {{cwd}}"。

**行 355-381：处理配置的 agents**

遍历 config.agents 对每个条目分三种路径：

路径 A 无 resumeSessionId 且无 persistence（行 361）：
```ts
this.create(configuredId, options, meta)
```
直接同步创建。

路径 B 无 resumeSessionId 但有 persistence（行 363-367）：
```ts
const startup = this.restoreOrCreateConfigured(ctx, persistence, configuredId, options, meta)
  .catch(error => reportConfiguredStartupFailure(...))
this.ownership.trackStartup(startup)
```
尝试恢复如果不存在则创建。异步需要 trackStartup。

路径 C 有 resumeSessionId（行 370-380）：
```ts
ctx.effect(() => {
  const fiber = ctx.inject(['sessionPersistence'], (childCtx) => {
    void this.resumeWith(ctx, childCtx.sessionPersistence, {...}).catch(...)
  })
  return fiber.dispose
}, `agentLoop.resume(${id})`)
```
需要注入 sessionPersistence 服务使用子 fiber 等待服务可用。

#### reportConfiguredStartupFailure（行 385-404）

```ts
if (!this.ownership.isActive()) return  // factory 正在关闭则静默
this.ctx.logger.warn(...)               // 日志
// 手动 dispatch emit 事件包含 listener error containment
```

发射 agent-loop/config-start-failed 事件手动实现 listener isolation（同 agentEvents.emit 的模式）。

#### restoreOrCreateConfigured（行 407-428）

```ts
await this.waitForDrainingConfiguredIdentity(ownerCtx, sessionId)
if (!this.ownership.isActive()) return
try {
  await this.resumeWith(ownerCtx, persistence, { resumeSessionId: sessionId, agentOptions })
  return
} catch (error) {
  if (!this.ownership.isActive()) return
  // 只有 genuinely absent 的 artifact 才 fallback 到 first creation
  // corruption 和 backend failures 保持 loud
  const exists = (await persistence.list()).some(header => header.id === sessionId)
  if (exists) throw error
}
this.create(sessionId, agentOptions, meta)
```

恢复优先策略：先尝试 resume 如果失败且 persistence list 中确实不存在该 id 则 fallback 到 fresh create。corruption 或 backend 错误时 list 中存在该 id 直接 rethrow 不静默降级。

#### waitForDrainingConfiguredIdentity（行 431-451）

等待同 ID 的前一个 lifecycle 完成 registry teardown。

```ts
if (ownerCtx.agents.get(sessionId) === undefined 
    && ownerCtx.sessions.get(sessionId) === undefined) return  // 已经空闲
```

如果还有占用者则监听 agent/disposed 和 session/disposed 事件直到两者都清空。waitWhileActive 确保 factory teardown 时不会永远等。

#### prepare() 方法（行 459-578）

这是最复杂的方法构建完整的 Agent lifecycle 包括 driver scope 和 memoized teardown。

**前置检查（行 460-471）**

```ts
assertAgentOptions(options)
ownerCtx.fiber.assertActive()
if (!this.ownership.isActive()) throw ...
if (callerSignal?.aborted) throw ...
```

四重检查：options 合法 owner fiber 活跃 factory 活跃 caller 未取消。

**Abort 融合（行 479-487）**

```ts
const abort = new AbortController()
const onCallerAbort = (): void => { abort.abort(callerSignal?.reason ...) }
const onFactoryTeardown = (): void => { abort.abort(this.ownership.signal.reason) }
callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
this.ownership.signal.addEventListener('abort', onFactoryTeardown, { once: true })
```

三个 abort 来源融合为一个 controller：
1. caller 显式取消
2. owner fiber unload
3. factory teardown

在任何资源存在之前就注册 listener 确保 setup 过程中收到 abort 能正确回滚。

**Memoized Teardown（行 497-520）**

```ts
const dispose = (ownerTriggered = false): Promise<void> => 
  (disposing ??= (async () => { ... })())
```

`disposing ??=` 确保只创建一次 teardown promise 后续调用共享同一个。

teardown 流程：
1. abort.abort('lifecycle disposed')
2. 移除 abort listeners
3. 等待 machine ready（可能在 machine 还没创建时就开始 teardown）
4. machine.cancel({ kind:'disposed' }) — 触发 AbortSignal
5. await machine.whenIdle() — 等 turn 自然结束
6. await machine.scope.dispose() — 级联清理所有 agent-scoped registrations
7. detachAgent/detachSession 从 registries 移除
8. untrack 从 factory ownership 移除
9. unfollowOwner 清理 owner effect（非 ownerTriggered 时）

**Owner Fiber Effect（行 522-537）**

```ts
unfollowOwner = ownerCtx.effect(() => () => {
  if (disposing !== undefined) return  // 已在 teardown 中
  abort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
  return dispose(true)
}, `agentLoop.lifecycle(${id})`)
```

owner fiber unload 时自动触发完整 teardown。如果 teardown 已经在进行中则跳过（disposing 非 undefined）。

**Machine 创建和 publish 接口（行 540-578）**

```ts
const agent = machine = new ReactLoopAgent(loopCtx, id, options, session)
machineReady.resolve()
```

此时 agent 已创建但未发布到 registries。machineReady resolve 让 teardown 知道 machine 存在了。

publish(source) 回调：
```ts
detachSession = agent.ctx.sessions.enter(session)
detachAgent = loopCtx.agents.enter(agent, ownerCtx.agent)
agent.ctx.sessions.announce(session)
loopCtx.agents.announce(agent)
emitAgentEvent(loopCtx, agent, 'agent/session-start', { source })
return { agent, dispose }
```

enter 将 session/agent 加入各自 registry 并挂载 publication hooks。announce 发射 created 事件同步 throw 可以回滚 enter。最后发射 agent/session-start 事件 source 标记是 startup 还是 resume。

多次 assertLive() 检查确保 announce listener 没有同步触发 teardown。

#### create() 方法（行 589-598）

```ts
create(id, options, meta): Agent {
  using preparation = SessionPreparation.create(
    this.runtime.ctx.sessions.prepare(id, { meta })
  )
  const prepared = this.prepare(this.ctx, id, options, preparation.session)
  try {
    return prepared.publish('startup').agent
  } catch (error) {
    void prepared.dispose()
    throw error
  }
}
```

using 声明确保 preparation 在正常退出或异常时都 dispose。publish 失败时显式 dispose prepared resources。

SessionPreparation 是 dsh-session 包提供的 helper 封装了 session 的 prepare-enter-announce 分离模式。

#### createAgent() 方法（行 606-622）

```ts
async createAgent(ownerCtx, options): Promise<AgentHandle>
```

编程式创建接口供 ACP 等自动化使用。异步版本支持 caller cancellation signal。使用 trackWrapper 让 factory dispose 等待完成。

#### setupAndPublish()（行 625-645）

```ts
using ownedPreparation = preparation
const prepared = this.prepare(ownerCtx, id, agentOptions, session, signal)
try {
  const setupCommit = await raceAbort(setup?.(prepared.agent.ctx), prepared.signal, id)
  setupCommit?.commit()
  return prepared.publish(source)
} catch (error) {
  await prepared.dispose()
  throw error
}
```

setup callback 在 publish 之前运行可以访问 agent.ctx 注册额外的 tools/prompt sections。setupCommit 允许同步验证在 publication commit point 执行。

#### resume() 和 resumeWith()（行 653-710）

resume 检查 sessionPersistence 服务存在后委托给 resumeWith。

resumeWith 详细流程：

```ts
const published = (async () => {
  // 三源融合 abort
  const fused = AbortSignal.any([callerSignal?, ownerAbort.signal, ownership.signal])
  
  // 加载 persisted session
  preparation = await raceAbortCall(
    () => persistence.prepare(id, fused),
    fused, id,
    (abandoned) => abandoned[Symbol.dispose]()  // 释放被放弃的加载结果
  )
  
  // 二次检查
  ownerCtx.fiber.assertActive()
  if (!ownership.isActive()) throw
  
  // setup + publish
  return await setupAndPublish(ownerCtx, id, preparation, ...)
})()
ownership.trackWrapper(published)
return published
```

persistence.prepare(id, signal) 从磁盘加载 session events 和 header 构建 SessionPreparation。raceAbortCall 确保永不 settle 的 backend 不会 pin 住 identity。

---

## 3. tool-calls.ts（289 行）— 工具调用调度器

### 3.1 数据结构

```ts
interface PlannedCall {
  block: ToolCallBlock        // 模型发出的原始 call block
  exec: ToolExecutionInput    // 解析后的执行输入
}

interface Slot {
  exec: ToolRunContext        // 执行上下文
  result: ToolExecutionResult // 执行结果
  needsPost: boolean          // 是否需要 post-execute waterfall
}

interface GroupOutcome {
  consumed: number    // 本组消费了多少 calls
  aborted: boolean    // 是否因 abort 提前结束
  concluded: boolean  // 是否有 result 标记 concludesTurn
}
```

### 3.2 executeToolCalls 主入口（行 59-101）

```ts
export async function executeToolCalls(ctx, turn, step, toolCalls, signal, acceptContext)
```

六参数：
- ctx: loop context 拥有 tools registry
- turn/step: 当前回合和步骤编号用于 session event
- toolCalls: assistant message 中的 ToolCallBlock[] 按 model order
- signal: 共享的 step AbortSignal
- acceptContext: 接受工具结果的 additionalContexts 注入到 next-step inbox

**初始化（行 67-80）**

```ts
const agent = ctx.agents.requireInitiator()
const planned = toolCalls.map(block => ({
  block,
  exec: {
    callId: block.id,
    name: block.name,
    arguments: parseArguments(block.arguments),
    agent,
    signal,
  },
}))
```

requireInitiator 从 AsyncLocalStorage 获取当前 Agent 实例。parseArguments 将 JSON string 解析为对象无效 JSON 保留为 raw string 空 string 映射为 {}。

**分组循环（行 82-100）**

```ts
let next = 0
while (next < planned.length) {
  const first = planned[next]!
  const mode = ctx.tools.executionMode(first.exec).kind
  const group = mode === 'parallel' ? planned.slice(next) : [first]
  const outcome = await runGroup(ctx, turn, step, group, mode, signal, acceptContext)
  next += outcome.consumed
  concluded ||= outcome.concluded
  if (outcome.aborted) {
    for (const call of planned.slice(next)) appendSkippedToolCall(session, turn, step, call.block)
    return { concluded }
  }
}
return { concluded }
```

每次迭代根据第一个未处理 call 的 executionMode 决定分组策略：
- parallel: 取剩余全部作为一个 group（runGroup 内部会 barrier）
- exclusive: 只取当前一个作为 barrier group

abort 时为所有未开始的 calls 写入合成 abort result 保持 replay 有效性。

### 3.3 parseArguments（行 104-110）

```ts
function parseArguments(raw: string): unknown {
  try { return raw ? JSON.parse(raw) : {} }
  catch { return raw }
}
```

容错设计：无效 JSON 不抛出而是传原始字符串让工具自己处理或报错。空字符串映射为空对象。

### 3.4 runGroup 核心调度器（行 121-246）

这是整个调度器的核心实现。

**状态变量（行 130-143）**

```ts
const slots: (Slot | undefined)[] = group.map(() => undefined)
const callSeqs: number[] = group.map(() => -1)
let nextToStart = 0      // 下一个要 dispatch 的 index
let committed = 0        // 已按 model order 写入 log 的数量
let started = 0          // 已 dispatch 的总数
let aborted = signal.aborted
let concluded = false
let schedulerFailure: { error } | undefined
```

slots 按 model order 存储已 settle 但未 commit 的结果。callSeqs 存储每个 started call 的 tool/call event seq 供 result 引用。

committed 只沿连续的 model-order slots 前进——不能跳过未完成的 slot 即使后面的已经完成了。

**commitReady（行 146-160）**

```ts
const commitReady = async (): Promise<void> => {
  while (committed < group.length) {
    const slot = slots[committed]
    if (slot === undefined) break       // 前面的还没完成
    const result = slot.needsPost
      ? await ctx.tools[TOOL_RUNTIME_SCHEDULER].finalize(slot.exec, slot.result)
      : ctx.tools[TOOL_RUNTIME_SCHEDULER].finish(slot.exec, slot.result)
    appendToolResult(session, turn, step, call!.block, result, callSeqs[committed]!)
    for (const context of result.additionalContexts ?? []) acceptContext(context)
    concluded ||= result.concludesTurn === true
    committed++
  }
}
```

finalize vs finish：needsPost 表示 pre-execute 阶段产生了 gate decision（如 approval granted）需要额外 post-execute waterfall。finish 只是简单包装。

additionalContexts 是工具产生的需要在下一步骤注入的上下文消息通过 acceptor 写入 inbox。

**startCall（行 164-196）**

```ts
const startCall = async (index: number): Promise<void> => {
  const call = group[index]!
  callSeqs[index] = appendToolCall(session, turn, step, call.block)
  started++
  const prepared = await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)
  switch (prepared.kind) {
    case 'dispatch': {
      const promise = ctx.tools[TOOL_RUNTIME_SCHEDULER].dispatch(prepared.exec).then(
        (outcome) => {
          slots[index] = { exec: prepared.exec, result: outcome.result, needsPost: outcome.kind === 'post-result' }
          return index  // Promise.race 用
        },
        (error) => {
          schedulerFailure ??= { error }  // 只记录第一个 failure
          return index
        },
      )
      inFlight.set(index, promise)
      break
    }
    case 'post-result':
      // pre-execute 阶段就产生了结果 如 denial
      slots[index] = { exec: prepared.exec, result: prepared.result, needsPost: true }
      break
    case 'final-result':
      // 完全跳过了 body 如 caller 已 abort
      slots[index] = { exec: prepared.exec, result: prepared.result, needsPost: false }
      break
  }
}
```

prepare 返回三种结果：
- dispatch: 需要实际执行工具 body 异步放入 inFlight
- post-result: policy pipeline 产生了结果不需要 dispatch body 但需要 post-execute
- final-result: 最终结果不需要 post-execute

dispatch 的 error handler 不 throw 而是 schedulerFailure ??= 记录第一个错误让 Promise.race 正常 resolve(index)。错误在主循环的 throwSchedulerFailure 点重新抛出。

**fillPool（行 198-213）**

```ts
const fillPool = async (): Promise<void> => {
  while (!aborted && nextToStart < group.length && inFlight.size < maxParallelToolCalls) {
    // Barrier check: 后续 call 可能变成了 exclusive
    if (nextToStart > 0 && mode === 'parallel'
      && ctx.tools.executionMode(nextCall.exec).kind !== 'parallel') break
    await startCall(nextToStart)
    nextToStart++
    throwSchedulerFailure()
    await commitReady()
    throwSchedulerFailure()
    if (signal.aborted) aborted = true
  }
}
```

Barrier 检查在每个 start 之后重新读取 executionMode。如果 parallel pool 中某个后续 call 被 registry 变更改为了 exclusive 则停止填充让外层循环将其作为新的 barrier group 处理。

startCall 内部的 prepare 可能 await（pre-execute waterfall），期间 abort 可能到来。每次 fill iteration 结束都检查。

commitReady 在每次 start 后调用因为 prepare 可能产生同步结果（post-result/final-result）可以直接 commit。

**主循环（行 218-235）**

```ts
try {
  await fillPool()
  while (inFlight.size > 0) {
    const settledIndex = await Promise.race(inFlight.values())
    inFlight.delete(settledIndex)
    throwSchedulerFailure()
    await commitReady()
    throwSchedulerFailure()
    if (signal.aborted) aborted = true
    await fillPool()
  }
} catch (error) {
  schedulerFailure ??= { error }
  await Promise.allSettled(inFlight.values())  // 等 started dispatches quiescence
  throw schedulerFailure.error                  // 抛出第一个错误
}
```

Promise.race(inFlight.values()) 等待任一 in-flight dispatch 完成。promise resolve 为自己的 index 用于从 Map 中删除。

schedulerFailure 处理：
- startCall 内 dispatch error → schedulerFailure 记录 → throwSchedulerFailure 在安全点重抛
- 外层 catch → 等待所有 in-flight 完成（drain）→ 重抛第一个错误
- drain 时不写合成 recovery results——已有 tool/call 事件保留但没有对应 tool/result

**Abort 处理（行 237-245）**

```ts
if (aborted) {
  for (const call of group.slice(started)) {
    appendSkippedToolCall(session, turn, step, call.block)
  }
  return { consumed: group.length, aborted: true, concluded }
}
if (committed !== started) throw new Error('uncommitted settled calls')
return { consumed: started, aborted: false, concluded }
```

aborted 时：
- 已 started 的 calls 已经在 inFlight drain 中 settle 并 commitReady 了
- 未 started 的 calls 写入合成 abort result（TOOL_ABORTED_BEFORE_DISPATCH）
- consumed = group.length 表示整组都被处理了（虽然部分是合成的）

非 aborted 时 committed 应等于 started（不变量检查）。

### 3.5 辅助函数

**appendSkippedToolCall（行 249-259）**

写入一对 tool/call + tool/result 事件。result content 为 "Error: tool call aborted before dispatch" isError=true error.info.code=TOOL_ABORTED_BEFORE_DISPATCH。

保持 replay 有效性：模型看到每个 tool call 都有对应的 result 即使实际上从未执行。

**appendToolCall（行 262-265）**

```ts
session.append('tool/call', { turn, step, callId, name, arguments })
return event.seq
```

**appendToolResult（行 268-289）**

```ts
session.append('tool/result', {
  turn, step,
  message,       // createToolResultMessage 包装
  ...(result.error?.info ? { error: result.error.info } : {}),
  ...(result.meta !== undefined ? { meta: result.meta } : {}),
}, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
```

meta 字段携带 tool 的 presentation payload（如 diff card 数据）persisted 到 log 供 UI replay 时重现卡片。

sourceEventSeqs: [callSeq] 建立 result→call 的 provenance 链 compaction replace 操作需要它来验证 shadow 范围。

---

## 4. runtime-context.ts（76 行）

已在 AGENT_LOOP_AGENT_TS_ANALYSIS.md 中详述此处补充几个要点：

retained 的三种状态语义：
- undefined: 从未有 snapshot（全新 session 无需投影旧状态清除）
- null: 曾有但已被 replacement shadow（需要投影 CLEARED 消息告诉模型之前的上下文不再适用）
- { seq, text }: 当前活跃 snapshot

isReplacementSurfaceEvent 检查确保只有 compaction replace 操作会清除 retained普通的 append 不影响。

---

## 5. invariant.ts（63 行）

Package-owned request-reconstruction invariant companion。

安装一个 prepend-only 的 llm/stream waterfall listener 检查每个来自 agent loop 的 LLM 请求：

```ts
ctx.on('llm/stream', (options, next) => {
  if (!isAgentLoopRequest(options)) return next()  // 非 loop 请求跳过
  // 六项检查：
  1. Object.isFrozen(options) — 请求必须冻结
  2. options.sessionId !== undefined — 必须携带 session ID
  3. ctx.sessions.get(sessionId) 存在 — session 必须仍然活跃
  4. Object.isFrozen(options.messages) — messages 数组必须冻结
  5. JSON.stringify(request.messages) === JSON.stringify(session.deriveMessages())
     — 请求中的 messages 必须与会话日志重放的结果完全一致
  6. header 匹配检查 model/system/temperature/maxTokens/stop/tools
     — 请求参数必须与最后一条 request/header 事件的 folded 值一致
  return next()
}, { global: true, prepend: true })
```

prepend 保证此检查在任何可能短路链的 replay listener 之前运行。

第 5 项检查最重要——它捕获 log-reconstruction desync 即 deriveMessages() 的增量缓存在某种边缘情况下与完整 fold 结果不一致的 bug。

fail() 函数由 InvariantInstaller 接口提供通常 throw 或记录到诊断系统。
