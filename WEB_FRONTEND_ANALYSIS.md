# DeepSeek Harness Web 前端源码研究文档

> 本文基于仓库 `master`（`0.1.0-rc.7`）的源码逐层阅读整理，目标是把 `apps/web` 及其依赖的全部客户端代码逻辑讲清楚。适合对照源码学习：每一节都标注了关键文件的路径和行号范围。

## 1. 总体架构一句话

`apps/web` 本身只有 10 行代码（`apps/web/src/main.ts`），它做的事情是：找到 `#root` DOM 节点，然后调用 `new AppWebEntry(el).run()` 启动整个前端。所有真正的逻辑——插件加载、React 渲染、状态管理、通信协议——都分布在 `packages/client/*` 下的约 30 个包里，通过一个自研的浏览器端模块系统动态加载。

整体分层：

```
apps/web (Vite 入口)
  └── packages/client/web        ← 启动内核 AppWebEntry
        └── packages/client/modules  ← 浏览器端 CJS 模块表
              └── packages/client/runtime  ← 会话/工作区/槽位运行时
                    └── packages/client/ui-*  ← 约 20 个 UI 插件
                          └── packages/extensions/cordis-client-runner ← 动态插件加载器
```

## 2. 启动流程（Boot Chain）

### 2.1 宿主侧：生成启动清单

服务端在 `packages/client/modules/src/index.ts` 中扫描所有声明了 `"dsh": { "client": { ... } }` 的 npm 包，把它们组装成一个 `WebBootGraph` 对象，然后通过 `injectBootManifest()`（第 168 行）注入到 `index.html` 的 `<head>` 里作为第一个 `<script>`：

```js
window.__DSH_BOOT__ = {
  rev: "abc123...",       // 全图内容哈希（缓存一致性锚点）
  entries: [
    { id: "@deepseek-ai/dsh-client-connection",
      url: "/plugins/@deepseek-ai/dsh-client-connection/client.js?rev=...",
      rev: "...", inject: [...], immediately: true },
    // ... 每个客户端插件一行
  ]
}
```

- `id`: 包名，同时也是模块表的 key 和 Cordis loader entry 的 name。
- `url`: 插件的 JS bundle 地址（由同一个模块系统的 host half 通过 `/plugins/<id>/client.js` 提供）。
- `rev`: 该 bundle 的 sha1 短哈希（12 位），用于 cache busting 和 HMR 一致性。
- `inject`: 声明式的服务依赖列表（信息性；真正的激活顺序由 Cordis fiber inject waiting 决定）。
- `immediately: true`: 标记为"第一阶段预取"——在 Cordis Loader mount 之前就并行加载脚本以注册 factory。

当前标记为 `immediately: true` 的包有 6 个（见各 `package.json` 的 `dsh.client.immediately` 字段）：`client-connection`、`client-hmr`、`client-locale`、`client-modules`、`client-runtime`、`ui-theme`。

### 2.2 浏览器侧：AppWebEntry.run()（`packages/client/web/src/boot.tsx` 第 97 行）

完整启动序列如下：

1. **解析清单**：`parseBootManifest(window.__DSH_BOOT__)` 把原始 JSON 解析成两个视图：`modules`（模块表用）和 `plugins`（entry 组合用）。
2. **构建模块系统**：`new ClientModuleSystem({ modules, staticModules, ...seams })` 创建懒 CJS 表，并安装全局 `window.__ModuleLoader__.load()` 注册 sink。
3. **注册静态模块**：
   - `APP_SHELL_ID`（`@deepseek-ai/dsh-client-app-shell`）→ shell 自己的 app-shell 组装插件（静态打包进 shell bundle）。
   - `MODULES_ID`（`@deepseek-ai/dsh-client-modules`）→ 模块系统自身的 client half wrapper（同样静态打包）。
