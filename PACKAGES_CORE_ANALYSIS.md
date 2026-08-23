# packages/core 源码深度研究文档

> 逐函数分析 packages/core/ 下 8 个子包。所有行号基于当前 master 0.1.0-rc.7。

## 目录

| 子包 | 总行数 | 核心文件 | 一句话 |
|---|---|---|---|
| session | 3156 | index.ts(1157), surface.ts(460), types.ts(436) | 事件溯源会话日志 + surface 投影 |
| agent-loop | 785 | agent.ts(496), tool-calls.ts(289) | turn/step/tool-call 驱动器 |
| agent | 1636 | index.ts(706), inbox.ts(220), dispatch.ts(176) | Agent 注册表 + Inbox + 事件分发 |
| tools | 5628 | index.ts(1946), code-mode.ts(681) | 工具注册/执行/Code Mode |
| system-prompt | 605 | index.ts(545) | 提示词 section 组装与变量插值 |
| scope | ~400 | store.ts(~270) | 作用域分层注册表原语 |
| agent-default-model | ~80 | index.ts | 默认模型选择服务 |
| agent-tool-presentation | ~100 | types.ts | 工具 UI 渲染意图契约 |

---

## 1. dsh-session — 事件溯源会话日志

### 1.1 SessionEvent 信封（types.ts）

每条事件的结构：

- `seq`: 全局递增序号 = log.length（连续性契约）
- `time`: 毫秒时间戳
- `type`: 事件类型 key（SessionEventMap 的 key）
- `data`: JSON 可序列化 payload
- `surfaceOp`: surface 操作标记（仅消息事件携带）
- `sourceEventSeqs`: 派生来源引用数组
- `ignorable: true`: 旧 reader 可安全跳过

seq 连续性契约：seq = log.length。整个系统的 replay、persistence、fork 都依赖这个不变量。构造函数中的 seed 验证强制从 0 开始连续。

SESSION_FORMAT_VERSION = 0（types.ts:56）：单调递增整数 stamped 到每个 SessionHeader。persistence backend load 时校验不兼容即拒绝无迁移路径。bump 条件是 header 形状 event 信封 核心事件语义或 surface 机制变化 新增普通事件类型由 ignorable 覆盖不 bump。

### 1.2 SessionHeader（types.ts:61-99）

存储元数据 不进入 event log：

| 字段 | 类型 | 说明 |
|---|---|---|
| version | number | SESSION_FORMAT_VERSION |
| id | SessionId | 品牌化字符串 |
| createdAt | number | Unix epoch ms |
| cwd? | string | 绝对路径 backend 用它建目录 |
| parentSession? | SessionId | fork 来源 |
| seedLength? | number | fork 继承的前缀长度 |
| origin? | 'subagent' | 子代理标记 展示用 |
| delegationDepth? | number | 递归深度预算 resume 后不重置 |
| agentPreset? | string | 创建时的 preset id |

cwd 必须是绝对路径 persistence backend 用它作为存储根目录。

### 1.3 Session 类（index.ts:425-758）

私有状态：

- log: SessionEvent[] 追加 only 事件数组
- surfaceManager: SurfaceManager surface 投影
- eventsSnapshot 缓存的不可变快照
- derived: Message[] deriveMessages 缓存
- derivedNodes 缓存已投影到的 surface 位置
- derivedGeneration 缓存构建时的 replaceGeneration

构造函数（index.ts:499-548）流程：

1. mode='restore' 时 validateRestoredSessionHeader 校验并冻结 header
2. 遍历 seed 数组： snapshotJsonValue 深拷贝 assertSessionEventEnvelope 校验信封 assertSupportedRequestHeader 拒绝过时格式 校验 seq===index 连续性 surfaceManager.validateNext 预验证 push 并 deepFreeze
3. firstLiveSeq = log.length 本进程内第一条新 append 的序号
4. header = snapshotSessionHeader 校验并深冻结
5. 有 seed 且末尾不是 session/end-seed 则追加标记事件（不广播）

append() 方法核心流程：

