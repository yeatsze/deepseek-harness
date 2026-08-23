# packages 能力层深度研究文档

> 覆盖 llm / shell / fs / web / subprocess / terminal / sandbox / code-runtime 八个能力子文件夹。每个实现一个 capability seam：Service Definition + Service Provider + Consumer 三角。

## 1. packages/llm — LLM 能力层

五个子包构成完整模型调用栈。

### 1.1 dsh-llm — 类型定义与流式 assembler

#### types.ts（377 行）

核心类型体系：

Message 判别联合三种角色：

- UserMessage: content 为 ContentBlock[] source 标记来源 kind
- AssistantMessage: content + provenance (provider model) + usage
- ToolResultMessage: callId 关联 + content + isError 标记

ContentBlock merge extensible union 五种 block：

| type | 字段 | 用途 |
|---|---|---|
| text | text | 可见文本 |
| reasoning | text | 思考过程与文本区分 |
| image | attachment | ImageAttachmentRef 持久化图片引用 |
| tool-call | id name arguments | 模型请求的工具调用 arguments 是 raw JSON string |
| tool-result | toolCallId content isError | 工具执行结果发回模型 |

FinishReasonMap merge extensible stop / tool-calls / max-tokens / aborted / error。

LlmFailure 结构化失败信息：

- message: 人类可读描述
- code: 稳定机器路由代码
- status?: HTTP 状态码
- providerRetryAfterMs?: provider 要求的延迟
- requestId?: provider 请求标识用于诊断

LlmCallConfig 请求配置：

provider / model / system? / messages / tools? / maxTokens? / reasoningEffort? / signal

#### assembler.ts

BlockAssembler 累积 StreamChunk 序列产出最终 AssistantMessage：

- push(chunk) 处理 text-delta reasoning-delta tool-call-delta block-start block-end usage finish
- tool-call-delta 按 index 累积 id name 和 argsRaw 跨 chunk 拼接
- finish 属性返回 { kind:'ok', blocks, usage } 或 { kind:'error'|'aborted', failure }
- blocks() 返回最终 block 数组

StreamChunk union 包括：

text-delta { index text } / reasoning-delta { index text } / tool-call-delta { index id name argumentsDelta } / block-start { index blockType } / block-end { index block } / usage { usage } / finish { finishReason }

#### adapter-failure.ts（104 行）

normalizeLlmFailure(value) 将 adapter 抛出的任意值归一化为 LlmFailure：

1. 非 Error 包装为 HarnessError
2. 尝试读取 own data property failure（不调用 accessor 防止 hostile SDK getter）
3. 如果 carried failure 的 code 与 own code property 匹配则信任并 detach
4. 否则 fallback 到 errorMessage + harnessErrorCode

安全设计：所有属性读取都通过 Object.getOwnPropertyDescriptor 且在 try-catch 中防止 hostile accessor throw。

#### error.ts（163 行）

HarnessError 基类携带稳定 machine routable code 和 chained cause。

errorChain(value) 渲染完整 cause chain 用于 UI 显示：

1. 递归遍历 cause 链用 Set 追踪活跃路径检测循环
2. AggregateError members 方括号内分号连接
3. cause 与当前 message 相同时跳过避免重复噪音
4. hostile coercion 或 throwing accessor 时返回 unrenderable value 不让整个链崩溃

isContextWindowExceededError(detail) 和 isQuotaExceededError(detail) 通过 regex 匹配 provider 错误文案分类错误类型供 retry policy 决定是否可重试。

retry-policy.ts（191 行）定义重试策略评估接口和默认策略。

message.ts（261 行）定义 Message 创建工厂和 source 类型。

### 1.2 dsh-llm-retry

重试策略和历史记录。types.ts 定义 RetryPolicy 接口和 LLMRetryEvent。history.ts 维护 per-step 重试链供 UI 渲染 retry 状态。

### 1.3 dsh-token-meter

从 session log 折叠 tokenUsage 和 contextPressure 两个 projection key。

surface-fold.ts 处理 compaction replace 操作对 token 计数的影响——被 shadow 的消息的 token 计数被扣除替换消息的被加入。

projection.ts 定义 TokenUsageProjection 和 ContextPressureProjection 类型。usage-projection.ts 从 assistant/message 事件的 usage 字段累积。breakdown-projection.ts 计算 system/tools/messages 三部分 token 分布。estimate.ts 提供 client-side 近似估算当无宿主投影值时 fallback。

### 1.4 Adapter 注册

每个 adapter 包通过 ctx.llm.registerAdapter() 注册自己支持的路由。prepareCall(config) 根据 provider/model 匹配 adapter 返回 PreparedLlmCall 包含 config contextWindow adapterDefaults stream 方法。

dsh-llm-deepseek 实现 DeepSeek 官方 API。
dsh-llm-pi-ai 实现通用 OpenAI-compatible API 支持自定义 baseURL。

## 2. packages/shell — Shell 执行能力

九个子包。

### Service Definition: dsh-shell

ShellService 接口：

    exec(request) → Promise ShellResult

ShellRequest:

- command: string 要执行的命令
- cwd?: string 工作目录
- env?: Record string string 环境变量覆盖
- timeoutMs?: number 超时毫秒
- background?: boolean 是否后台运行