4. **渲染 Loading 页**：`createRoot(this.el).render(<AppRoot settled={...} status={...} error={...} renderApp={...} />)`。此时 `settled=false`，显示"HARNESS / Loading plugins…"卡片。
5. **预取 immediately 层**：并行调用 `modules.prefetch(row.id)` 加载每个 `immediately:true` 的 bundle script。失败静默吞掉（后续 create 时 import 重试并报错）。
6. **创建 Cordis Context 并 mount Loader**：`await ctx.plugin(Loader)` → `loader.internal = this.modules`（注入模块系统给 vendored loader 使用）→ 订阅 `internal/status` 事件把 fiber 状态投影到 loading 页。
7. **等待预取完成**（barrier）：确保所有 immediately-tier 的 factory 已注册，再创建 entry（防止同步 require 边缘竞态）。
8. **逐个创建 loader entry**：按 `[MODULES_ID, ...plugin rows, APP_SHELL_ID]` 顺序并行 `loader.create({name})`。Cordis Loader 内部会通过 `loader.internal.import(name)` 触发模块系统的 `import(specifier)` → fetch script → 执行 factory 注册 → materialize exports → 作为 Cordis plugin apply。
9. **等待全部 active + 全量扫描**：`await loader.await()` 然后 `assertEntriesActive()` 遍历每个 entry，检查 fiber state 是否为 `ACTIVE`。任何一个不是 active 就 throw 一个包含完整诊断的错误。
10. **切换 UI**：`this.settled.set(true)` → React `useSyncExternalStore` 触发重渲染 → AppRoot 调用 `renderApp()` → 从 ctx 取出 `appShell.renderApp()` → 渲染真实 UI 树。

如果任何步骤失败，`catch(reason)` 设置 `error` signal，loading 页变成红色错误报告（列出失败的 entry 名字和缺失的服务），永远停留在 boot 页面不进入真实 UI。

## 3. 浏览器端模块系统（`packages/client/modules/src/client/system.ts`）

这是一个自研的"懒 CJS"模型，核心思想是：**bundle script 执行只做一件事——注册一个 factory 函数到全局表；所有副作用（包括 CSS 注入）都延迟到第一次被 require/import 时才发生**。

### 3.1 四张状态表

```
seed:         Map<string, unknown>      ← 静态共享库（react, cordis, ui-primitives 等）
statics:      Map<string, unknown>      ← shell 自有模块（app-shell, modules 自身）
factories:    Map<string, Factory>      ← 已注册未物化的插件 factory
loadCache:    Map<string, ModuleRecord> ← 已物化的模块记录（exports + styles + edges）
graphRows:    Map<string, BootModuleRow>← 从 __DSH_BOOT__ 解析出的远程行索引
pendingArrival: Map<string, Promise>    ← in-flight script 加载去重
materializing: Set<string>              ← 物化循环检测
```

### 3.2 解析顺序（import/require 共用）

1. `seed.has(spec)` → 直接返回（react, react-dom, cordis 等）
2. `loadCache.get(id)` → 返回已物化的 record.exports
3. `statics.has(id)` → 返回并物化（shell 自有模块）
4. `factories.has(id)` → 同步递归物化（跨包 require）
5. `graphRows.get(id)` → 异步 fetch script + 等 factory 注册 + 物化（仅 async import 路径）
6. 其他 → throw（构建时 bundle purity gate 的运行时镜像）

`require()` 是同步版本，少了第 5 步（异步 fetch 不可达）。这意味着跨插件的值导入必须在构建时就满足 bundle purity gate（不允许 client 包 A 直接 import client 包 B 的运行时值）。

### 3.3 CSS 所有权与 HMR 清理

当 factory 执行时可能往 `<head>` 插入 `<style>` 标签。`claimStyles(id)` 在物化完成后扫描所有没有 `data-plugin` 属性的 style 标签，打上 `data-plugin="<id>"` 归属标记，然后收集属于该 id 的标签列表存入 `record.styles`。这个列表在 HMR 卸载旧 bundle 时用来精确删除该插件拥有的样式。