1. snapshotJsonValue(data) 深拷贝确保 JSON 可序列化
2. 构建信封 seq=log.length time=Date.now()
3. surface eligible 类型则 surfaceOp 必须存在 validateNext 预验证
4. deepFreeze(event.data)
5. log.push(event)
6. 通过 store attachment 广播 session/event listener 失败被包含
7. 返回 event

关键设计： 一旦事件进入 log append 即已提交 listener 失败不影响返回值。

deriveMessages()（index.ts:726-747）增量缓存实现：

检查 replaceGeneration 变化则清空缓存重建。从 derivedNodes 开始遍历 surface.nodes 新增部分对每个 seq 调用 deriveEventMessage(log[seq]) 非空消息 push 到缓存。返回新数组但共享冻结的 Message 对象。每个 surface node 只投影一次调用成本 O(new nodes)。

### 1.4 Surface 系统（surface.ts 460 行）

三种消息产生事件类型： user/message assistant/message tool/result。

SurfaceOp 两种操作：

- append: 追加到 surface 尾部正常路径
- replace { start end }: 替换 surface 中指定范围的节点 compaction 用

deriveEventMessage()（surface.ts:83-114）单事件投影规则：

- user/message 直接返回 event.data 即 UserMessage
- assistant/message 空内容返回 null 否则返回 message
- tool/result 返回 event.data.message 即 ToolResultMessage
- 其他类型返回 null

这是唯一的投影规则 Session.deriveMessages() 浏览器端 ConversationNodeAssembler 和外部重建器都用同一个函数折叠。

SurfaceManager 类（surface.ts:398-460）增量 surface 视图：

validateNext(event) 预验证不 mutate。get nodes() 惰性处理 delta 后返回。replaceGeneration 是替换操作计数用于 deriveMessages 缓存失效。

_processDelta() 处理自上次访问以来新 append 的事件如果存在 pendingPlan 来自 validateNext 则使用预验证计划否则重新计算。

Replace 操作验证三步（surface.ts:245-310）：

1. replacementRange(): 在当前 surface nodes 中定位 startIdx 和 endIdx
2. assertProvenance(): sourceEventSeqs 必须包含所有被 shadow 的 node seq 且引用的 seq 必须小于当前 seq
3. assertToolResultRewrite(): tool/result replace 只能重写一个同类型节点且 message.source 必须匹配防止伪造

foldSurface()（surface.ts:387-395）完整日志重放遍历所有事件逐条 applySurfaceEvent 收集 replacements 返回 nodes 和 replacements。

### 1.5 SessionStore（index.ts:792-1155）

ctx.sessions 服务管理所有活跃 Session 的生命周期。

create(id options) 使用 generator effect：先 prepare 构建 Session 对象然后在单个 generator effect 中 yield enter(session) 再调用 announce(session)。announce 抛出则 enter 的 disposer 也执行回滚 store entry。

fork(source boundary childId) 流程：

1. _resolveForkSource 解析 Session 对象或 id 到 live instance
2. _forkSeed:
   - 验证 boundary 是有效 seq
   - 查找 boundary 之前最后一个 turn/start 或 turn/end
   - turn/start 则 throw OPEN_TURN 不能在 open turn 内 fork
   - 返回 events.slice(0, boundary + 1)
3. create(childId seed 包含 parentSession seedLength cwd)

prepare + enter + announce 分离模式供 Agent factory 将 session 生命周期折叠到自己的 effect 中保证 loop 最终事件在 store detach 前发布。

### 1.6 四种 Cordis 事件

| 事件 | 模式 | 语义 |
|---|---|---|
| session/created | emit | 创建公告 同步 throw 可回滚 |
| session/disposed | emit | 离开 store 时一次性发射 |
| session/event | emit | 追加后 fire and forget 通知 |
| session/flush | parallel | 持久化 checkpoint await 所有 listener |

所有事件通过 Scoped Session thisArg 进行 scope filtered dispatch。

### 1.7 修复机制（repair.ts 133 行）

