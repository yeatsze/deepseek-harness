# DeepSeek Harness 代码精读学习路线

> 本文是写给 **JS 基础较弱、想借这个工程系统学习 agent 项目** 的你的路线图。配套总览请看 [ENGINEERING_ANALYSIS.md](ENGINEERING_ANALYSIS.md)（那份回答“项目是什么、整体技术方案”，这份回答“我该怎么读代码”）。建议先花半小时读完总览，再按本路线走。

## 0. 学习心态与总策略

先立三条原则，后面所有阶段都围绕它们展开：

1. **目标不是“读完所有代码”，而是“能回答关键问题”**。比如：一次对话从输入到输出经过了哪些环节？为什么模型看到的历史是从日志里“派生”的？加一个工具要动哪几个文件？
2. **三层读法，永远先跑起来、再追主线、最后横向扩展**。不要一上来就逐行读 `agent-loop`，你会被细节淹没。
3. **把“交付物”当完成标准**。每个阶段结束时你都要交出一个东西（流程图、解剖表、小插件、日志翻译）。做不出来，说明还没读完。

针对你“不懂 JS”的情况，有三个特别有效的策略：

- **类型当说明书**：这个仓库的源码里到处是 TypeScript 类型和 JSDoc 注释。接口（`interface`）和类型声明本身就是“这个函数要什么、给什么”的说明书。先读类型，再读实现，很多实现可以不读。
- **事件当地图**：插件之间靠事件通信。找到事件声明（如 `SessionEventMap`、`agent/*`），再用 `docs/event-producer-consumer.md` 查“谁发出、谁监听”，整个系统的骨架就出来了。
- **测试当示例**：每个包都有 `tests/` 目录。测试就是“某个行为应该怎样”的最直白例子，比读实现更快建立直觉。

时间预期（每周 5–8 小时）：约 3–5 周走完前四个阶段，第五阶段是加分项。

## 1. 前置准备：先补最小 JS/TS 知识（第 0 周）

不需要系统学完 JavaScript。只需要“能看懂”下面这些概念，每一项我都给你仓库里的活例子：

| 概念 | 一句话解释 | 仓库里的最小例子 |
| --- | --- | --- |
| 变量 / 函数 / 对象 / 数组 | 语言基础 | 任意 `src/index.ts` 开头 |
| `async` / `await` / Promise | 处理“等网络、等进程”的异步写法；agent 系统几乎全是异步 | `packages/core/agent-loop/src/agent.ts` 里所有 `await` |
| ES Module（`import`/`export`） | 模块互相引用的标准写法；本仓库全部用 ESM | 任意文件顶部的 `import` |
| 类型注解与 `interface` | 给变量/对象声明“形状” | `packages/llm/llm/src/types.ts` |
| 判别联合（discriminated union） | 一个字段的值决定整个对象结构；配合 `switch` 收窄类型 | `packages/core/session/src/types.ts` 里的 `SessionEvent` |
| 泛型（简单了解） | 给“容器类”类型加参数，如 `Map<K, V>` | `packages/core/scope/src/index.ts` 的 `ScopedLayers<L>` |
| **declaration merging** | 同一名字的接口可以跨文件合并；这是“插件给核心加新事件类型”的机制，**必须懂** | `packages/core/session/src/types.ts` 的 `SessionEventMap`，以及各插件里的 `declare module '@deepseek-ai/dsh-session'` |

建议做法：找一门 2–3 小时的 TS 速成课（只看前 60%），然后直接回到这个仓库，边看边查。遇到不认识的关键词，先跳过去，能读懂主干再回头补。

**本阶段交付物**：一个你写的 10 行左右的 `.ts` 文件，包含一个 `interface`、一个 `async function`、一个 `switch`。不要求跑起来，写在任何地方都行。

## 2. 阶段 0：先跑起来，见一个真 agent（第 1 周）

### 目标

亲眼看到一个 agent 跑一次完整对话，知道进程从哪进、从哪出。

### 步骤

```sh
pnpm install        # 安装依赖（首次较慢）
pnpm run build      # 编译；第一次也可以只跑 pnpm run typecheck
```