## 4. Slot 系统（UI 组合的核心机制）

Slot 是这个前端最独特的设计模式。它解决的问题是：**如何让约 30 个独立编译、独立加载的 UI 包组合成一个完整的界面，而不需要它们互相 import？**

### 4.1 类型层契约（`packages/client/ui-slots/src/index.ts`）

```ts
// 每个包通过 declaration merging 向全局 SlotMap 声明自己拥有/需要的 slot key
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar': { kind:'single', scope:'root', owner: SidebarOwnerProps }
    'conversation.chat.node': { kind:'keyed', scope:'session', inject: ChatNodeTurnDataInjected }
    'conversation.composer': { kind:'chain', scope:'session' }
    ...
  }
}
```

三个维度决定一个 slot 的行为：

- **kind**: `single`（唯一占位者）| `list`（有序列表）| `keyed`（按 entryKey 分派）| `chain`（selector 路由选举）。
- **scope**: `root`（无 session 数据）| `session-maybe`（当前 session 可选）| `session`（严格需要 sessionId）。
- **owner/inject/keyProps/hookContext**: 各类 props share 的类型约束。

### 4.2 运行时注册（`packages/client/runtime/src/client/slots.ts` SlotRegistry 类）

`ctx.slots.register(options, Component)` 是唯一的注册 API。它做几件事：

1. 验证 options 与目标 slot 的 kind/scope 契约匹配。
2. 把组件包装成 `StoredEntry`（带 registrant stamp、order、priority 等）放入 core ledger。
3. 通过 `ctx.effect(() => disposer)` 绑定到调用者的 Cordis fiber——**插件卸载时自动注销所有它注册的 slot entry**。
4. 如果声明了 `store: createXxxStore` 工厂，为该 entry mint 一个 per-scope store instance。
5. 如果声明了 `locale: NS`，验证 locale face 已安装并在渲染时合成 `t` seat。

`ctx.slots.inject(key, callback)` 是一个配套 API：等目标 slot 的声明出现后再执行 callback（通常里面调 register）。这解决了"声明者和注册者激活顺序不确定"的问题——你可以先写 inject 再写 register，框架会保证正确时序。支持 generator 形式做事务性多注册。

### 4.3 渲染分派（`packages/client/web-react/src/scoped-slots.tsx`）

Shell 只做一件事：`ctx.slots.renderSlot('root', {})`。之后整棵树由 slot outlet 递归驱动：

- 每个 `renderSlot(key, ownerProps)` 调用在 React 树中产生一个 `<div data-slot={key}>` 锚点元素（display:contents 不影响布局）。
- Outlet 内部通过 `useSyncExternalStore(subscribe(key), getVersion(key))` 订阅该 slot key 的注册变更。
- 根据 spec.kind 分派：
  - **single**: 取 `entriesOfSlot()[0]`（priority 排序后的 winner），用 `entryKeyOf(entry)` 作为 React key 保证 crash boundary remount。
  - **keyed**: 按 `opts.entryKey` 在 winners 中查找匹配项。
  - **list**: 按 order/id 去重后逐个渲染。
  - **chain**: 依序调用每个 entry 的纯函数 selector `(owner) => matched | null`，第一个返回非 null 的当选并挂载；全部 null 则渲染 fallback（可选 overlay 保持 fallback mounted 以保留 draft 状态）。
- 每个 entry 被 `<SlotErrorBoundary>` 或 strict-session variant 包裹。crash 时上报 `host.reportEntryError(slotKey, entry, error, {abdicate})`；对 shadowing kinds（single/keyed/list）执行 abdicate 让下一个 survivor 补位；对 chain 仅报告不 abdicate。

### 4.4 Standard Props 自动注入

根据 scope 不同，框架自动向每个 slot component 的 props 中注入一组标准 hooks：