interruptedTurnClosers(events, fromSeq) 为中断的 turn 生成合成关闭事件保证 replay 时每个 open turn 都有闭合。TOOL_NOT_STARTED 和 TOOL_OUTCOME_UNKNOWN 是标准 error code 常量。

---

## 2. dsh-agent-loop — Agent 主循环

### 2.1 Phase 状态机（agent.ts:38-46）

idle maintenance running 三态。idle 记录 lastTurn；maintenance 有 AbortController 和 wakeRequested；running 额外跟踪 turn 和 step 编号。

状态转换 idle 通过 wakeDriver 进入 running；kick finally 回到 idle；runMaintenance 切入 maintenance 完成后回 idle。

Wake latching 规则（agent.ts:172-193）： live driver 自己 claim 队列中的 work 只有 maintenance 和 aborted after wake 场景需要 latch wakeRequested=true 在收敛时 replay。

### 2.2 kick() 驱动循环（agent.ts:210-223）

while(await this.turn()) 循环直到无 inbox 工作。finally 中 setPhase(idle) 并在 wakeRequested 且 hasPending 时重新 wakeDriver。

### 2.3 turn() 方法详解（agent.ts:246-330）

完整流程按序：

1. signal.throwIfAborted()
2. turn = phase.turn + 1
3. session.append('turn/start', turn)
4. while(true) 循环体：
   - preStep(target, position) 获取 decision
   - reject 则 turnEnds=blocked return false
   - 空消息且 step==0 则 completed return false
   - session.append('step/start')
   - 写入 claimed user messages 带 surfaceOp:'append'
   - stepEnd = await step(assembly)
   - max tokens sticky 一旦触发后续 completed 不降级
   - session.append('step/end')
   - 结束且 nextStep 为空则 serial dispatch agent/turn-stopping 后 break
   - target 切换为 next-step
5. catch 分支 aborted 或 error 设置 turnEnds
6. finally: session.append('turn/end', reason)
7. inbox.hasPending 则重置 AbortController 和 step 返回 true 继续下一 turn

### 2.4 preStep() 方法（agent.ts:225-243）

claim inbox messages 然后 assemble prompt 然后 waterfall agent/pre-step 让插件 reject 或修改 messages。RuntimeContextProjection 将 context sections 注入为一条额外 UserMessage。

### 2.5 step() 方法详解（agent.ts:332-401）

内循环每次迭代代表一次 LLM 调用及其后续工具执行：

1. buildRequest 组装 LLM 请求含 provider/model/messages/tools/system/signal
2. BlockAssembler 累积流式 chunks 每个 chunk 写入 assistant/chunk 事件
3. finish 是 error 或 aborted 时 waterfall agent/request-error 决定 retry 或 throw LlmError retry 则 continue
4. 正常完成时 createAssistantMessage 写入 assistant/message 事件 含 usage
5. 无 tool calls 则 completed
6. executeToolCalls 执行工具 concluded 则 completed 否则 null 继续循环下一次 LLM 调用

### 2.6 buildRequest() 详解（agent.ts:407-495）

首次从 AgentOptions 构建 seedConfig 后续从 requestProposal(persistedHeader) 移除 adapter 标记的 defaults（reasoningEffort/maxTokens 如果 adapter 声明为 default）。

waterfall agent/request 让插件修改 config。然后 ctx.llm.prepareCall(config) 解析 adapter defaults NO_ADAPTER 错误时 fallback 到 proposedConfig。

构建 canonicalHeader 比较 baseline 变化则写入 request/header 事件 reason 为 initial resume 或 change。同理 request/context 在 provider model 或 contextWindow 变化时写入。

最终 markAgentLoopRequest(deepFreeze(request)) 打标并冻结返回 request 和 preparedCall。

### 2.7 工具调用调度器（tool-calls.ts 289 行）

executeToolCalls 主循环按 executionMode 分组 exclusive 调用形成 barrier 独占执行 parallel 调用使用 bounded rolling pool maxParallelToolCalls 默认 1。

runGroup 核心逻辑：

