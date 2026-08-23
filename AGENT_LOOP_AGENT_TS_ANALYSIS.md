# packages/core/agent-loop/src/agent.ts 逐行深度分析

> 文件共 496 行。这是整个 DeepSeek Harness 系统的心脏——ReactLoopAgent 类驱动一个会话的完整 turn → step → LLM call → tool call → next step 循环。每一行都有行号标注。

---

## 文件结构总览

| 区域 | 行号范围 | 内容 |
|---|---|---|
| imports | 1-36 | 类型导入和值导入 |
| Phase 类型 | 38-46 | 三态状态机定义 |
| 辅助类型 | 48-52 | StepEndReason 和 PreparedStep |
| requestProposal 函数 | 54-61 | 从持久化 header 移除 adapter defaults |
| ReactLoopAgent 类 | 63-496 | 核心 Agent 驱动器 |
| — 构造函数 | 80-97 | 初始化 dispatch/inbox/scope/runtimeContext |
| — status getter | 99-101 | idle 或 running |
| — setPhase | 103-111 | 状态转换 + status 变更广播 |
| — send/followup/steer/inject | 113-132 | 四种消息入口 |
| — cancel | 134-140 | 中止当前活动 |
| — runMaintenance | 142-162 | 独占维护任务 |
| — wakeDriver | 164-193 | 启动或 latch 驱动 |
| — whenIdle | 195-200 | 等待空闲 |
| — throwError | 202-208 | 错误报告 + 重抛 |
| — kick | 210-223 | 驱动循环入口 |
| — preStep | 225-243 | 步骤前准备 |
| — turn | 245-330 | 回合执行 |
| — step | 332-401 | LLM 调用 + 工具执行 |
| — buildRequest | 407-495 | 请求组装 |

---

## 1. 类型定义

### Phase（行 38-46）

```ts
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }
```

三态判别联合，每态携带不同数据：

**idle**: 无活跃工作。`lastTurn` 记录最近完成的回合编号——下次启动时从 `lastTurn + 1` 开始新回合。

**maintenance**: 维护任务独占运行中（如 compaction）。拥有自己的 AbortController 允许取消维护任务。`wakeRequested` latch 在任务完成后重放唤醒。

**running**: 正常 turn 驱动中。额外跟踪：
- `turn`: 当前正在执行的回合约号
- `step`: 当前正在执行的步骤编号
- `abort`: 本轮的 AbortController——cancel() 触发它来中止当前 turn 的所有异步操作

关键不变量：同一时刻只有一个 driver 在 running 状态。所有状态转换都经过 `setPhase()` 保证 status 事件一致性。

### StepEndReason（行 48）

```ts
type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>
```

从 TurnEndReason union 中提取出只有 step 层面能产生的两种结束原因。`aborted` 和 `error` 由 turn() 的 catch 块设置，不由 step() 返回。

### PreparedStep（行 50-52）

```ts
type PreparedStep =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; assembly: PromptAssembly }
```

preStep() 的返回类型。reject 表示插件通过 agent/pre-step waterfall 拒绝了本步骤（如 plan mode 阻止直接执行）。enter 携带要注入的用户消息列表和已组装的提示词。

---

## 2. requestProposal 函数（行 54-61）

```ts
function requestProposal(header: EpochHeader): LlmCallConfig {
  if (header.adapterDefaults === undefined) return header.config
  const proposal = { ...header.config }
  if (header.adapterDefaults.reasoningEffort === true) delete proposal.reasoningEffort
  if (header.adapterDefaults.maxTokens === true) delete proposal.maxTokens
  return proposal
}
```

这个函数解决的问题是：当 adapter 在 prepareCall 时标记了某个字段为 adapter default（如 reasoningEffort=true 表示"这个值是 adapter 自动设置的而非用户指定的"），后续步骤不应该把它当作用户的显式选择来恢复。

具体场景：用户没有指定 reasoningEffort，DeepSeek adapter 默认设置为 'medium' 并标记 adapterDefaults.reasoningEffort=true。下一个 step 的 buildRequest 不应该把 'medium' 当作用户选择来 seed 配置——应该删除它让 adapter 重新决定。

如果没有 adapterDefaults 标记，直接返回 header.config 作为 proposal。

注意：这里做的是浅拷贝 `{ ...header.config }` 然后 delete 字段——不会修改原始 config 对象。

---

## 3. ReactLoopAgent 类

### 3.1 构造函数（行 80-97）