| scope | 注入的 hooks |
|---|---|
| root | `useSessions`, `useWorkspaces` |
| session-maybe | 上述 + `useSession` (MaybeSnapshotSelectorHook), `sessionId?: string`, `useProjection`, 以及各 provide channel 成员如 `useInput`, `useComposerBlock` |
| session | 上述但 useSession 为严格版, sessionId 为 string |

这些 hooks 由 renderer 在渲染前从 bare observable source 缓存绑定（WeakMap per source identity），保证引用稳定不导致子组件 resubscribe。

## 5. 会话运行时（Session Runtime）

这是整个前端最复杂的子系统，负责维护会话列表、选中状态、事件窗口、对话视图快照和实时流订阅。

### 5.1 三层数据流

```
WebSocket frames (mux/host 双通道)
  ↓ ConnectionController (自动重连 + backoff)
SessionManager.handleMuxEnvelope() / handleHostEnvelope()
  ↓ 路由到 Session 实例或更新 list snapshot
SessionRuntime.list: SnapshotStore<SessionListState>
  ↓ useSessions(selector) hook
React components
```

### 5.2 SessionManager（`packages/client/runtime/src/client/sessions/manager.ts`）

职责：
- 维护 `Map<SessionId, Session>` 实例簇（lazy-built, resident——一旦创建就常驻消费离屏帧）。
- 维护 `summaries: SessionSummary[]` 列表基线 + frame mutations replay buffer（处理 pull 期间到达的增量帧）。
- 维护 `pendingInteractions: Map<SessionId, Map<string, PendingInteractionStatus>>`（侧边栏琥珀点数据源）。
- 维护 `completedNotifications: Set<SessionId>`（绿色"done"提醒点）。
- 维护 `projectionStores: Map<SessionId, ProjectionValueStore>`（宿主计算的标题/token 用量等 whole-value 投影）。
- 维护 subagent catalog（`subagentsByParent`、地址簿、debounced refresh）。

Mux 帧路由逻辑（`handleMuxEnvelope`）：
- `session/event` → 更新 activity timestamp → 如果是 user/message 还触发 blank flip。
- `session/projection` → 直接写入 projectionStore 并 markDirty（无论 session 是否已实例化）。
- `approval/requested` / `question/requested` → 更新 pendingInteractions map → 如果 session 未实例化则缓冲到 pendingBuffers。
- `session/queue` / `session/subscribed` / `session/jobs` → 类似路由。
- `stream/error` → 忽略（Controller 层处理）。

Host 帧路由逻辑（`handleHostEnvelope`）：
- `host/session-added` → mergeSummary（insert-or-enrich）。
- `host/session-removed` → durableSubagent 则降级为 status:false，否则 remove + 清理 buffers/stores/catalogs。
- `host/session-status` → 更新 running bit + syncCompletedNotifications（running→idle 且非 selected 时 arm reminder）。
- `host/agent-error` → 存入 projectionStore 供 UI 显示。
- workspace 变更帧 → WorkspaceManager 处理。

### 5.3 Session 对象（`packages/client/runtime/src/client/sessions/session.ts`）

每个已实例化的会话对应一个 Session 对象，持有以下私有状态：

- `events/views`: 当前窗口的原始日志切片和 wire view 数组（保持平行而非合并，因为 events 必须保持 raw log 语义）。
- `baseSeq/hasMore/loadingOlder/openGeneration`: 分页和断线重连 generation guard。
- `pending: Map<rpcId, PendingWait>`: 待回答的 approval/question wait。
- `queueMirror: SessionQueueMirror`: 权威的 transient queue 快照。
- `conversation: ConversationNodeAssembler`: 业务上下文引擎（见下节）。
- `running/address/parentAvailable/subagent`: 子代理路由元数据。
- `promptAttempted/firstPromptPendingTurn/blankBit/promptError/lastAgentError`: composer phase machine 的输入。