- slots 数组按 model order 存储已 settle 的结果
- inFlight Map 存储正在执行的 promise key 为 index value 为 resolve(index) 的 Promise
- fillPool 按 maxParallel 填充 inFlight 重读 executionMode 让 registry 变更生效
- commitReady 按 model order 将 slots 中连续就绪的结果写入 session log
- Promise.race(inFlight.values()) 等待任一完成后 delete 并 commitReady

关键设计： Dispatch 可重叠但结果和 policy 按 model order 提交保证 session log 中 tool/result 顺序与 assistant message 中的 call 顺序一致。

Barrier 语义 exclusive call 独占执行 parallel group 中后续变为 exclusive 的 call 会触发 barrier。

Abort 处理 已开始的 call 等 quiescence 不 abandon 未开始的写入 TOOL_ABORTED_BEFORE_DISPATCH 合成结果保持 replay 有效性。

appendToolResult 写入 sourceEventSeqs:[callSeq] 建立 result 到 call 的引用链 meta 携带 presentation payload 供 UI replay 重现卡片。

---

## 3. dsh-agent — Agent 注册表与事件分发

### 3.1 AgentRegistry

ctx.agents 服务 withInitiator(agent, fn) 用 AsyncLocalStorage 设置 initiator 使嵌套的 get/create 能关联 parent child 关系。requireInitiator 在工具调度器中获取当前 Agent。

### 3.2 Inbox（inbox.ts 220 行）

两个 pending list: next-turn 和 next-step。

构造函数遍历 session.events.slice(seedLength) 中的 agent/inbox/spliced 事件逐条 apply 恢复状态无效 splice 抛出带 seq 的错误。

splice(target, start, removedCount, inserted) 是唯一写入口每次变更 durably 写入 spliced 事件。

claim(target, turn) 清空 next-step 然后 target 为 next-turn 时取一条 turn durable=false 表示 claim 不写 spliced 事件因为 claimed 消息已经作为 user/message 写入了 log。

### 3.3 Fused Dispatcher（dispatch.ts 176 行）

AgentSubjectEvent 条件类型筛选所有 handler this 是 Scoped Agent 且第一个参数包含 agent: Agent 的事件。

agentEvents(ctx, agent) 返回 fused dispatcher:

emit 方法手动 resolve callback set 逐个 try catch 包裹不用 ctx.emit 因为 Array.map 会因 throw 饿死后续 listener。同步 throw 和异步 rejection 分别 contained。

fused 函数将 agent 注入 payload 调用方传 PayloadRest 不含 agent 字段 spread 先于 agent 保证不能覆盖注入值。

loop driver 构造函数中 build once 复用热路径零分配。

### 3.4 关键 Agent 事件汇总表