```ts
constructor(
  private loopCtx: Context,        // 宿主级 Cordis Context
  public readonly id: SessionId,   // 会话 ID = Agent ID
  public readonly options: AgentOptions,  // provider/model/maxTokens 等
  public readonly session: Session,       // 关联的会话对象
) {
```

初始化顺序至关重要：

**第 86 行：创建 fused dispatcher**
```ts
this.dispatch = agentEvents(loopCtx, this)
```
必须在最前面——后面 Inbox 的 notification 回调需要使用 this.dispatch。fused dispatcher 将 agent subject 绑定到 scope carrier，后续所有 emit/waterfall/serial 都通过它路由到正确的 scope。

**第 87-91 行：创建 Inbox**
```ts
this.inbox = new Inbox(session, {
  inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }) },
  discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }) },
  claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
})
```

Inbox 构造函数内部会遍历 session.events 从 seedLength 开始回放所有 agent/inbox/spliced 事件恢复内存状态。三个 notification callback 在每次 mutation 后触发对应的 cordis event，供 UI 和其他插件监听 Inbox 变更。

**第 92 行：恢复 lastTurn**
```ts
const lastTurn = session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0
```

从 session log 中找到最后一个 turn/start 事件的 turn 编号。如果是 resume（有 seed），这确保新回合从正确的编号开始而不是从 1。空会话则从 0 开始（第一个 turn 是 1）。

**第 93 行：初始 phase 为 idle**

**第 94 行：创建 Agent scope**
```ts
this.scope = createScope(loopCtx, this)
```

createScope 在 loopCtx 上 mint 一个子 scope fiber。scope target 设为 `this`（Agent 实例本身作为 scope key）。这意味着后续注册到此 scope 的工具/prompt section 只对本 agent 可见。

**第 95 行：扩展 ctx**
```ts
this.ctx = this.scope.ctx.extend({ agent: this })
```

在 scope ctx 上再 extend 一层挂载 `agent` 属性指向自身。这样 `ctx.agent` 可以在任何 agent-scoped 插件中访问当前 Agent 实例。同时保持 scope chain 使 scopeOf(this.ctx) 返回正确的 scope key。

**第 96 行：创建 RuntimeContextProjection**
```ts
this.runtimeContext = new RuntimeContextProjection(this.ctx, session)
```

RuntimeContextProjection 跟踪最近一次 runtime context snapshot 的 UserMessage。它在 session/event 上监听两类变化：

1. 新的 user/message 且 source.plugin === '@deepseek-ai/dsh-system-prompt' → 更新 retained
2. replacement surfaceOp 引用了 retained.seq → retained 变为 null（被 compaction 替换）

project(current, sections) 方法在每次 preStep 时调用：如果 current 与上次不同则生成一条新的 UserMessage（source.plugin 标记归属），否则返回 undefined 表示无需更新。

### 3.2 status getter 与 setPhase（行 99-111）

```ts
get status(): AgentStatus {
  return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
}

private setPhase(next: Phase): void {
  const previousStatus = this.status
  this.phase = next
  const status = this.status
  if (status !== previousStatus) {
    this.dispatch.emit('agent/status', { status })
  }
}
```

status 将 maintenance 映射为 'idle'——外部观察者不区分"空闲"和"在做维护"。只有 running 才报告为 'running'。

setPhase 先读取旧 status，替换 phase 后读新 status。只在 AgentStatus 层面变化时才 emit agent/status 事件——避免 maintenance→idle 这种对外无感知的转换触发不必要的通知。

### 3.3 四种消息入口（行 113-132）

#### send(message, target, wakeup)（行 113-120）

这是所有消息入口的底层实现。

```ts
send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
  // 行 116：在插入前捕获 abort 状态
  const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
  // 行 117：如果是在 aborted activity 期间发送的 wakeup 消息，强制改为 next-turn
  const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
  // 行 118：写入 Inbox
  this.inbox.splice(resolvedTarget, Infinity, 0, [message])
  // 行 119：wakeup 则尝试启动驱动
  if (wakeup) this.wakeDriver(wakingAfterAbort)
}
```

**为什么要在插入前捕获 wakingAfterAbort？**

因为 inbox.splice 可能触发同步的 splice observer（如 compaction 插件），而 observer 内部可能调用 cancel() 导致 abort signal 变化。如果在插入后再检查，可能读到已被 observer 改变的状态。提前捕获保证分类的一致性。