有 DeepSeek API key 时，跑一次一次性任务：

```sh
pnpm dsh --profile headless "用一句话介绍你自己"
```

没有 key 也没关系：

```sh
pnpm dsh web        # 启动 Web UI，浏览器打开 http://127.0.0.1:3080
```

跑完以后，回答三个问题（写下来）：

1. headless 模式启动后，进程做完了什么事才退出？
2. 你在 Web UI 里发一条消息，界面上发生了什么变化？
3. 猜一猜：这条消息从“发出去”到“显示回答”，中间经过了哪几层？

**本阶段交付物**：上面三个问题的答案，加一句“我观察到 agent 的输入输出长什么样”。

## 3. 阶段 1：追一条主线——一次对话怎么发生（第 1–2 周）

这是最核心的阶段。按下面顺序读，**每个文件先读类型和 JSDoc，再读实现**，实现读不懂就跳，别恋战：

| 顺序 | 文件 | 读什么 |
| --- | --- | --- |
| 1 | `apps/cli/src/args.ts` 与 `src/bin.ts` | 命令行入口：参数怎么解析、怎么选择 profile |
| 2 | `packages/bundle/headless/cordis.patch.yml` | 看一个真实装配：启动时到底挂载了哪些插件行 |
| 3 | `packages/examples/agent-spine-demo/README.md` | 最小可运行组合（agent-spine）由哪些包组成 |
| 4 | `packages/core/session/src/types.ts` | 事件词汇表：一次对话会写哪些日志事件 |
| 5 | `packages/core/agent-loop/src/agent.ts` | **主循环**：认领输入 → 组装请求 → 调模型 → 执行工具 → 写日志 |
| 6 | `packages/core/tools/src/index.ts` | 工具注册表：工具怎么被登记、怎么被调用 |
| 7 | `packages/llm/llm/src/types.ts` | 消息与流式协议：模型返回的 token 流长什么样 |

读的时候，手里一定要放着 `docs/agent-lifecycle.md` 的时序图对照。图里出现的每个名词（turn、step、`agent/pre-step`、`llm/stream`）都要能在代码里找到出处。

**练习（交付物）**：画一张你自己的“一次对话流程图”。要求：

- 标出 turn 和 step 的边界；
- 每个环节标注是“持久化事件”（写进日志的）还是“实时事件”（只存在于内存协调的）；
- 标出至少三个 waterfall 事件，并写出它们的顺序。

**反思问题**：

- 为什么“模型历史”不单独存一份，而是每次从日志派生？这样做的代价和好处分别是什么？
- `agent/pre-step` 是 waterfall，它可以“拒绝”一次 step；如果换成一个普通 `emit` 事件，系统会失去什么能力？
- 工具执行前后有 `pre-execute` 和 `post-execute` 两道瀑布，它们各自能用来做什么（各举一个例子）？

## 4. 阶段 2：理解“一切皆插件”（第 2–3 周）

这一阶段的目标是：**看懂一个插件是怎么“长”在系统上的**。

### 4.1 先在代码里找到 Cordis 五要素

回到 `docs/cordis-primer.zh.md` 的五个概念，然后去代码里找它们各自的“实体”：

| 概念 | 去哪个文件找 |
| --- | --- |
| context（`ctx`） | 任意插件 `src/index.ts` 的 `apply(ctx)` / `Service` 构造参数 |
| service key | `ctx.tools`、`ctx.llm`、`ctx.sessions` 等；全量见 `docs/capability-seams.md` 的表格 |
| inject 依赖声明 | 插件 `package.json` 或源码里的 `inject` 数组 |
| 事件分发 | `docs/cordis-primer.zh.md` 的四种模式；代码里搜 `ctx.on` / `ctx.waterfall` |
| 可逆 effect | 代码里搜 `ctx.effect()`，观察返回值怎么被当作“卸载函数” |

### 4.2 精读三个“小而完整”的插件（由浅入深）