| 事件 | 模式 | 时机 |
|---|---|---|
| agent/status | emit | idle 与 running 切换 |
| agent/error | emit | 任何错误 |
| agent/pre-step | waterfall | 每步前 reject 或修改 messages |
| agent/request | waterfall | buildRequest 时修改配置 |
| agent/request-error | waterfall | LLM 错误后决定 retry |
| agent/turn-stopping | serial | turn 即将结束清理 |
| agent/tool-call | waterfall | 工具执行前 guard approval |
| agent/inbox/* | emit | Inbox 变更通知 |

---

## 4. dsh-tools — 工具注册与执行管线

### 4.1 ToolRegistry 核心方法

register(definition) 验证 output.render 函数存在和 JSON Schema 有效拒绝 run_code 保留名通过 layers.effect 注册到调用者 scope 返回 Cordis disposer。

restrict(filter) 只能在 scoped context 调用 allow 和 deny 取交集不能 restrict run_code 未知名 fail loud。

guard(guard) 在 pre-execute waterfall 之后运行的单调 guard 返回 string 即 deny undefined 即 allow 任何 deny 即 deny 无 force allow。

### 4.2 execute() 完整管线

完整管线分四阶段：

阶段一 createExecution:
snapshotJsonValue 深拷贝 arguments 检查 visible 和 collapsed Code Mode 下非 run_code 调用被 collapse 在 policy pipeline 之前就 deny 保证 guard 和 approval 不会观察或批准一个注定失败的调用。

阶段二 prepareExecution:
callerCancelled 检查然后 waterfall tools/pre-execute 可返回 ask 或 deny serviceAsk 调用 approval service 最后 guardReason 运行 monotonic guards denial 生成 Error result。

阶段三 dispatchToolBody:
fuseToolSignals(callerSignal wrapperSignal) 创建组合 signal resolveExecution 查找工具定义 bodyInvoked 设为 true await tool.execute(args, exec) createSuccessResult 包装返回值。

阶段四 finalizeScheduledExecution:
post-execute waterfall deferredContexts 提交给 acceptor 用于下一步骤注入。

信号融合设计： caller cancel 不 abandon 已开始的 body 但结果标记为 ABORTED body 运行到 quiescence 后才标记。

### 4.3 ScopedLayers 机制

NamedEntries 唯一名插入重复 throw 返回 idempotent undo。

AnonymousEntries symbol key 保证独立性等值也独立注册。

ScopedLayers effect 方法将 mutation 绑定到调用者 Cordis fiber layer 变空自动删除避免 Map 无限增长。

peek vs chainLayers 区分 peek 只看精确 scope chainLayers 沿 parent chain 收集最近 scope 最后覆盖 restrict guard 只应看到自己 scope 的 contribution 不继承祖先的。

### 4.4 Code Mode

createRunCodeTool 创建 run_code 工具接受 code 和 language 参数发送到 ctx.codeRuntime 执行 worker thread 内预装 SDK 对象。

SDK_RENDERERS 表按语言渲染 SDK 文档注入系统提示 collapses(name, agent, hasParent) 判定是否被 collapse 为只能间接调用。

---

## 5. dsh-system-prompt — 提示词组装引擎

### 5.1 SystemPrompt 服务

构造函数验证 toolOrder 必须包含 unlisted tools rest 标记 注册 harness identity section order -100 和 deployment persona section order 0。

assemble(context) 完整流程：

1. scopeLayers = chainLayers(scope)
2. 检查 runtimeContextSuppressed
3. 收集 variables global 先 scopeLayers 远到近最近覆盖同名
4. merge sections 和 contexts scoped shadow globals
5. 收集 tool schemas structuredClone(parameters) 防止跨调用变异
6. 排序 sections 检查 completeSections 不超过 1 个
7. 构建 assembly 包含 sections contexts tools variables
8. waterfall system-prompt/assemble 允许插件修改
9. completeSection 存在则恢复为唯一 section
10. suppressed 则清空 contexts

### 5.2 变量插值

renderPrompt 对每个 section 做 interpolate 替换 variable 引用后用空行 join。

interpolate 严格模式所有错误 fail loud 包括 malformed reference unknown variable undefined value 变量替换后的值不再扫描防止注入循环。

变量名必须匹配 /^[a-z][a-z0-9_]*$/。

### 5.3 Tool Ordering

orderTools 按 toolOrder 配置排列未列出的按字典序插入到 rest 标记处未配置则纯字典序排序。

---

## 6. dsh-scope — 作用域分层原语

scopeOf(ctx) 读取 branded tag 返回 ScopeKey 或 undefined。scopeChainOf(scope) 返回从根到当前的完整链。

createScope(parentCtx, target) mint 子 scope fiber dispose 级联清理 scope 内所有 effect。

ScopedLayers effect 生命周期 每个条目绑定到调用者 fiber preset unload 自动注销 HMR reload 级联清理。

---

## 7. dsh-agent-default-model

提供 currentSelection 和 saveSelection 持久化到 settings namespace ApiProxy sessions.selectModel 无 session level override 时 fallback 此服务。

## 8. dsh-agent-tool-presentation

纯类型包定义 ToolCallView 和 ToolResultView card 字段 terminal diff read search web generic 驱动浏览器端原子 renderer 选择。

ApiProxy viewFor() 在推送事件时调用 presentCall 和 presentResult 序列化到 wire frame view 字段。