**wakingAfterAbort 的含义**：当前有一个已 aborted 的 activity 在 running/maintenance 状态。这条 wakeup 消息不能加入那个已死的活动的 next-step queue（因为它不会再被消费），所以强制放到 next-turn 让下一个新 turn 来消费。

#### followup / steer / inject（行 122-132）

三个公开方法分别封装不同的语义：

| 方法 | target | wakeup | 用途 |
|---|---|---|---|
| followup | next-turn | true | 新对话轮次 |
| steer | next-step | true | 注入到当前运行的步骤边界 |
| inject | next-step | false | 同 steer 但不唤醒驱动 |

inject 用于不需要立即执行的上下文注入（如 tool result 的 deferredContexts）。

### 3.4 cancel(cause, options)（行 134-140）

```ts
cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
  if (!options.keepInbox) {
    this.inbox.clear()
    if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
  }
  if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
}
```

两步操作：

1. **清空 Inbox**（除非 keepInbox）：清除所有 pending 消息。同时将 wakeRequested 设为 false——因为队列已经清了，latch 的 wake 到 convergence 时发现 hasPending=false 就不会重新启动。

2. **Abort 当前活动**：触发 AbortController 使所有使用该 signal 的异步操作收到 abort 信号。turn() 的 catch 块会将 turnEnds 设为 aborted。

AgentCancelCause 类型区分取消原因：'user' 用户手动停止 / 'disposed' fiber 清理导致 / 自定义对象。

keepInbox=true 场景：steer 操作先 cancel 当前 turn 但保留 next-step queue 中的消息供下一 turn 使用。

### 3.5 runMaintenance(job)（行 142-162）

```ts
runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (this.phase.kind !== 'idle') throw ...  // 行 143
  const done = Promise.withResolvers<void>()
  const maintenance: Phase = { kind: 'maintenance', abort: new AbortController(), lastTurn: ..., wakeRequested: false }
  this.setPhase(maintenance)                  // 行 151
  this.activityDone = done.promise            // 行 152
  return (async () => {
    try { return await job(maintenance.abort.signal) }
    finally {
      this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
      if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
      done.resolve()
    }
  })()
}
```

维护模式用于 compaction 等需要在 turn 之间独占运行的操作。

关键设计：
- 必须在 idle 时才能进入——不允许与 running turn 并发。
- 维护期间收到的新 wakeup 消息会被 latch（因为 phase 不是 idle）。
- job 完成后检查 wakeRequested——如果有 pending work 就启动新的 driver。
- done.resolve() 放在 finally 最后确保 whenIdle() 能等到完全收敛。

### 3.6 wakeDriver(wakeAfterAbort)（行 164-193）

这是整个状态机的核心调度点。理解它的关键是分两种情况：

**情况 A：phase 不是 idle（行 173-181）**

当前有活跃工作（running 或 maintenance）。新的 wakeup 不能直接启动第二个 driver——那会导致并发 turn。

三种子情况：

1. `reason?.kind === 'disposed'`：当前 activity 因为 disposal 被 abort。disposal 不 latch——teardown 不应等待 model turn 完成。直接 return。

2. `phase.kind === 'maintenance'`：维护任务无法消费新消息。latch wakeRequested=true，等维护完成后 replay。

3. `wakeAfterAbort === true`：当前 activity 已 aborted 但还在 draining。新消息被强制放到 next-turn（send 已经做了 reclassify），但 live driver 不会自己 claim 它（它只处理 next-step）。所以需要 latch。

其他情况（live driver 正常运行中）：driver 自己会在 turn() 结束时检查 inbox.hasPending 决定是否继续下一个 turn。无需额外干预。

**情况 B：phase 是 idle（行 183-192）**

安全启动新的 driver：

```ts
const driver = Promise.withResolvers<void>()
this.activityDone = driver.promise     // whenIdle() 等这个 promise
this.setPhase({
  kind: 'running',
  abort: new AbortController(),        // 每个 turn cycle 一个新 controller
  turn: this.phase.lastTurn,           // 从上次的编号继续
  step: 0,
  wakeRequested: false,
})
this.loopCtx.agents.withInitiator(this, () => this.kick())
  .then(driver.resolve, driver.reject)
```

withInitiator 设置 AsyncLocalStorage 使嵌套的 agents.get/create 正确关联 parent-child。kick() 的 promise resolve/reject 映射到 driver promise 供 whenIdle() 观察。

### 3.7 whenIdle()（行 195-200）

```ts
async whenIdle(): Promise<void> {
  let activity: Promise<void>
  do {
    await (activity = this.activityDone)
  } while (activity !== this.activityDone)
}
```