1. **`packages/todo/tool-todo`**：最简单的模型侧工具。看它如何注册 `todo_write` 工具、如何定义 schema、如何执行。
2. **`packages/context/time-context`**：最简单的“监听者”插件。它监听 `agent/pre-step`，在合适的 step 往请求历史里注入带来源标注的当前时间（一条 `user/message`），然后调用 `next()` 继续。这是理解 waterfall 的绝佳样本。
3. **`packages/interaction/commands`**：稍微复杂一点。它有类型定义、服务注册、事件（`commands/change`），能让你看到“插件不只能加工具，还能加人类命令”。

### 4.3 插件解剖表

每读完一个插件，填一张表（写进你自己的笔记）：

```text
插件名：
注入的服务：            （它依赖 ctx 上的哪些 key）
注册的东西：            （工具？prompt section？事件监听？）
监听/发出的事件：
它如何被“卸载”：        （disposer 做了什么）
模型能看到什么：        （如果有 README，看它的 Model Experience 段落）
```

**练习（交付物）**：写一个你自己的最小插件——一个 `echo` 工具：模型调用 `echo` 时原样返回你传入的文字。实现路径参考：

1. 复制 `packages/todo/tool-todo` 的结构，改包名为你自己的；
2. 在 `dsh-base` 的 `cordis.patch.yml`（或你自己的 profile）里加一行挂载它；
3. 跑 `pnpm dsh --profile headless "用 echo 工具说 hi"` 验证。

如果卡住，优先问自己：**它注册到哪个 `ctx` 服务上？** 答案通常是 `ctx.tools`。

**反思问题**：

- 为什么“注册”都要返回一个 disposer？如果忘记返回，会出什么问题？
- waterfall 监听者不调用 `next()` 会发生什么？什么场景下这是“设计意图”？
- 同一个工具名，在 agent A 可见、在 agent B 不可见，是靠什么机制实现的？（提示：去 `packages/core/scope` 找答案）

## 5. 阶段 3：深入核心机制（第 3–4 周）

这一阶段挑三块最值得精读的机制，每块读 1–2 天。

### 5.1 事件溯源（session）

读 `packages/core/session/src/` 下这三个文件，按顺序：

1. `types.ts`：事件词汇与 `SessionEvent` 结构；
2. `surface.ts`：`append` / `replace` 表面操作——为什么压缩（compaction）可以“替换”历史而不破坏日志；
3. `index.ts`：store 的公开 API，重点看 `append` 与 `flush`。

读完回答：`assistant/chunk` 和 `assistant/message` 为什么都要存？丢掉 chunk 会损失什么能力？

### 5.2 工具执行管道

对照 `docs/tool-execution-pipeline.md` 的流程图，读 `packages/core/tools/src/index.ts` 里与 `pre-execute`、`execute`、`post-execute`、guard、approval 对应的代码段。

读完回答：审批（approval）放在 guard 之前还是之后？为什么这个顺序不能随便换？

### 5.3 scope：为什么每个 agent 有自己的小世界

读 `packages/core/scope/src/index.ts`（这是一个零依赖的小库，只有几百行，适合精读）。

读完回答：

- `ScopeKey` 为什么用“对象身份”比较，而不是字符串？
- 如果 scope 层是“懒创建”的，什么时候一个 agent 的 scope 层会被回收？
- 一个工具同时被全局注册和某个 agent scoped 注册，该 agent 看到的是哪个？

**练习（交付物）**：把一次真实对话的 JSONL 日志翻译成人话。操作：