**open() 流程**：pull tail page (`history({maxMessages:50})`) → installWindow 替换整个窗口 → conversation.replaceWindow → stitch liveBuffer（seq dedup）→ markDirty。

**acceptLiveEvent(event)**：如果 open/resync/gap-repair 进行中 → push 到 liveBuffer。如果 seq gap → 也 push 到 liveBuffer 并触发 repairGap()（repull tail page 后统一 stitching）。正常路径直接 appendLive。

**handleMuxEnvelope(rpcId, frame)** switch:
```
session/event      → acceptLiveEvent
session/queue     → queueMirror.replace(items); markDirty
session/subscribed → subscribedLastSeq = lastSeq; queueMirror.reset(); markDirty
approval/requested → mint PendingWait('approval', rpcId, payload); markDirty
approval/resolved  → settle matching pending; markDirty
question/*          → 同上
default            → ignore (documented)
```

**getSnapshot()** 返回缓存的 `ConversationSnapshot` 对象，包含：
```ts
{
  sessionId, views: ConversationNodeAssembler,
  chat: ChatSnapshot, nodes, turnTimings, turnEnds, partial, runningCalls,
  pending: PendingInteraction[], queue: QueuedMessage[], running,
  subagent, composerPhase, removed, openState, openError,
  hasMore, loadingOlder, promptError, blank, lastAgentError
}
```

### 5.4 ConversationNodeAssembler（`packages/client/runtime/src/client/sessions/conversation-assembler.ts`）

这是把原始 `SessionEvent[]` 转换为结构化业务节点（用户消息、assistant 步骤、tool call tree、命令行、compaction 标记……）的核心引擎。它是一个通用的增量 assembler，通过两个 registry 驱动：

- `ConversationEventRegistry`: 注册 `ConversationNodeDefinition`（match/start/update/publication/buildViewNode）。
- `ConversationViewRegistry`: 注册 `ConversationViewDefinition`（target + create builder factory）。

工作原理：
1. 每条新 event 经过所有 definitions 的 match() 尝试匹配。命中的 definition 返回 `{ id, role: 'start'|'update' }`。
2. start role 创建新的 business context（state + matches 列表）；update role 追加到已有 context。
3. context 可以通过 dependencies 声明依赖其他 context（例如 turn-tail 依赖 assistant-step 的 location data）。
4. 当某个 context dirty 时，调用 buildLocationData(step/turn scope) 和 buildViewNode() 产出 `ConversationViewNode`。
5. 这些 nodes 按 target 分组喂给对应的 view builder（如 ChatSnapshotBuilder）。
6. View builder 维护自己的 store/order/timeline 并产出最终 snapshot（如 ChatSnapshot）。
7. Publication cadence 由 match 到的事件类型决定：普通 delta → `'animation-frame'`；结构性变化 → `'immediate'`。

当前 chat target 下注册了约 10 种 node definition（见 `packages/client/ui-conversation/src/client/conversation-nodes/register.ts`）。

## 6. 连接层（Connection Layer）

### 6.1 ConnectionController（`packages/client/connection/src/client/connection.ts`）

管理两条 WebSocket downlink 的生命周期：

- **mux stream** (`/api/events.mux`): 会话级事件流（session/event、approval/question、queue、jobs、projection）。
- **host stream** (`/api/events.host`): 全局生命周期流（session created/disposed、workspace 变更、agent status/error、forwarded remote events）。

连接循环：
1. 打开两个 WebSocket + 发起 `host.describe()` unary RPC。
2. 等待两者 onOpen（超时 3s 兜底）+ describe 结果。
3. 成功 → `emitState('connected')` → `sinks.onConnected(descriptionResult.value)`。
4. 任一 stream 断开或 describe 失败 → abort 当前 generation → `emitState('reconnecting')` → 指数退避重试（500ms × factor^n，cap 10s，含 jitter）。