这里的 do-while 循环处理一个微妙竞态：在 await 期间可能有新的 driver 启动（activityDone 被替换为新 promise）。如果只 await 一次旧 promise，可能在新 driver 还在跑时就返回了。

循环条件 `activity !== this.activityDone` 检查：await 完成后，activityDone 是否还是我们刚才等的那个？如果不是说明有新的 activity 启动了，需要继续等待。

### 3.8 throwError(error)（行 202-208）

```ts
private throwError(error: unknown): never {
  const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
  const step = this.phase.kind === 'running' ? this.phase.step : 0
  this.dispatch.emit('agent/error', { turn, step, error })
  throw error  // 重抛给上层 catch 处理
}
```

先发射错误事件（fire-and-forget，listener 失败不影响流程），然后重抛。调用方（kick 的 catch）吞掉异常完成 containment。这样错误既被报告给了 UI 又不会 crash 进程。

### 3.9 kick() 驱动循环（行 210-223）

```ts
private async kick(): Promise<void> {
  try {
    while (await this.turn()) {}    // 行 212
  } catch (_error) {                 // 行 213
    // Reported failures and cancellation are contained at the driver boundary.
  } finally {                        // 行 215
    if (this.phase.kind === 'running') {
      const { turn, wakeRequested } = this.phase
      this.setPhase({ kind: 'idle', lastTurn: turn })
      if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
    }
  }
}
```

**try 块**：while 循环不断调用 turn()。turn() 返回 true 表示 inbox 还有 pending work 需要开启新 turn 继续。返回 false 或抛出异常都退出循环。

**catch 块**：所有从 turn() 抛出的异常都在这里被吞掉。turn() 内部已经通过 throwError() 发射了 agent/error 事件所以 UI 已经知道了错误。kick 只是防止异常传播到 withInitiator 外层导致 unhandled rejection。

**finally 块**：收敛清理。检查 phase 是否仍然是 running（可能已被 cancel 设为其他值）。恢复 idle 并记录最后的 turn 编号。然后检查是否有 latched wakeup 需要 replay。

### 3.10 preStep(target, position)（行 225-243）

```ts
private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep>
```

每个 step 开始前的准备工作。逐步分析：

**行 229：claim inbox**
```ts
const claimed = this.inbox.claim(target, position.turn)
```

claim 清空整个 next-step queue，然后如果 target 是 next-turn 再取一条 next-turn 消息。返回的是 UserMessage 数组。claimed 消息的 cordis event 通过构造函数中传入的 notification callback 发射。

**行 230：assemble system prompt**
```ts
const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
```

assembleContextFor 创建 `{ agent: this, scope: this, signal }` 上下文。systemPrompt.assemble 收集全局和 scope-chain 的 sections/contexts/tools/variables，运行 waterfall，返回 PromptAssembly。

这一步可能很耗时（tool providers 可能做 RPC 查询目录），所以之后立即检查 abort。

**行 232-233：投影 runtime context**
```ts
const sections = renderContextSections(assembly)
const context = this.runtimeContext.project(joinContextSections(sections), sections)
```

renderContextSections 将 assembly.contexts 渲染为 named text sections。joinContextSections 拼接为完整 snapshot 文本加头部说明。

runtimeContext.project 比较 current 与上次 retained——不同则生成一条 UserMessage（带 source.plugin 标记），相同则返回 undefined。

**行 234-240：waterfall agent/pre-step**
```ts
const decision = await this.dispatch.waterfall(
  'agent/pre-step', { messages: claimed, ...position, signal },
  (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({
    kind: 'enter',
    messages: context === undefined ? claimed : [...claimed, context],
  }),
)
```

默认行为：如果有 runtime context 更新则追加到 claimed messages 末尾。插件可以修改 messages 列表或返回 reject。

plan mode 就是在这里工作的：plan mode active 时 listener 返回 `{ kind:'reject' }` 阻止模型直接执行。

**行 242：附加 assembly**
```ts
return decision.kind === 'reject' ? decision : { ...decision, assembly }
```

PreparedStep enter 分支需要携带 assembly 供后续 step() 使用。

### 3.11 turn() 方法详解（行 245-330）

这是最复杂的方法，管理一个完整的回合生命周期。

**前置检查和 turn/start（行 246-259）**

