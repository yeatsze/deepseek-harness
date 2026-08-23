# DeepSeek Harness 工程技术方案分析

> 本文基于仓库当前 master（`0.1.0-rc.7`）的源码与官方文档整理，用于快速理解项目「是什么、怎么实现、整体技术方案」。所有结论均可回溯到 `docs/`、`packages/*/README.md` 与 `AGENTS.md` 中对应的原始描述。

## 1. 项目是什么

DeepSeek Harness（包名 `dsh`）是 DeepSeek AI 开源的 agent harness（智能体运行框架），采用 **一切皆插件（everything is a plugin）** 的架构，底层由 vendored 的 [Cordis](https://github.com/cordiverse/cordis) 插件框架驱动，设计思想对应论文 _A Programming Paradigm for Spatiotemporal Composability_。

一句话定位：**一个把「模型请求 → 系统提示组装 → 工具执行 → 会话持久化」全部拆成可替换插件的 agent 运行时**。模型适配器、工具注册表、会话日志、甚至 agent 主循环本身都是插件，都可以通过配置替换，没有需要打补丁的“特权核心”。

### 1.1 现状与边界

- 当前处于 **开发者预览（developer preview）** 阶段，版本 `0.1.0-rc.7`，未来会有破坏性变更。
- 没有对外兼容承诺：后端拒绝旧的磁盘格式；SQLite 使用单调递增的 `SCHEMA_VERSION`；`dsh-session` 的 `SESSION_FORMAT_VERSION` 固定为 `0` 且不提供迁移。
- 许可证 MIT，第三方依赖与许可证见 `THIRD_PARTY_NOTICES.md`。
- 典型运行方式：`npx @deepseek-ai/dsh web` 启动 Web UI（默认 `http://127.0.0.1:3080`）；`pnpm dsh --profile headless "task"` 跑一次性 headless 任务。

## 2. 核心设计思想

### 2.1 一切皆插件

产品没有不可替换的内核。模型适配、工具、会话日志、agent 循环全部以 Cordis 插件形式存在，并挂载在同一个共享 context 上。扩展 dsh 的方式是“在旁边再挂一个插件”，而不是修改核心；所有注册（tool、prompt section、adapter、listener）都是**可逆的 effect**，插件卸载时自动回滚。

### 2.2 Cordis 五要素

仓库在 `docs/cordis-primer.md` 中把 Cordis 概括为五个核心概念：

1. **插件（plugin）**：实现 `Service` 的对象，可以是带 `inject`/`apply(ctx)` 的函数，也可以是 `Service` 子类。
2. **上下文（context）**：服务的仓库。服务通过稳定的 `ctx.<key>`（如 `ctx.tools`、`ctx.llm`、`ctx.sessions`）暴露自己，其他插件按 key 查找，不 import 具体实现。
3. **依赖注入（inject）**：插件声明需要的服务，加载顺序由服务依赖关系决定，而不是手工排启动顺序。
4. **类型化事件（typed events）**：服务通过 TypeScript declaration merging 声明事件名，用 `emit` / `waterfall` / `parallel` / `serial` 四种分发模式通信。
5. **可逆注册（reversible effects）**：一切注册都通过 `ctx.effect()` / `ctx.on()` 完成，返回 disposer，保证重载与卸载可预期回滚。

四种事件分发模式：

| 模式 | 是否等待 | 分发顺序 | 有返回值 |
| --- | --- | --- | --- |
| `emit` | 否 | 按注册顺序观察 | 无 |
| `waterfall` | 否（逐级 next） | 按注册顺序 | 有（可改写/短路） |
| `parallel` | 是 | 并行观察 | 无 |
| `serial` | 是 | 按注册顺序 | 有 |

`waterfall` 是“around 中间件”语义：listener 拿到 `(...args, next)`，调用 `next()` 委派给下一个，不调用即短路。`agent/pre-step`、`agent/request`、`llm/stream`、`tools/*` 都是 waterfall。

### 2.3 仓库级类型模式

几乎所有可扩展联合类型都遵循 `…Map → 派生联合（derived union）` 模式：定义一个以判别标签为 key 的接口，再用 `keyof` 派生联合类型；插件通过 **declaration merging** 增加变体，不需要改源包。六个典型 map：

| Map | 所属包 | 派生 |
| --- | --- | --- |
| `ContentBlockMap` | `dsh-llm` | `ContentBlock` |
| `MessageSourceMap` | `dsh-llm` | `MessageSource` |
| `FinishReasonMap` | `dsh-llm` | `FinishReason` |
| `TurnTriggerMap` | `dsh-session` | `TurnTrigger` |
| `TurnEndReasonMap` | `dsh-session` | `TurnEndReason` |
| `SessionEventMap` | `dsh-session` | `SessionEvent` |

### 2.4 能力接缝（capability seam）

一个可替换能力由三个角色组成，缺一不可：

- **Service Definition**：声明接口的 Cordis `Service`（抽象类或注册表，如 `ShellExecutor`、`WebRuntime`），拥有自己的 `ctx.<key>` 与词汇表；
- **Service Provider**：实现该接口的一个或多个后端；
- **Consumer**：注入该服务的消费方，通常是模型可调用的 tool。

典型例子是 shell：`dsh-shell`（Definition）、`dsh-bash-local` / `dsh-bash-sandbox` / `dsh-pwsh-local`（Providers）、`dsh-tool-bash`（Consumer）。能力接缝的意义在于：换一个 provider 就能改变整个产品的行为。例如把 `ctx.fs` / `ctx.subprocess` 指向远端沙箱，Bash、PTY、LSP 会一起跟着走，无需各自 fork 一份实现。

## 3. 仓库布局与包分层

```
vendor/      vendored Cordis 源码 + 同步流程（vendor/README.md）
packages/    @deepseek-ai/dsh-<pkg> 工作区包（packages/<group>/<pkg>）
python/      Python SDK 与打包运行时（python/README.md）
native/      @deepseek-ai/node-addon-landlock-run 源码
examples/    可运行 cordis.yml（agent-spine + CLI/ACP/JSON-RPC bins）
.agents/     Agent 工作流与 Agent Notes（notes/）
docs/        架构、生成目录、postmortem、cookbook
scripts/     仓库门禁与生成器
website/     VitePress 双语文档站点
apps/        CLI 应用（apps/cli）
```

包按组组织，每组 README 维护该组的包 / `ctx` key 映射（`packages/README.md`）。分组概览：

| 组 | 职责 |
| --- | --- |
| `core/` | 产品 API 主干：session、system-prompt、tools、agent 服务、具体主循环 |
| `api/` | 远程 BFF 装配与 Typert RPC 网关 |
| `typert/` | 类型图生成、加载与运行时注册表 |
| `llm/` | LLM 能力族：抽象服务 + provider 适配器 |
| `subprocess/` `shell/` `terminal/` `fs/` `lsp/` `web/` | 各类执行/能力接缝 |
| `sandbox/` | 进程约束接缝（bwrap/Landlock/Seatbelt/Windows ACL） |
| `skill/` `compaction/` `context/` `subagent/` `workflow/` `jobs/` | 模型侧扩展能力 |
| `session/` `session-query/` `storage/` | 持久化数据面 |
| `settings/` `credentials/` `identity/` | 用户配置与身份 |
| `sdk/` `acp/` `hooks/` | 对外集成协议 |
| `host/` `client/` | Web GUI 的 Host/浏览器两半 |
| `bundle/` | 可安装的 `dsh --profile` patch 层 |
| `boot/` `util/` `test-support/` | 启动胶水 / 零依赖工具 / 测试基建 |

## 4. 启动装配：Profiles 与 Bundles

一个运行中的 `dsh` 是**启动时按有序层组合出来的插件树**。

### 4.1 概念

- **Profile（配置档）**：存放在 Harness home（`$DSH_HOME`，默认 `~/.dsh`）`profiles/<name>/` 下的命名组合，声明自己叠加哪些 bundles、安装哪些 out-of-tree 插件、以及用户自己的 `cordis.patch.yml`。`web` 和 `headless` 是随产品内置的模板，首次使用自动初始化。
- **Bundle（发行包）**：Cordis 配置行 + 其挂载代码的发行格式。`package.json` 的 `dsh` 字段声明身份：`dsh.profile` 列出 bundle 顺序，`dsh.bundle` 指向 bundle 的 patch 文件。
- **`dsh-base`**：每个 profile 的第一层，包含模型适配器、工具、持久化、沙箱与审批策略、settings、credentials、telemetry。`dsh-web-app` 在上面加浏览器应用；`dsh-headless` 加一次性 runner（无服务器）。

### 4.2 层叠顺序

```text
空条目列表
  → profile 中每个 bundle 的 patch（按 dsh.profile.bundles 顺序）
  → profile 的 cordis.patch.yml
  → home 级 $DSH_HOME/cordis.patch.yml（覆盖 profile 层）
  → --patch 覆盖层
```

patch 以条目 id 为靶：替换整条 `config`（不做 deep-merge，未重述的字段会被丢弃）或 `insert` 新行；`!!js` 表达式允许在 mount 时插值。`dsh --profile web --dump-config` 可以离线打印最终组合树，任何一行都可以被用户 patch 替换。

### 4.3 启动链路

`dsh` CLI（`apps/cli`）解析自己的参数后把剩余参数交给 booted profile。`dsh-app-boot` 提供共享启动胶水：加载分层环境变量（继承环境 > 项目 `.env` > home `.env`）、解析 patch、mount Cordis include 树、等待所有 entry 激活、fail-loud 处理加载失败。加载失败会先 dispose 半成品 context（保证终端原始模式等表面状态被还原）再退出。用户 patch 文件保持 HMR 监听，配置变更时事务性重载，失败保留最后可用树。

## 5. 核心运行机制

### 5.1 六包主干（core spine）

一次完整对话由 `core/` 下六个包在一个循环里协作完成：

| 包 | 职责 | `ctx` key |
| --- | --- | --- |
| `session/` | 追加式 `SessionEvent` 日志 + 内存 store（唯一事实来源） | `ctx.sessions` |
| `system-prompt/` | prompt section 与 tool schema 组装 | `ctx.systemPrompt` |
| `tools/` | 带作用域的工具注册表 + 受保护的执行管道 | `ctx.tools` |
| `agent/` | `Agent` 接口、活体注册表、`agent/*` 事件词汇 | `ctx.agents` |
| `agent-loop/` | 实现公开 `Agent` 契约的具体驱动（可替换） | `ctx.agentLoop` |
| `scope/` | 每-agent 作用域注册原语（无服务 key 的库） | 无 |

`agent-loop` 是唯一的默认主循环实现，扩展插件只依赖 `agent`，不依赖 `agent-loop`，因此循环可被整体替换。默认把主干拼成可运行 agent 的组合是 `examples/agent-spine-demo`。

### 5.2 术语：step 与 turn

- **step**：一次模型请求 + 该响应引发的工具执行。
- **turn**：零个或多个 step。turn 在第一个输入被认领前打开，在所有“欠账”（模型、工具、steering）清空后关闭。

### 5.3 完整 turn 流程

```text
turn/start
  claim 下一个 step 的输入 + 一条排队消息
  组装 prompt sections + tool schemas
  → agent/pre-step                reject | enter(messages)
     reject 或改写为空 → 不产生 step 直接关 turn
     step/start
     append entered messages 为 user/message
     从日志派生模型历史
     agent/request → llm/stream → assistant/chunk* → assistant/message
     tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result*
     step/end
     工具还需要请求，或有新 next-step 输入 → 继续下一个 step
  → agent/turn-stopping
turn/end
```

`turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*` 是**持久化 session 事件**；`agent/pre-step`、`agent/request`、`llm/stream`、三个 `tools/*` 是 live 扩展点（waterfall）；`agent/turn-stopping` 是 serial 终端检查点。所有输入从同一个 inbox 进入；`agent.inject()` 注入的上下文先排队，等后续消息唤醒。

### 5.4 Session：事件溯源（event-sourced）会话日志

会话的唯一事实来源是**追加式类型化 `SessionEvent` 日志**。模型历史不是单独存储的，而是每次由 `deriveMessages()` 从日志派生；fork、resume、transcript、telemetry、持久化全部复用这条流。

核心事件词汇（`SessionEventMap`，可 declaration merging 扩展）：

`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`、`steering/message`、`todo/write`、`request/header`、`request/context`、`session/end-seed`，外加插件合并的 `compaction/*`、`hook/*` 等。

关键设计：

- **Model-visible ⟺ logged（模型可见的必须被记录）**：任何进入模型请求的内容都必须能从日志重建，运行时还有 invariant 断言。新增模型可见输入必须新增 session 事件。
- **`assistant/chunk` 保留 token 级回放保真度**，`assistant/message` 是组装后的完整消息（含 usage）。
- **Surface 机制**：只有 `user/message`、`assistant/message`、`tool/result` 三种事件产生模型可见消息，携带 `surfaceOp`（`append` 或 `replace`）与 `sourceEventSeqs`；compaction 通过 replace 节点压缩历史。
- **`request/header`** 把请求信封（call config + adapter 默认值 + 渲染后的 system prompt + tool schemas）也记为日志，使每个请求都是日志的纯函数。
- 事件全部是 lossless JSON，`seq` 连续；不能识别的必读事件类型拒绝重建（`ignorable: true` 才允许跳过）。

### 5.5 持久化：JSONL / SQLite 双后端

`ctx.sessionPersistence` 是持久化接缝，两个后端实现同一契约：

- **JSONL**：每会话一个 transcript 文件（`project/session` 目录内），逐行追加；
- **SQLite**：所有会话共享一个数据库，带 `SCHEMA_VERSION` 与全文搜索（`session-query-sqlite`）。

写入采用批量窗口：`session/event` 是同步通知，持久化插件把事件拷进每会话 controller，首个待写事件启动固定批处理窗口；`session/flush` 是 `parallel` 检查点，loop 在认领下一个普通 turn 前用它做顺序与错误观测。**崩溃恢复**不会截断日志：后端发现孤儿 `turn/start` 时合成 `turn/end { reason: { kind: 'interrupted' } }` 补齐括号，保留全部已持久化事件。会话元数据（format version、cwd、lineage、seed boundary、agentPreset）与事件日志分开存放在 `SessionHeader` 中，不进入模型历史派生。

### 5.6 LLM 接缝与流式协议

`ctx.llm` 是模型适配器注册表。会话词汇统一为 `Message`（role + `ContentBlock[]`），内容块来自可扩展的 `ContentBlockMap`（`text` / `reasoning` / `image` / `tool-call` / `tool-result`）。适配器产出一个**封闭的原始流协议 `StreamChunk`**：

`block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`。

适配器契约要点：

- `usage` 必须在 `finish` 前、`finish` 后不再有东西；
- tool-call `arguments` 全程保持原始 JSON 字符串；
- **一次 adapter 调用 = 一次 provider 尝试**：适配器禁用库级重试，重试由 `agent/request-error` 事件（waterfall）在 agent 层决策，失败后打开新的持久化编号 turn；
- 上下文超限统一映射为规范 code `CONTEXT_WINDOW_EXCEEDED`；
- 每次 provider HTTP 请求带应用归属 `User-Agent`；
- 空完成视为可重试错误 `EMPTY_RESPONSE`，不静默成功。

`BlockAssembler` 是共享的流折叠实现：loop 一边把原始 chunk 落日志，一边喂给 assembler，最终得到 `assistant/message`。

### 5.7 工具注册表与执行管道

`ctx.tools` 持有 `ToolDefinition`（模型可见 `ToolSchema` + `execute` + 可选 `finalizeContent` / UI 回调），作者用 `defineTool` DSL 编写。工具调用走完整管道：

```text
tool/call（先落日志）
  → tools/pre-execute waterfall（hooks、权限、沙箱决策）
  → 注册的单调守卫（deny/abstain）
  → ctx.approval 一次性审批（无回答者则 fail-closed）
  → tools/execute waterfall（超时、重试、指标等 around dispatch）
  → 工具 execute() 本体（tool-fs 的写操作额外过 fs/write-intent 等守卫）
  → 工具自有的 session 事件（todo/write、fs/observed、hook/*）
  → tools/post-execute waterfall（接受/拦截/替换/加上下文）
  → finalizeContent（最后的内容不变量）
  → tools/result（同步冻结通知）→ tool/result（唯一模型可见结果）
```

超长工具结果由 `spill` 接缝转存（本地存 locator + 检索提示），`compaction-tool-result-pruner` 在摘要压缩前用可回放的单节点替换改写超大结果。

### 5.8 Agent 句柄与每-agent 作用域

`ctx.agents` 负责创建/恢复/注册活体 agent：

- `create()` 建全新 session + agent；`resume()` 先加载持久化 session；
- `Agent` 句柄暴露 `send` / `followup` / `steer` / `inject`、`cancel` / `whenIdle` / `runMaintenance`、两个 inbox 边界（`next-turn` / `next-step`）；
- 每-agent 的 `agent.ctx` 提供**作用域注册**：在该 context 上注册的 tool / prompt section / variable / listener 只对该 agent 可见且随 agent 存活；同名的 scoped 注册会 shadow 全局同名注册（每-agent persona 与 tool 变体机制）；
- 作用域实现来自 `scope/` 库：opaque key（默认就是 Agent 对象本身）、`scopeTarget` 构造带 filter 的分发 carrier，`agent/*` 事件按 agent 过滤分发；
- `CreateAgentOptions.setup` 是“setup 窗口”：在 agent 与 session 发布前注册 scoped 世界，注册失败/回滚则整体不发布。

### 5.9 扩展点速查（官方 mapping）

| 目标 | 机制 |
| --- | --- |
| 加模型 provider | 在 `ctx.llm` 注册 adapter |
| 加模型能力 | 注册 `ctx.tools`；schema 自动进 prompt |
| 给某会话不同能力集 | 组合 agent preset；service 行用 `isolate` realm |
| 加 shell / PTY / 后台任务 | `ctx.shell` / `ctx.terminals` / `ctx.jobs` |
| 加文件访问或策略 | `ctx.fs` provider 或监听 `fs/*` 事件 |
| 约束子进程 | `ctx.sandbox` backend；consumer 在 spawn 前包 argv |
| 拦截请求/工具/turn | `agent/*` 或 `tools/*` 事件 |
| 加模型可见上下文 | `agent.inject()` |
| 加 UI/编辑器集成 | 驱动 `ctx.agents`，从 `session/event` 渲染 |
| 加持久化会话状态 | 扩展 `SessionEventMap` |
| fork 活会话 | `ctx.sessions.fork(...)` |
| 注册只对单个 agent | 用该 agent 的 `agent.ctx` |

## 6. Web GUI：Host / Client 两半与 Typert RPC

### 6.1 总体

`dsh web` 是浏览器应用：`packages/host` 是 Host 半边（API 网关 + HTTP 路由服务器 + 前端静态资源），`packages/client` 是浏览器半边（shell 启动、模块加载、RPC 通信、React 渲染、`ui-*` 功能插件），前端本体在 `apps/web`，由 `dsh-web-app` bundle 组装。

- `ctx.webServer`：普通 `node:http` 路由载体（命名路由注册、index transform、静态 dist fallback）；
- `ctx.apiProxy`：与传输无关的 Host 网关面，把浏览器 API 调用分发给 Host 服务，open host stream 主动订阅事件；
- `ctx.clientModules`：从增量 `dsh.client` 扫描组合浏览器插件图；`ctx.hmr` 开发期热重载客户端插件。

### 6.2 Typert RPC（远程调用网关）

业务服务用 `@Remote` / `@RemoteScope` 装饰器声明暴露给 Client 的方法，构建期由 Typert generator 做严格类型分析，生成 Host 反射描述与 Host-for-Client 契约：

- 声明在 `@deepseek-ai/dsh-typert-protocol`；生成在 `@deepseek-ai/dsh-typert-generator`；运行时在 `@deepseek-ai/dsh-typert-registry` + `@deepseek-ai/dsh-api-gateway`；
- 复杂 Host 对象（如 `Agent`、`Session`）不能直接过 wire，通过 `TypertLookupMap` 声明 wire 身份（如 `agentId`），网关在调用前解析回 Host 对象；`@RemoteScope` 先解析作用域 Context 再取服务；
- Client 侧 `ctx.remote.<namespace>` 是具体函数而非 Proxy；调用经 `connection.rpc.call('/api', ...)` 落到 `POST /api/<namespace>/<method>`；
- 参数/返回值经过 codec 严格校验；连接层统一做信任检查与取消；卸载 client contribution 会同时移除方法并中止 in-flight 调用；
- 源码开发模式（tsx）有 SRC fallback：不跑 Typert 编译器，用 `WeakMap` 记录方法名 + 简单参数名解析，仅用于 Host 进程调试，Client 永远使用生成的严格描述符。

## 7. 对外集成面

| 面 | 位置 | 说明 |
| --- | --- | --- |
| CLI | `apps/cli` | `dsh --profile <name>` / `dsh web` / `dsh --profile headless "task"` / `dsh plugin` |
| ACP | `packages/acp` | 仅自动化的 Agent Client Protocol 服务器（JSON-RPC stdio），无 UI |
| TypeScript SDK | `packages/sdk` | 驱动 Harness runtime 的协议 + 客户端 + 服务器（stdio JSON-RPC） |
| Python SDK | `python/` | `deepseek-harness-sdk` 高层 turns API + `deepseek-harness-runtime-bin` 打包运行时 |
| Hooks | `packages/hooks` | Claude Code / Codex hook 桥 + 共享 wire 协议库，作为外部 agent 的 hook 宿主 |
| Subagents | `packages/subagent` | 进程内 spawn/fork、ACP、Codex、Claude Code、dsh-sdk 六类 provider，统一 `ctx.subagents` 接缝 |
| Presets | `packages/preset` | 每会话从 preset `cordis.yml` 组合 agent 能力集 |

## 8. 安全模型

### 8.1 沙箱

`ctx.sandbox` 是进程约束接缝，`ctx.sandboxPolicy` 是策略的唯一归属点（部署默认模式 + workspace root），所有执行族共享同一策略，避免 bash 与 fs 约束到不同 root：

- Linux：bwrap / Landlock；macOS：Seatbelt；Windows：ACL restricted-token runner（`dsh-sandbox-local` 按平台挂载对应后端）；
- `native/` 持有 `landlock-run` 原生源码：自约束后再 exec 的 launcher（Linux Landlock 体系），消费方通过 npm optional dependencies 按平台安装；
- `bash-sandbox` / `fs-sandbox` / `terminal-bash` 消费 `ctx.sandboxPolicy`，fs 写操作与子进程约束同源；
- 模型不可见 `sandbox/mode` 的折叠值是纯函数，tool 层不直接读策略服务。

### 8.2 审批与权限

- `ctx.approval`：一次性权限决策，经 `approval/request` waterfall 分发给回答者（ACP bridge 等），无人应答则 fail-closed 为 `unavailable`；
- `ctx.permissionPresets`：用户可见权限预设表（`workspace-write` / `danger-full-access`），一次切换同时写沙箱模式与审批策略两个 knob；
- `tools` 管道把审批放在单调守卫之前，守卫是“不允许被重排”的 owner 策略；
- `credentials` 采用引用式：配置只带 secret 引用，provider 持有值，每次操作时解析，轮换的凭据下一个请求即生效；Web 网关只暴露无值视图与只写存储。

## 9. 用户数据：Settings / Credentials / Storage

- `ctx.settings`：用户设置接缝 + 文件后端；插件注册 namespace schema，按层解析（entry config 为组合基座，用户层可覆盖）；
- `ctx.credentials`：凭据接缝 + `credentials-local`（环境 > `.env` > `.credentials.yaml`）；
- `ctx.storage`：非会话存储 hub，`storage-json` / `storage-sqlite` 后端并排注册，`storage-domain` 把领域数据形式（domain-first）挂到 hub 上，翻译成不透明 KV 原语；
- `ctx.workspaceRegistry`：`WorkspaceId` 品牌化记录，稳定 sessionIds 驱动 Host RPC 与 GUI 投影；
- `ctx.attachments`：持久化二进制附件身份 + 校验 + 本地 content-addressed 存储，Host 在 session 事件前提交接受的图片，适配器把授权引用解析成 provider 原生内容；
- `ctx.sessionTelemetry`：捕获、脱敏、交给单一后端，输出离开进程；
- `ctx.sessionQuery`：会话检索族（逻辑语料、有界读取、lineage、事件关系、语义过滤、SQLite FTS）。

## 10. 高阶能力插件族

- **Compaction**：`ctx.compaction` 接缝 + `compaction-basic`（压力 + 请求错误恢复驱动），配合 `token-meter`（每会话独立回放折叠）与 `tool-result-pruner`；
- **Goals**：`ctx.goals` 把同一会话目标做成修订式持久状态，`goal-round-driver` 物化 goal round；`blocked` 保留策略码与解释；激活（armed）刻意不进入持久化回放，resume/fork 需要人工授权；
- **Workflow**：`ctx.workflowEngine` 接缝 + worker-thread 引擎 + `tool-workflow` / `tool-ralph`；Ralph 是前台全新 agent 的循环，每次 round 开全新子会话，靠共享 workspace + 有界结构化 handoff 传递状态；
- **Jobs**：`ctx.jobs` 后台任务注册表，`tool-jobs` 模型侧控制器（读/列/杀）；
- **Plan mode**：`ctx.planMode` 从日志折叠 plan/mode 状态，`/plan` 命令直接进入、退出时人工审查；
- **Skills**：`ctx.skills` provider 注册表（badge / filesystem），`tool-skill` 渲染会话前缀目录并加载完整技能体；
- **Presets**：`ctx.agentPresets` 发现可信与用户目录，agent 创建时挂载一份 preset `cordis.yml` 到 agent 作用域，拒绝从未激活的行或发布到根 realm 的行；
- **Hooks / Guard**：Claude Code / Codex hook 桥复用同一 wire 协议；guard 提供重复调用提醒与 `tools/execute` 期限强制执行；
- **Self-modification（extensions）**：`tool-cordis` + `cordis-host-runner`：agent 检查自己运行中的插件树，在 vm 沙箱里加载 host 半身，把模型写的插件 mount/unmount 到自身运行时——“模型负责提出动作，程序负责执行与守住边界”。

## 11. 构建、测试与工程规范

### 11.1 TypeScript 双面构建

仓库刻意维持 **Host / Client 两个独立 ts.Program**（`tsconfig.host.json` / `tsconfig.client.json`），因为两侧都对 `Context` 接口做 declaration merging，合并进一个 program 会冲突：

```sh
tsc -b tsconfig.host.json        # Host 全量
tsdown --env.DSH_BUILD_FACE host # Host 打包，期间运行 Typert generator
tsc -b tsconfig.client.json      # 消费新生成的 Remote 声明
tsdown --env.DSH_BUILD_FACE client
pnpm run build:web               # 前端 dist
```

`api/remotes` 是唯一拆成 Host/Client 双 tsconfig 的包。静态分析与测试通过 tsconfig `paths` 解析到 `src`（源平面），消费构建产物的门禁显式声明对 `lib/` 的依赖（产物平面），两者不混。

### 11.2 测试与质量门禁

- `pnpm run test`：vitest 单元测试；`test:coverage`：CI 覆盖率门禁（`packages/*/*/src` 每文件 100%）；
- `test:e2e`：真实 API 测试，无 `DEEPSEEK_API_KEY` 自动跳过；
- `test:snapshot`：无 key 的 ACP/headless 转录回放，模型/用户可见行为变更必须带快照；
- `typecheck` / `lint` / `duplication` / `build` / `hygiene`（knip + publint + workspace constraints + NodeNext 消费检查）/ `doc-sync` / `website:build`；
- Node 引擎 `^22.19 || >=24`；ESM everywhere（`"type": "module"`），跨包用包名、本地相对导入用 `.ts`；
- 非平凡变更必须同 PR 附带 Agent Note；已归档的 notes 冻结，不再作为现行权威。

### 11.3 文档体系

`docs/` 是双语（中/英）工程文档：架构、能力接缝图、事件生产者/消费者矩阵、工具目录、配置目录、持久化事件目录、cookbook（加包/加工具/加 LLM 适配器/加 Chat node/加 settings card）均为生成+门禁校验；`docs/AGENTS.md` 规定“一个物理行一个段落、每个事实只有一个归属地、词预算”。面向 agent 的规范在根 `AGENTS.md`（`CLAUDE.md` 是它的符号链接）。

## 12. 关键技术决策摘要

1. **没有特权核心**：一切皆插件 + 可逆 effect，扩展点是事件与 service key，而不是改 loop。
2. **事件溯源会话**：模型历史由日志派生（Model-visible ⟺ logged），回放/UI/telemetry 共享一条流。
3. **能力接缝三件套**：Definition / Provider / Consumer，provider 一次替换改变全产品行为。
4. **作用域注册**：每-agent 一个 scoped context，shadow 优先，agent 生命周期即注册生命周期。
5. **类型图生成（Typert）**：Host 声明、构建期生成严格契约、Client 消费具体函数；SRC fallback 只服务于源码调试。
6. **双聚合构建**：Host/Client 两个 ts.Program，declaration merging 互不污染。
7. **配置即组合**：profile/bundle/patch 分层，`!!js` 仅在 config 表达式层，加载失败 fail-loud。
8. **可替换持久化后端**：JSONL/SQLite 共享同一事件词汇，版本不符拒绝打开而非悄悄迁移。
9. **fail-closed 安全**：审批无回答者即拒绝，沙箱策略单一归属，凭据引用按次解析。
10. **快照/转录是行为契约**：模型可见或产品用户可见行为变化必须携带 keyless 快照。

## 13. 建议阅读路径

想上手该工程时，按以下顺序读（都有中文版，除非标注）：

1. 根 `README.zh.md` 与 `AGENTS.md` —— 项目定位与仓库约定；
2. `docs/architecture.zh.md` —— 架构总览与扩展点速查；
3. `docs/cordis-primer.zh.md` —— Cordis 五要素与事件语义；
4. `docs/agent-lifecycle.zh.md` —— turn/step 时序图；
5. `docs/subsystems/core.zh.md`（Agent/loop）、`session.zh.md`（事件词汇）、`tools.md`（工具管道）、`llm-streaming.zh.md`（流协议）—— 六包主干；
6. `docs/capability-seams.zh.md` —— 全部 `ctx.*` 服务图与实现/消费方；
7. `packages/bundle/base/cordis.patch.yml` —— 看一个真实 profile 到底挂载了哪些行；
8. `docs/api-gateway.zh.md` 与 `docs/development.zh.md` —— 若要改 Host/Client 或构建链。

## 附：与本文对应的关键文件索引

| 主题 | 文件 |
| --- | --- |
| 架构总览 | `docs/architecture.md` |
| Cordis 原理 | `docs/cordis-primer.md` |
| 包分层 | `packages/README.md` |
| 能力接缝图 | `docs/capability-seams.md` |
| 事件矩阵 | `docs/event-producer-consumer.md` |
| 模块依赖图 | `docs/module-graph.md` |
| 核心子系统 | `docs/subsystems/core.md`、`session.md`、`system-prompt.md`、`scope.md` |
| LLM 流协议 | `docs/subsystems/llm-streaming.md` |
| 工具管道 | `docs/tool-execution-pipeline.md` |
| 持久化 | `docs/subsystems/persistence.md`、`docs/persistence-catalog.md` |
| API 网关 | `docs/api-gateway.md` |
| 开发与构建 | `docs/development.md` |
| 启动装配 | `packages/boot/app-boot/README.md`、`apps/cli/README.md` |
| 三层 bundle | `packages/bundle/base/README.md`、`web-app/README.md`、`headless/README.md` |