Sink 回调隔离：每个 sink 调用都包裹在 try-catch 中，业务层的异常不会拖垮连接泵。

### 6.2 WebApiClient（`packages/client/connection/src/client/web-api-client.ts`）

Unary RPC 用 `fetch POST /api/<method>` + JSON envelope（`ClientRequest`/`ServerResponse` schema 校验 + rpcId 匹配）。Downlink 用原生 WebSocket + zod schema 解析每帧 payload，malformed 帧静默丢弃并 console.error。

Fixture mode：URL 含 `?fixture` 时切换到 `FixtureApiClient`（内存 mock），用于测试。

### 6.3 Host 侧信任栅栏（`packages/client/connection/src/index.ts`）

所有 `/api/*` 请求先经过 `isTrustedApiRequest(req, trustedHosts)` 检查：
- loopback origin 始终放行。
- 非 loopback 需要 Host header 匹配 `trustedHosts` 白名单（LAN IP 字面量或 `--trusted-host` 显式指定）。
- 敏感方法（settings.write、credentials.*、llm.discoverModels、plugin-inventory 等）额外要求 loopback-only（即使 trustedHosts 放行了也拒绝），防止 DNS rebinding 探测。

WebSocket upgrade 同样走信任检查。HTTP body 大小限制默认 160MB（容纳 base64 图片聚合）。

## 7. UI 布局与主题

### 7.1 AppFrame（`packages/client/ui-layout/src/client/AppFrame.tsx`）

三栏 grid 布局（sidebar | center | details），由 `computeColumns(viewport, sidebarPref, detailsPref)` 纯函数求解宽度分配：

1. 如果三者之和 ≤ viewport → 全部使用偏好宽度。
2. 否则收缩 details 到 min（300px）；如果还不够则 details=0（关闭但不卸载）。
3. sidebar 从不让步（264~420px clamp，0 = collapsed rail 56px）；center 吸收剩余赤字（可低于 640px floor）。

Narrow breakpoint (<1024px) 时 sidebar 强制折叠为 rail；toggleSidebar 在 narrow 下翻转 `narrowExpanded` override 而非改 width preference，这样 re-widening 能恢复之前的宽度。

拖拽 handle 使用 pointer capture + rAF throttle，drag base 冻结在 gesture 开始时的渲染宽度避免 compounding。

### 7.2 ThemePresenter（`packages/client/ui-layout/src/client/theme-presenter.ts`）

纯 DOM 写入器（无 React 参与），监听 `ctx.on('theme/change')` 事件：
- 设置 `html.style.colorScheme = light|dark`。
- 设置/移除 `body[data-ds-dark-theme]` attribute。
- 将 active theme 的 token overrides 写为 body inline CSS custom properties。
- 计算 computed backgroundColor 写入 `<meta name="theme-color">`。

dispose 时精确 retract 自己写入的所有属性，不影响外部代码。

## 8. 主要 UI 插件速览