```ts
if (this.phase.kind !== 'running') {
  this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
}
const phase = this.phase
const { signal } = phase.abort.signal ? phase.abort : {} // 解构
signal.throwIfAborted()
const turn = phase.turn + 1
try {
  this.session.append('turn/start', { turn })
} catch (error) { this.throwError(error) }
phase.turn = turn
```

turn 编号递增并 durably 记录。append 失败（如 persistence backend 满）通过 throwError 报告。

**内循环变量初始化（行 260-261）**

```ts
let turnEnds: TurnEndReason | null = null  // 最终结束原因
let target: InboxTarget = 'next-turn'      // 第一步从 next-turn claim
```

turnEnds 为 null 表示 turn 还没有确定结局。target 在第一个 step 后切换为 next-step。

**主 while 循环（行 262-301）逐行分析**

```ts
while (true) {
```

无限循环由 break 或异常退出。

```ts
signal.throwIfAborted()          // 行 264：每次迭代检查 abort
const step = phase.step + 1      // 行 265：步骤编号递增
const decision = await this.preStep(target, { turn, step })  // 行 266
```

调用 preStep 做 inbox claim + prompt assembly + waterfall。这是可能耗时的异步操作。

```ts
if (decision.kind === 'reject') {         // 行 267
  turnEnds = { kind: 'blocked' }          // 行 268
  return false                            // 行 269
}
```

插件拒绝了本步骤。turnEnds 设为 blocked（不是 error——是有意阻止）。

```ts
if (turnEnds && decision.messages.length === 0) break   // 行 271
```

如果 turnEnds 已非 null（前面的 step 已经产生了 completed 或 max-tokens），且本轮没有新消息要处理，就自然结束 turn。

```ts
if (phase.step === 0 && decision.messages.length === 0) {  // 行 274
  turnEnds = { kind: 'completed' }                          // 行 275
  return false                                              // 行 276
}
```

第一个 step 就收到了零条消息。这可能是因为：wakeup 消息在 preStep 之前被 cancel 清除了，或者插件将 messages 重写为空。仍然拥有 turn boundary 但不浪费一次 model call。

```ts
signal.throwIfAborted()                                    // 行 278
this.session.append('step/start', { turn, step })          // 行 279
phase.step = step                                          // 行 280
```

打开步骤边界并更新 phase 中的 step 编号（throwError 需要用它定位错误位置）。

```ts
try {
  for (const message of decision.messages) {               // 行 282
    this.session.append('user/message', message, { surfaceOp: 'append' })  // 行 283
  }
```

将 claimed 的用户消息写入 session log。surfaceOp: 'append' 标记这些消息加入 surface 尾部成为模型可见历史的一部分。

```ts
  const stepEnd = await this.step(decision.assembly)       // 行 287
```

调用核心 step() 方法执行 LLM 流式调用和工具执行。这是最耗时的操作。

```ts
  if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd  // 行 290
```

**max-tokens sticky 语义**：一旦任何 step 达到了 token 上限，即使后续 step 正常完成，turn 的最终结局也不能降级为 completed。这保证了 UI 和日志正确反映"这个 turn 是被截断的"。

```ts
} finally {
  this.session.append('step/end', { turn, step })          // 行 292
}
```

无论 step 成功还是抛异常都要关闭步骤边界。finally 确保这一点。

```ts
signal.throwIfAborted()                                    // 行 294
if (turnEnds && this.inbox.nextStep.length === 0) {        // 行 295
  await this.dispatch.serial('agent/turn-stopping', { turn, signal })  // 行 296
  signal.throwIfAborted()                                  // 行 297
}
if (turnEnds && this.inbox.nextStep.length === 0) break    // 行 299
target = 'next-step'                                       // 行 300
```

turnEnds 非 null 且 next-step queue 为空时：
1. 先 serial dispatch 'agent/turn-stopping' 给插件做清理
2. dispatch 后再次检查 abort（listener 可能在 serial 过程中调用了 cancel）
3. 再次确认条件后 break 退出循环

如果 nextStep 还有消息（steer 或 tool deferredContext），继续下一 step 即使 turnEnds 已设置。target 切换为 next-step 让下一步从 step boundary claim。

**catch 块（行 302-315）**

```ts
} catch (error: unknown) {
  if (signal.aborted) {                                    // 行 303
    turnEnds = { kind: 'aborted', reason: signal.reason as AgentCancelCause }  // 行 304
    throw error                                            // 行 305
  }
  turnEnds = {                                             // 行 309-314
    kind: 'error',
    error: error instanceof LlmError
      ? error.failure                                       // 保留结构化的 LlmFailure
      : { message: errorChain(error), code: 'UNKNOWN' },   // 其他错误展平
  }
  this.throwError(error)                                   // 行 315
}
```