request/spec split 是此 seam 的模板 resolve(request): Spec 是显式默认值解析步骤不是 run() 内部的隐藏 default。

render.ts 定义输出渲染函数将 stdout/stderr 转换为 terminal card 格式的 ToolResultView。

### Providers

bash-local: 直接 spawn bash 进程。
bash-sandbox: 在 sandbox-exec 或 namespaces 中运行。
pwsh-local / pwsh-sandbox: PowerShell 对应版本。

每个 provider 实现 ShellService 接口处理进程创建 输出收集 超时终止 信号传递。

### Consumers

tool-bash: 注册 bash 工具含 run_in_background 参数支持。background.ts 处理后台任务注册到 jobs service 并通过 session/jobs 帧推送状态。

tool-pwsh: PowerShell 对应版本。

tool-bash-persistent: 维护持久化 shell 会话跨多个工具调用保持环境变量和工作目录。

shell-env: 环境变量注册服务允许插件贡献 DSH_WEB_URL 等变量到 agent 的 shell 环境。

## 3. packages/fs — 文件系统能力层

七个子包。

### Service Definition: dsh-fs

FsService 接口 read write list mkdir stat 等。types.ts 定义统一的文件操作类型和错误分类。

### fs-local

node:fs 实现。win32.ts 处理 Windows 特有路径逻辑 drive letters UNC paths long path prefix。

fsio.ts 提供底层 I/O 操作封装包括 atomic write（write to temp then rename）。

### fs-sandbox

containment.ts 验证所有文件操作路径都在 session cwd 的 containment root 内。

验证算法：
1. resolve(path) 解析为绝对路径
2. 检查 resolved path 以 containment root 开头
3. Windows 上额外处理 case-insensitive 比较
4. 符号链接通过 realpath 解析后再验证

### fs-observation-policy

决定哪些读操作要记录为 context injection（如 agent 读了某个文件的列表）。types.ts 定义观察策略配置。

### tool-fs Consumer

拆分为独立模块：

read.ts: 文本文件读取带行号截断和编码检测
read-image.ts: 图片文件读取转 base64 attachment
write.ts: 新文件写入含 parent directory 自动创建
edit.ts: str_replace 编辑精确匹配替换
diff.ts: 计算编辑前后差异生成 DiffCardModel
sandbox.ts: 路径校验委托给 fs-sandbox
session-cwd.ts: 从 session header 读取 cwd

每个工具的 presentResult() 返回对应的 ToolCallView 驱动浏览器端原子 renderer。

### tool-fs-search Consumer

search-core.ts 统一搜索调度器根据参数分发到 grep 或 glob。

grep.ts 调用系统 ripguard（rg）二进制执行正则搜索。glob.ts 执行文件名 pattern 匹配。

direct-call.ts 处理直接调用模式非 Code Mode 下的正常路径。

presentation.ts 将原始搜索结果转换为 SearchCardModel 含 grouped matches 或 path list。

### tool-str-replace-editor

独立的字符串替换编辑工具提供更严格的编辑语义要求精确匹配旧字符串。

## 4. packages/web — Web 信息检索能力

六个子包。

### Service Definitions: dsh-web

WebSearchService 接口 search(query, opts) → SearchResults
WebFetchService 接口 fetch(url, opts) → FetchedContent

### Providers

web-fetch-http: HTTP fetch 实现 policy.ts 处理 robots.txt compliance content-type filtering HTML to markdown conversion via turndown。

web-search-deepseek: DeepSeek Search API provider types.ts 定义请求响应 schema。
web-search-exa: Exa AI search provider。
web-search-perplexity: Perplexity search provider。

多个 search provider 可以同时注册 tool-web 在调用时按可用性选择或让用户通过 model selection 指定。

### tool-web Consumer

search.ts 实现 web_search 工具 fetch.ts 实现 web_fetch 工具。两者都声明 card:'web' render intent 使浏览器端渲染 WebBlock citation 卡片。

## 5. packages/subprocess — 子进程

subprocess 定义统一接口 spawn exec execFile 支持 AbortSignal 取消和输出收集。

subprocess-local 基于 node:child_process 实现。被 shell providers LSP stdio transport workflow worker thread 复用。

## 6. packages/terminal — 终端

terminal Service Definition 维护交互式终端会话 create write resize close。

terminal-bash 基于 node-pty 的持久终端 provider。

tool-terminal 提供 terminal_read terminal_write terminal_list 工具。

与 shell 区别： shell 是一次性命令执行 terminal 维持交互式会话 如 vim htop REPL。

## 7. packages/sandbox — 沙箱策略

sandbox-policy 定义 allowed-paths denied-paths network-access 等规则 schema。

sandbox SandboxService Definition 将规则翻译为平台特定机制。

sandbox-local macOS sandbox-exec Linux namespaces 实现。

sandbox-windows-acl Windows ACL-based 实现。

## 8. packages/code-runtime — Code Mode 运行时

code-runtime Service Definition 在安全环境中执行代码的接口。

code-runtime-worker-thread 基于 Node worker_threads 的 provider。worker 内预装 SDK 对象代码通过 SDK.invokeTool(name, args) 调用其他工具。

支持 TypeScript 内联转译 和 Python 如果安装了运行时 两种语言。