下面列出每个 UI 包的核心职责和关键文件入口。完整的 slot 声明请参考 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`（生成的编译时目录）。

### ui-conversation（中央列）

- `apply()`（`packages/client/ui-conversation/src/client/apply.ts`）声明了约 15 个 child slot key 并注册了骨架组件族。
- `ConversationRoot`: 常驻骨架，hero/composer 切换由 composerPhase + openState + summaryBlank 推导。composer chain 用 overlay:true 保持 InputBar mounted 以保 draft。
- `ChatView`（`packages/client/ui-conversation/src/client/chat/ChatView.tsx`）: 稳定 keyed parent list over final business Nodes。每行通过 `ChatNodeSeat` memo 订阅单个 node key。滚动逻辑复杂：bottom-follow threshold 24px、prepend anchor restoration、observedTop ledger 区分 reader vs programmatic scroll。
- `InputBar`（`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx`）: 双文本层（透明 textarea + backdrop chips/mirror）。InputMachine 管理草稿/chips/undo/submit 状态机。Enter adjudication 走 trigger pipeline（/command → claim → submit transaction）。
- `DetailsPanel`: 右栏工具详情查看器。
- `QueueDock/TodoPanel/GoalDock/StatsLine/ContextMeter`: 输入区域的各种 dock strip。

### ui-tool（Tool 调用渲染树）

- `ToolCallTree`（`packages/client/ui-tool/src/client/tool/ToolCallTree.tsx`）: 递归 root/subcall composition，每个原子 call 通过 `tool.call.toolview` keyed slot 分派到具体 renderer。
- 内置 7 种 atomic view（read/search/file-mutation/bash/todo/ask-question/web），每种都是一个独立的 plain-registrant plugin（如 `readToolview`），遵循统一的 ToolRow chrome。
- `GenericToolCard`: 未识别 tool 的 JSON fallback。

### ui-workspace（左侧浏览区域）

- `WorkspaceBrowser`: workspace 分组/flat 列表 + search + drag reorder + rename/archive/fork dialogs。
- `WorkspacePicker`: hero 空态的 workspace 选择菜单。
- 两者各自声明一个 `directoryFlow` single slot，由 native/browse picker backend 插件填充。

### ui-sidebar / ui-settings / ui-settings-general

- SidebarRoot: 左栏外壳（collapse animation、pointer-aware scrollbars）。
- SettingsRoot: 模态面板（section nav + content area），onboarding coordinator。
- GeneralSection: 语言/Appearance/Agent preset 默认/Permission 默认等 feature-owned rows。

### ui-settings-models / ui-agent-preset / ui-permission-presets

- ModelsSection: provider 目录 join settings namespace + credential 状态，编辑/添加/删除 provider 卡片。
- AgentPresetSeat/Section: 新建 session 时的 preset 选择 chip + 管理页面（copy/view/delete/make-default）。
- PermissionSelect: composer 工具行的权限模式 chip，读 permissions projection，切档走 /permission command。

### ui-input-trigger + ui-commands + ui-subagent + ui-skill

四层输入触发管线：
1. `ui-input-trigger`: 根 service + per-session controller（trigger detection、menu state machine、candidate fetch lifecycle）。
2. `ui-commands`: '/' command source（host directory + client contributions/decorations + popupSelect controller）。
3. `ui-skill`: '/skill-name' source（session-scoped catalog cache + plain-text reference insertion）。
4. `ui-subagent`: '@child-label' source（从 session list snapshot 过滤 running children）。

### ui-jobs / ui-message-feedback / ui-goal / ui-plan / ui-deliverables / ui-trajectory / ui-workflow-run

各种 feature-owned surface，全部遵循同一模式：读 projection or list mirror → render → mutate via Remote API or command。

### extensions/cordis-client-runner + extensions/ui-cordis（动态插件系统）

- `DynamicCordisPackageRunner`: evaluate closure → wrap with guard facade → register into module table as `dyn/<pluginId>` → create loader entry → cascade unload via fiber disposal.
- Guard facade: whitelist CTX_VERBS + declared services; slots seat auto-assigns shadowing priority and claims component identity for render-crash attribution.
- `CordisPanel`: sidebar footer action showing inventory/approvals/version transitions/run controls.
- Tool cards: `cordis_define/run/stop/undefine` 各自有专用 renderer + run-card ownership index.

## 9. HMR（Hot Module Replacement）

开发链路（`packages/client/hmr/`）：

**Node half**（`packages/client/hmr/src/index.ts`）:
- 每 500ms stat-poll 所有 graph row 的 client bundle 文件。
- mtime/size 变化 → `clientModules.rebuilt(id)` 重新计算 sha1 hash → 如果变了则通知 rebuildListeners。
- SSE endpoint `/plugins/events` 广播 `{type:'rebuilt', id, rev}` 帧。

**Browser half**（`packages/client/hmr/src/client/index.ts`）:
- EventSource 监听 SSE → 收到 rebuilt 帧后串行 reload：
1. `modLoader.invalidate(id)` — drop stale factory + loadCache record。
2. `modLoader.prefetch(id)` — fetch fresh script 注册新 factory。
3. Registry-first teardown: `entry.ctx.registry.delete(runtime.callback)` → drain old fiber inertia → `delete entry.fiber`。
4. `removeOwnedStyles(id)` — 移除旧 `<style data-plugin=id>` tags。
5. `entry.refresh()` — 重新 import/materialize/re-plugin under the same entry context。
6. `fiber.await()` — surface apply failures loudly。

Cascade is zero-touch: downstream fibers key their activation epoch on provider fiber uids，所以替换一个 provider fiber 自然 cascades into its dependents without extra bookkeeping.

Failure policy: no rollback. Import failure leaves the entry fiberless (retryable next rebuilt frame). Apply failure leaves FAILED fiber visible in boot status.

## 10. 安全模型摘要

| 层面 | 机制 |
|---|---|
| DNS rebinding | `/api/*` trust fence: loopback always allowed; non-loopback requires explicit trustedHosts match |
| Privileged methods | settings/credentials/plugin-inventory pinned loopback-only regardless of trustedHosts |
| Cross-site write | POST requires `content-type: application/json` (forces CORS preflight this server never answers) |
| Bundle purity | Build-time: no cross-plugin value imports. Runtime: module table throws on unregistered specifier |
| Boot integrity | `window.__DSH_BOOT__` injected before shell loads; graph rev is content-hash of all entries |
| Dynamic plugins | Guard facade whitelists ctx access; closure traps redirect setTimeout/fetch/require to teaching errors |
| XSS | MarkdownText disables raw HTML, relative links, unsafe protocols; only absolute HTTP(S) images render |

## 11. 关键设计决策与理由

以下是阅读过程中发现的几个值得注意的设计选择及其背后的权衡：

1. **懒 CJS 而非 ESM**：允许 bundle script 执行零副作用（只注册 factory），使得 invalidate→prefetch→refresh 的 HMR 序列成为可能而无需 page reload。代价是不能用 tree-shaking，但这对 plugin bundles 无关紧要。

2. **slot 系统而非 React Context**：Context 要求 Provider/Consumer 在同一棵 React 树中且有父子关系。Slot 系统允许完全独立编译的包通过声明合并建立类型安全的组合关系，同时通过 Cordis fiber 实现生命周期绑定。代价是调试时 stack trace 更深。

3. **Session resident 而非 lazy-load**：一旦实例化就常驻消费离屏帧，这样后台 session 的 approval/question 不会丢失。代价是内存中可能同时存在多个 Session 对象及其窗口数据。

4. **双 WebSocket 而非单 mux**：mux 是 per-session scoped 的业务流；host 是全局生命周期的管理流。分离让 session-level resync 不影响 workspace 监听。代价是两条连接的管理开销。

5. **宿主计算 projections 而非 client folding**：title、tokenUsage、contextPressure、todos、goal 等都是宿主算好推送 whole value，client 只是展示。这样避免了 client 端 domain logic duplication，也让 cold title 能出现在列表而不必打开 session。代价是需要一套 projection registry/cache/frame 推送基础设施。

## 12. 延伸阅读

- [ENGINEERING_ANALYSIS.md](ENGINEERING_ANALYSIS.md): 项目整体技术方案总览。
- [LEARNING_GUIDE.md](LEARNING_GUIDE.md): 面向 JS 基础较弱读者的代码精读路线图。
- [docs/architecture.md](docs/architecture.md): 英文架构地图（composition, core packages, loop, seams）。
- [docs/subsystems/](docs/subsystems/README.md): 各子系统参考页（type definitions + generated API docs）。