两种错误路径：

1. **abort 导致的异常**：turnEnds 设为 aborted 携带 cancel cause。re-throw 给 kick 的 catch 处理。
2. **真正的错误**：LlmError 保持其完整的 failure 结构（含 code/status/providerRetryAfterMs），其他错误用 errorChain 渲染完整 cause chain 后包装为 UNKNOWN code。然后 throwError 发射事件并重抛。

**finally 块（行 316-323）**

```ts
} finally {
  try {
    this.session.append('turn/end', { turn, reason: turnEnds! })  // 行 319
  } catch (error) {
    this.throwError(error)                                     // 行 320
  }
}
```

无论成功、异常、abort 都要关闭回合边界。turnEnds! 的 non-null assertion 安全因为所有 exit path 都赋值了 turnEnds。

如果 append('turn/end') 也失败了（极端情况如磁盘满且 abort 同时发生），throwError 报告这个二次错误。

**turn 结束后的判断（行 324-329）**

```ts
if (!this.inbox.hasPending) return false   // 行 324：无 pending 工作退出
phase.abort = new AbortController()        // 行 325：新 controller
phase.wakeRequested = false                // 行 326
phase.step = 0                             // 行 328
return true                                // 行 329：继续下一 turn
```

还有 pending work（next-turn 有消息或 next-step 有残留）。重置 AbortController——旧的 controller 可能已经 aborted，新 turn 需要一个新的 signal。同时清除 wakeRequested latch——live driver 自己 claim queue 不需要 replay。step 归零准备新 turn 的第一步。

### 3.12 step() 方法详解（行 332-401）

管理一次 LLM 调用及其后续的工具执行。可能循环多次（模型连续请求工具直到不再需要）。

**初始化（行 334-337）**

```ts
if (this.phase.kind !== 'running') throw ...
const { turn, step, abort: { signal } } = this.phase
signal.throwIfAborted()
const system = renderPrompt(assembly)   // 变量插值后的最终 system prompt 文本
```

renderPrompt 在此处只调用一次——同一个 step 内的多次 LLM retry 共用同一个 system prompt。

**LLM 调用循环（行 339-400）**

```ts
while (true) {
```

每次迭代代表一次完整的 LLM stream 消费。正常路径最多迭代两次：第一次产生 tool calls 执行后第二次不再有 tool calls 返回 completed。但如果模型持续请求工具可以循环任意次。

**buildRequest（行 340-342）**

```ts
const { request, preparedCall } = await this.buildRequest(
  turn, step, assembly.tools, system, this.session.deriveMessages(), signal,
)
```

deriveMessages() 从 surface nodes 投影出当前的 Message[] 数组。包含本 step 写入的 user/messages 和之前所有 surface 上的消息。

**BlockAssembler 和流式消费（行 343-351）**

```ts
const assembler = new BlockAssembler()
const chunkSeqs: number[] = []
const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
signal.throwIfAborted()
for await (const chunk of stream) {
  signal.throwIfAborted()
  chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
  assembler.push(chunk)
}
```

preparedCall 存在时使用 adapter 绑定的 stream 方法（可能包含 middleware 包装的 retry/stream 处理）。否则直接走 ctx.llm.stream。

每个 chunk 都 durably 写入 assistant/chunk 事件。chunkSeqs 收集所有 chunk 的 seq 号——后面 assistant/message 事件用它们作为 sourceEventSeqs 建立 provenance 链。

assembler.push(chunk) 在内存中累积 block 数据。BlockAssembler 内部处理跨 chunk 的 tool-call arguments 拼接和 usage 汇总。

**finish 处理（行 353-371）**

```ts
const finish = assembler.finish
if (finish.kind === 'error' || finish.kind === 'aborted') {
  const action = await this.dispatch.waterfall(
    'agent/request-error',
    { turn, step, provider, failure: finish.failure, retryPolicy, signal },
    () => Promise.resolve<RequestErrorAction>(undefined),  // 默认不重试
  )
  signal.throwIfAborted()
  if (action?.kind !== 'retry') {
    throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
  }
  continue  // retry：回到 while 循环顶部重新 buildRequest
}
```

stream 结束时 BlockAssembler 的 finish 属性告诉我们结果如何：

- kind='ok': 正常完成
- kind='max-tokens': 达到了 max_tokens 限制
- kind='error': provider 或 transport 错误
- kind='aborted': signal 取消