1. 跑一次 headless 任务，找到会话目录下的 `.jsonl` 文件（路径见 `docs/subsystems/persistence.md` 或运行日志）；
2. 按 `seq` 顺序逐条标出：`turn/start`、`user/message`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`、`turn/end`；
3. 写一段 300 字以内的“这次对话发生了什么”的叙述。

**反思问题**：

- 日志里有一个 `turn/start` 却没有对应的 `turn/end`，可能发生了什么？（提示：崩溃恢复）
- 为什么 `request/header` 也要写进日志？如果只有最终消息没有请求头，回放时会缺什么信息？

## 6. 阶段 4：选一个能力接缝深挖（第 4–5 周，三选一）

能力接缝是“Definition / Provider / Consumer”三件套。选一个你最感兴趣的深挖，另外两个之后可以快速扫。

| 选项 | Service Definition | 一个 Provider | Consumer |
| --- | --- | --- | --- |
| Shell（推荐，最标准） | `packages/shell/shell/src/index.ts` | `packages/shell/bash-local/src` | `packages/shell/tool-bash/src` |
| Subagent | `packages/subagent/subagent/src/index.ts` | `packages/subagent/subagent-spawn-in-process/src` | `packages/subagent/tool-subagent/src` |
| Web | `packages/web/web/src/index.ts` | `packages/web/web-fetch-http/src` | `packages/web/tool-web/src` |

**练习（交付物）**：画一张三件套关系图，并回答：

- Provider 换了（比如 bash-local 换成远程沙箱），Consumer 的代码要改吗？
- 为什么 Consumer 要依赖 Definition 而不是直接依赖某个 Provider？
- 这个接缝的“模型可见部分”（tool schema）在哪个包？

**反思问题**：

- 如果让你给这个接缝加一个 Provider（比如把 shell 换成云端执行），最少要动几个文件？
- 什么情况下你会觉得“这个能力不该是接缝，直接一个类就够了”？

## 7. 阶段 5（可选加分）：Web GUI 与外部接口

如果你最终想“给别人用”或“接入别的产品”，再读这层：

- Host/Client 两半：`packages/host/README.md` 与 `packages/client/README.md`；
- Typert RPC：`docs/api-gateway.zh.md`，看 `@Remote` 装饰器怎么把 Host 方法变成 Client 可调用函数；
- 外部协议：`packages/sdk/README.md`（TS SDK）、`python/README.md`（Python SDK）、`packages/acp/README.md`（ACP）、`packages/hooks/README.md`（Claude Code / Codex hook 桥）。

这一层不要求全部读懂，先能回答“Web 前端和 Host 之间用了几种通信方式”即可。

## 8. 非 JS 背景的阅读工具箱

### 8.1 常用招式

- **用 `rg` 搜符号**：想找 `agent/pre-step` 是谁发出的，`rg "agent/pre-step" packages/core` 立刻定位。比在编辑器里翻快得多。
- **先读“生成目录”反查**：`docs/config-catalog.md`（配置字段）、`docs/tool-catalog.md`（所有工具）、`docs/persistence-catalog.md`（所有日志事件）都是生成的权威索引。遇到“这是哪来的”，先查目录。
- **用事件矩阵当地图**：`docs/event-producer-consumer.md` 列出每个事件的声明位置、发出者、监听者，是“系统谁跟谁说话”的完整答案。
- **测试当说明书**：一个函数看不懂，去它旁边的 `tests/` 找它名字，测试输入输出就是行为的定义。
- **README 的 Model Experience 段落**：每个产品包 README 都写“模型会看到什么”，这是从模型视角理解插件职责的最快入口。

### 8.2 新手常见坑（这个仓库尤其容易踩）

| 坑 | 说明 |
| --- | --- |
| 把 ESM 当 CJS | 仓库强制 ESM（`"type": "module"`），没有 `require`；源码里看到 `import` 是常态 |
| 以为事件都是“发了就等结果” | 只有 `parallel`/`serial` 是等待的；`emit` 是发完即走，`waterfall` 靠 `next()` 链式传值 |
| 混淆两类事件 | `session/event` 是**持久化事实**（日志）；`agent/*` 是**实时协调**（内存）。改模型可见内容只能走日志那类 |
| 手改“Generated”文件 | `docs/` 里标着 `Generated by scripts/...` 的文件、各包生成的 `lib/` 产物都不能手改，要改生成器或源码 |
| 被双 tsconfig 吓到 | Host 和 Client 是故意分开编译的两个 TypeScript 工程，因为两侧都要扩展同一个 `Context` 接口；这是 declaration merging 的“副作用”，不是 bug |
| 在 `src` 里找包名 | 包之间互相引用用 npm 包名（`@deepseek-ai/dsh-*`），同包内用相对路径（`.ts` 后缀）；仓库 tsconfig `paths` 会把包名映射回 `src` |

## 9. 术语小词典（新手向）

| 术语 | 中文解释 |
| --- | --- |
| plugin / 插件 | 一段可独立挂载/卸载的代码，往系统里“注册”能力 |
| context / 上下文 | 插件的“插座板”，所有服务都挂在 `ctx.<名字>` 上 |
| service | 挂在 `ctx` 上的一个服务对象，其他插件按 key 找它 |
| inject | 声明“我需要哪些服务”，框架据此决定加载顺序 |
| effect | 一次可逆的注册；返回的 disposer 就是“撤销按钮” |
| emit / waterfall / parallel / serial | 四种事件模式：通知 / 链式改写 / 并行 / 串行 |
| seam / 能力接缝 | 一个可替换能力的三件套（接口 + 实现 + 消费者） |
| provider | 接缝里的具体实现，如本地 Bash、远程沙箱 |
| consumer | 接缝的消费方，通常是模型工具 |
| session | 一次对话的持久化记录，本质是追加式日志 |
| turn / step | turn 是一轮对话（多个 step），step 是一次“模型请求 + 它引发的工具调用” |
| inbox | agent 的待办输入队列，分“下一轮”和“下一步”两个边界 |
| scope | “只对某个 agent 可见”的注册范围 |
| preset | 预定义的一个 agent 能力组合（一堆插件行的集合） |
| profile / bundle | 配置档（组合方案）和发行包（配置+代码） |
| patch | 按条目 id 覆盖配置的一层修改 |
| adapter | 适配器，把统一接口翻译成具体 provider 的协议 |
| HMR | 热重载：改配置/代码后不用重启进程 |

## 10. 每周复盘模板

建议每周结束时回答这四个问题，答案追加到你自己的一份 `学习复盘.md`：

```text
本周我读完了哪些文件？（列路径）
我搞懂了哪 1 个概念？用我自己的话写一遍。
我卡在哪 1 个地方？当时怎么处理的？
下周我要完成哪 1 个交付物？
```

**反思问题（贯穿全程）**：

- 如果我只能向别人解释这个系统的 3 个设计决策，我会选哪 3 个，为什么？
- 这个项目和我用过的其他 agent 产品（如 Claude Code、Codex）相比，架构上的最大不同是什么？
- 如果我要基于它做一个自己的 agent 应用，第一版我会替换/新增哪两个插件？

## 附：完整文件路线清单

| 阶段 | 文件 | 目的 |
| --- | --- | --- |
| 前置 | `docs/cordis-primer.zh.md` | 理解插件框架五要素 |
| 阶段 0 | `README.zh.md`、`apps/cli/README.md` | 知道怎么跑 |
| 阶段 1 | `docs/agent-lifecycle.zh.md`、`packages/bundle/headless/cordis.patch.yml`、`packages/examples/agent-spine-demo/README.md`、`packages/core/session/src/types.ts`、`packages/core/agent-loop/src/agent.ts`、`packages/core/tools/src/index.ts`、`packages/llm/llm/src/types.ts` | 追一条完整主线 |
| 阶段 2 | `packages/todo/tool-todo/src/index.ts`、`packages/context/time-context/src/index.ts`、`packages/interaction/commands/src/index.ts`、`packages/core/scope/src/index.ts` | 理解插件与作用域 |
| 阶段 3 | `packages/core/session/src/{types,surface,index}.ts`、`docs/tool-execution-pipeline.md`、`packages/core/tools/src/index.ts` | 深入事件溯源与工具管道 |
| 阶段 4 | `docs/capability-seams.zh.md` + 三选一接缝包 | 看懂一个完整能力 |
| 阶段 5 | `docs/api-gateway.zh.md`、`packages/sdk/README.md`、`packages/acp/README.md`、`packages/hooks/README.md` | 外部接口（可选） |

祝你读得愉快——读完阶段 1 和 2，你就已经超过绝大多数只看文档不读代码的人了。