对于 error/aborted，waterfall 让插件决定是否重试。dsh-llm-retry 包的 listener 会评估 failure 的 code/status/providerRetryAfterMs 来决定。如果决定 retry 则 continue 回到循环顶部重新 buildRequest（messages 可能因为 retry 事件而变化）。如果不 retry 则 throw LlmError 保留完整的 failure 信息。

**成功路径（行 373-399）**

```ts
const message = createAssistantMessage({
  content: assembler.blocks(),
  source: {
    provider: request.provider,
    model: request.model,
    ...assembler.replayState !== undefined ? { replayState: assembler.replayState } : {},
  },
})
this.session.append(
  'assistant/message',
  { turn, step, message, usage? },
  { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
)
```

createAssistantMessage 构建 AssistantMessage 对象。source 记录哪个 provider/model 生成了这段内容。replayState 是可选的 adapter 特定重放信息。

session.append 将最终消息写入 log。sourceEventSeqs 引用所有 chunk 事件的 seq——建立 provenance 链使 compaction 替换能正确 shadow 整个流式序列。

```ts
if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }
```

max-tokens finish 直接返回——即使有 tool calls 也不执行（token 已经不够了）。

```ts
const toolCalls = message.content.filter(block => block.type === 'tool-call')
if (toolCalls.length === 0) return { kind: 'completed' }
```

没有 tool calls 说明模型认为任务完成返回纯文本回复。step 结束 reason 为 completed。

```ts
const { concluded } = await executeToolCalls(
  this.loopCtx, turn, step, toolCalls, signal,
  context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]),
)
return concluded ? { kind: 'completed' } : null
```

有 tool calls 时调度执行。executeToolCalls 的 acceptor callback 接收 tool 产生的 context injection（如 tool result 需要在下一步骤注入的补充信息），将其追加到 next-step queue。

concluded=true 表示所有 tool calls 正常结束（非中断）——返回 completed 让 turn 自然结束。concluded=false 表示有中断——返回 null 让 while(true) 循环继续下一次 LLM 调用（模型看到 tool results 后决定下一步）。

### 3.13 buildRequest() 方法详解（行 407-495）

构建冻结的 GenerateOptions 并绑定 adapter。

#### Seed Config 构建（行 417-437）

```ts
const persistedHeader = session.requestHeader()
const persistedConfig = persistedHeader?.config
const route = { provider: this.options.provider ?? '', model: this.options.model ?? '' }
```

persistedHeader 是 log 中最后一条 request/header 事件的数据。首次运行时为 undefined。

route 来自 AgentOptions 的声明值。空字符串表示未指定。

```ts
const reasoningEffort = persistedConfig?.provider === route.provider
  && persistedConfig.model === route.model
  && persistedHeader?.adapterDefaults?.reasoningEffort !== true
  ? persistedConfig.reasoningEffort
  : undefined
```

恢复 reasoningEffort 的条件（全部满足才恢复）：
1. persisted config 的 provider 与当前 route 匹配
2. persisted config 的 model 与当前 route 匹配
3. adapter 没有标记 reasoningEffort 为 adapter default（即这是用户显式设置的）

如果 route 变了（如用户切换了模型），旧模型的 effort 不应该带到新模型。

```ts
const maxTokens = this.options.maxTokens
const seedConfig = deepFreeze(structuredClone(
  this.requestHeaderLogged
    ? requestProposal(persistedHeader!)
    : {
        ...route,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      },
))
```

两个分支：

- **首次**（requestHeaderLogged=false）：从 AgentOptions 构建。包含 route + 显式 effort/tokens。
- **后续**（requestHeaderLogged=true）：从 requestProposal(persistedHeader) 恢复。移除 adapter 标记的 defaults。

structuredClone + deepFreeze 确保后续 waterfall listener 不能直接变异 seed config。

#### Waterfall 修改配置（行 438-444）

```ts
const proposedConfig = await this.dispatch.waterfall(
  'agent/request', { turn, step, signal },
  () => Promise.resolve(seedConfig),
)
if (!proposedConfig.provider || !proposedConfig.model) {
  throw new Error(`agent "${this.id}" has no provider/model...`)
}
```

插件可以通过修改 proposedConfig 来动态路由到不同的 provider/model。例如 dsh-agent-default-model 服务在没有显式选择时填充默认值。

provider 和 model 必须非空否则 fail-loud。

#### Adapter 解析（行 446-455）

```ts
let config: LlmCallConfig
let preparedCall: PreparedLlmCall | undefined
try {
  preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal)
  config = preparedCall.config
} catch (error) {
  if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
  config = proposedConfig
}
```

prepareCall 根据 provider/model 查找已注册的 adapter 并解析 contextWindow 等元数据。config 可能与 proposedConfig 不同——adapter 可能覆盖某些字段（如 maxTokens 超过 context window 时调整）。

NO_ADAPTER 错误特殊处理：middleware 可能通过 waterfall 设置了一个自定义 route 不对应任何已注册 adapter。这种情况下直接使用 proposedConfig 不绑定 adapter（preparedCall 为 undefined）后续 stream 走 ctx.llm.stream 的通用路径。

#### Header 记录（行 458-470）

```ts
const header = canonicalHeader({
  config,
  ...(preparedCall !== undefined ? { adapterDefaults: preparedCall.adapterDefaults } : {}),
  ...(system !== '' ? { system } : {}),
  ...(tools.length > 0 ? { tools } : {}),
})
const baseline = this.session.requestHeader()
if (!this.requestHeaderLogged) {
  this.session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' })
  this.requestHeaderLogged = true
} else if (baseline === undefined || !headerEquals(baseline, header)) {
  this.session.append('request/header', { header, reason: 'change' })
}
```

canonicalHeader 创建规范化的 header 对象。headerEquals 做深度比较判断配置是否真的变了。

三种 reason：
- initial: 第一次 append 且之前没有任何 header（全新 session）
- resume: 第一次 append 但已有旧 header（resume 已有 session）
- change: 非首次且 header 与 baseline 不同

requestHeaderLogged flag 确保每个 loop instance 只写一次 initial/resume。后续变化只在真正改变时记录。

#### Context 记录（行 472-483）

```ts
const contextWindow = preparedCall?.context?.contextWindow
const requestContext: RequestContext = {
  provider: config.provider,
  model: config.model,
  ...(contextWindow !== undefined ? { contextWindow } : {}),
}
const previousContext = session.requestContext()
if (previousContext?.provider !== requestContext.provider
  || previousContext.model !== requestContext.model
  || previousContext.contextWindow !== requestContext.contextWindow) {
  session.append('request/context', requestContext)
}
```

request/context 记录 provider/model/contextWindow 三元组的变化。浏览器端 token meter 用 contextWindow 计算 occupancy percentage。

#### Request 组装（行 486-494）

```ts
const request = markAgentLoopRequest(deepFreeze({
  ...header.config,
  messages: boundaryMessages,
  ...(header.system !== undefined ? { system: header.system } : {}),
  ...(header.tools !== undefined ? { tools: header.tools } : {}),
  sessionId: this.session.id,
  signal,
}))
return { request, ...(preparedCall !== undefined ? { preparedCall } : {}) }
```

最终 request 对象合并：
- header.config: 经过 waterfall 和 adapter 调整后的配置
- messages: deriveMessages() 的输出（boundaryMessages）
- system: 渲染后的 system prompt 文本
- tools: 工具 schema 数组
- sessionId: 用于 tracing
- signal: 当前 turn 的 AbortSignal

markAgentLoopRequest 打上一个品牌标记标识这是来自 agent loop 的请求（区别于直接的 LLM API 调用）。deepFreeze 确保请求对象不可变。

---

## 4. RuntimeContextProjection 补充（runtime-context.ts）

这个辅助类在构造函数中被创建负责 runtime context 的增量投影。

### 构造时的状态恢复（runtime-context.ts:34-56）

从 session events 反向扫描找到最后一个 owned user/message（source.plugin 匹配）。检查它是否仍在 surface 上（未被 compaction shadow）。设置 retained 初始值。

然后注册 session/event listener 持续跟踪：
- 新的 owned user/message → 更新 retained
- replacement 引用了 retained.seq → retained 变为 null

### project() 方法（runtime-context.ts:64-75）

```
project(current, sections):
  1. retained===undefined（从未有过 snapshot）且 current 为空 → return undefined（无需投影）
  2. current 为空 → snapshot = CLEARED 常量文本
  3. retained.text === snapshot → return undefined（内容没变）
  4. 否则 createUserMessage({ content: [text], source: { kind:'plugin', plugin: SOURCE, form?, sections? } })
```

CLEARED 常量告诉模型之前的 runtime context 已失效。

form: 'snapshot' 和 sections 字段提供 attribution——UI 可以知道这段上下文是由哪些 subsystem 贡献的。
