# packages 平台与扩展层深度研究文档

## 1. packages/host — 宿主服务

### 1.1 dsh-host-webserver

node:http 服务器加路由注册升级和 fallback seat。

WebServer Service 构造时立即 listen。三种路由机制：

- register(route): exact 或 prefix 匹配重复 throw
- registerUpgrade(route): exact path HTTP upgrade 重复 throw
- registerFallback(handler): 唯一 fallback seat 第二次 throw

tapIndex(transform): 注册 index.html transform 按 registration order 应用。用于 boot manifest injection。

Service.init 中创建 http.Server 并设置 request handler：

    match(path) -> exact -> prefix -> fallback -> 404

per-request 异常 catch 后返回 400 不让进程 crash。

upgrade handler 查找 upgrades Map 匹配 path 找到则调用 handler 未找到则 destroy socket。upgradedSockets Set 追踪活跃 socket 确保dispose 时全部关闭。

Config 只有 host 127.0.0.1 或 0.0.0.0 和 port 两个字段。port 0 请求 OS assigned。

### 1.2 dsh-host-apiproxy

最大的 host 子包 api-proxy.ts 超过 3600 行实现完整的 ApiProxy 接口。

#### RPC 域

每个域是一个方法集合：

- sessions: list create fork prompt history attachment attachmentUpload updateQueue
- subagents: list prompt history interrupt
- workspace: list create rename delete insertBefore insertSessionBefore archiveSession
- host: describe pickDirectory listDirectory createDirectory openPath
- goals: create edit pause resume complete clear
- skills: list
- agentPresets: list read copy delete openDocument select
- settings: describe mutate
- credentials: describe set unset
- llm: providers models discoverModels
- respond: 处理 approval question 的 client response

#### 事件流

events.mux(request, signal) 返回 AsyncIterable RpcRequest MuxFrame：

1. 创建 FrameQueue 并加入 muxQueues Set
2. 为每个已有 session push session/subscribed 帧
3. 为 pending questions 和 approvals replay 请求帧
4. 为有 pending inbox 的 session push session/queue 帧
5. 为 jobs registry push session/jobs 基线
6. 注册 ctx.on 监听器：
   - session/event: 推送 session/event 帧 附带 viewFor 计算的 render view
   - session/created: push subscribed 帧 加 jobs baseline
   - session/disposed: 清理 openCalls
   - jobs.onJobsChanged: push session/jobs 帧
7. return queue.iterate(signal, cleanup)

events.host(request, signal) 类似但推送全局生命周期帧：

- host/session-added: session/created 时
- host/session-removed: session/disposed 时
- host/session-status: agent/status 变更时
- host/agent-error: agent/error 时
- host/workspace-*: domain/changed workspace 域变更时
- host/remote-event: API_REMOTE_FORWARDED_EVENTS 中的事件原样包装

#### viewFor 函数

在推送 tool/call 和 tool/result 事件时计算 render intent view：

    viewFor(ctx, event, argsFor, scope?):
      try:
        if tool/call:
          view = ctx.tools.get(name, scope)?.presentCall(JSON.parse(raw))
          return view ? { for:'call', view } : undefined
        if tool/result:
          call = argsFor(callId)  // 从 openCalls table 或 backscan
          view = ctx.tools.get(call.name, scope)?.presentResult(call.args, result)
          return view ? { for:'result', view } : undefined
      catch:
        return undefined  // presenter 失败 soft fall 到 no view

openCalls Map 按 session 追踪 open tool calls 用于 result 的 args pairing。turn/end 时清空。stream 打开 mid turn 时 backscanArgs 从 session events 反向扫描。

#### FrameQueue

简单 async queue 核心回调 push AsyncIterable pull：

    push(item): buffer.push waiter 调用
    end(): done = true waiter 调用
    iterate(signal, cleanup): while 循环 yield buffer items 等 waiter abort 时 return

#### 信任栅栏

connection 包的 apply 中实现：

1. 所有 /api/* 请求先过 isTrustedApiRequest(req, trustedHosts)
2. PRIVILEGED_METHODS 额外要求 loopback 即使 trustedHosts 放行也拒绝
3. WebSocket upgrade 同样走信任检查
4. POST 要求 content-type application/json 强制 CORS preflight
5. maxRequestBodyBytes 默认 160MB 容纳 base64 图片

### 1.3 dsh-host-frontend-static

serveStatic(pathname, res, distRoot, distIndex, renderIndex):

1. resolve(normalize(join(distRoot, pathname))) 解析目标路径
2. 检查 target 在 distRoot 内否则 403 traversal rejection
3. target 等于 distRoot 或 distIndex 时 serve index（经过 applyIndexTaps）
4. readFile(target) 成功则返回带 MIME type
5. 失败则 fallback 到 index（SPA routing）

MIME 表覆盖 html js css svg json map webmanifest 其余 octet-stream。

非 GET HEAD 请求返回 405。

### 1.4 目录选择器

四个子包实现 capability seam：

directory-picker Service Definition 定义 pickDirectory listDirectory createDirectory 接口。

directory-picker-native 使用 Win32 dialog worker 线程或 macOS NSOpenPanel。

directory-picker-browse 纯 host side 目录列表由浏览器端渲染 UI。

directory-picker-auto 探测平台能力自动挂载 native 或 browse。

## 2. packages/client — 浏览器端（39 个子包）

详见 WEB_FRONTEND_ANALYSIS.md 按功能分组：

基础设施层 web modules connection runtime web-react ui-slots locale ui-theme schema-form

UI 插件 ui-layout ui-sidebar ui-conversation ui-tool ui-workspace ui-settings 系列 ui-input-trigger ui-commands ui-skill ui-subagent ui-jobs ui-goal ui-plan ui-message-feedback ui-model-selection ui-agent-preset ui-permission-presets ui-deliverables ui-trajectory ui-workflow-run ui-attachment ui-primitives ui-directory-picker 系列

HMR hmr 开发热更新链

## 3. packages/extensions — 动态插件系统

### 3.1 dsh-cordis-host-runner

Host half 接收 define run stop undefine 调用管理插件生命周期。

维护 DynamicCordisInventoryRow 记录每个 Plugin 的 packages activeRun latestRun。

runHostHalf 执行 Host half 代码 harness.handle 注册方法。

invoke 路由 host.call 到正确的 plugin run 的已注册 handler。

### 3.2 dsh-cordis-client-runner

Client half 核心引擎 DynamicCordisPackageRunner：

mount(half) 流程：

1. DynamicCordisStyles(pluginId) 创建 style bookkeeping
2. evaluateClientHalf(pluginId, code, env, styles):
   - new Function('React','console','styles','host','harness',...traps,'process','Buffer', body)
   - closure traps 对 setTimeout setInterval fetch require 抛出 teaching error
   - host 对象的 call 方法路由到 env.invoke
   - harness 是 Proxy get 即 throw 提示 belongs to HOST half
   - taggedConsole 包装 console.error 额外 copy 到 load report
   - 返回值必须是 function 或 { apply } 否则 teaching error
3. guardedSurface(pkg, agentId, plugin, ledger):
   - dynamicCordisContext(ctx, env) 创建 Proxy guard facade
   - CTX_VERBS whitelist effect on provide timer 等
   - TIMER_VERBS 需要 inject timer
   - service access 按 inject declaration gate
   - slots seat 自动分配 shadowing priority 和 claim component identity
   - theme seat pin override source to package id
   - Context return deny
4. modules.invalidate(moduleId) 然后 sink.load({ id, factory })
5. loader.create({ name: moduleId }) 创建 entry
6. fiber.await() 等 activation
7. waitingFor = inject 中 ctx.get 为 undefined 的服务名

teardown(id, entryId, styles):
- live.delete
- loader.remove(entryId) 级联 fiber disposal slot entries facade effects
- modules.invalidate
- styles.dispose 移除 style tags

render failure attribution:
- slots.onEntryError 监听所有 entry crash
- owners WeakMap component -> { pluginId pluginRunId agentId }
- 只有 runner seated 的 component crash 才上报
- renderFailureMessage 附加 redirect 当 message 包含 withheld global 名

### 3.3 dsh-tool-cordis

注册 cordis_define cordis_run cordis_stop cordis_undefine 四个模型工具。

### 3.4 dsh-client-ui-cordis

CordisPanel sidebar footer action 展示 inventory approvals version transitions run controls。

CordisRunCardRegistry per session 的 run card ownership index 只有更大 seq 的成功结果能替换同 key 的 pointer。

## 4. packages/e2b — 云沙箱

fs-e2b 和 subprocess-e2b 提供 E2B 云端沙箱的 provider 实现。e2b 包是共享的 E2B 客户端封装。

## 5. packages/attachment

AttachmentService 定义存储 读取 元数据接口。attachment-local 本地文件系统实现。

图片以 attachmentId 引用存储 Web UI 通过 sessions.attachment RPC 获取 base64 data 和 ImageAttachmentRef。

## 6. packages/storage

StorageService namespace 到 JSON document 的 CRUD。

storage-domain Domain 事件层 domain/changed 事件广播。

storage-json JSON 文件后端每个 namespace 一个文件。

storage-sqlite SQLite 后端。

被 workspace registry settings credentials 复用。

## 7. packages/settings

SettingsService namespace 到 schema validated document。

describe 返回 base user 合并值 schema revision 用于 CAS 写入。

settings-file 每个namespace 一个 YAML JSON 文件。

base 来自部署配置 user 来自用户修改。mutate 带 expectedRevision 做 CAS。

## 8. packages/credentials

CredentialService ref 到 configured writable source 的映射。

凭据字面量永不通过 API 返回只报告是否已配置。

credentials-local 环境变量和 .env 文件后端。

credentials.set 写入 .env 文件 credentials.unset 删除。

## 9. packages/mcp — MCP 客户端

实现 Model Context Protocol 客户端连接外部 MCP server 将其 tools resources 暴露为 DSH 工具。

## 10. packages/lsp — LSP 能力

lsp Service Definition hover diagnostic completion format。

lsp-stdio 基于 stdio 的 LSP server 连接。

tool-lsp lsp 模型工具。

## 11. packages/acp

ACP 自动化服务器通过 SDK JSON RPC 协议暴露 agent 操作供 IDE 和自动化脚本调用。

## 12. packages/test-support

六个测试基础设施包 loader-smoke acp-snapshot client-runtime llm-replay llm-mock-server agent-loop-testkit。

llm-replay 支持无 API key 的 snapshot 测试录制 LLM 响应回放。

## 13. packages/examples

三个可运行示例 agent-spine-demo acp-demo jsonrpc-demo。

## 14. packages/spill — 上下文溢出

三个子包：

- spill: SpillService Definition 定义上下文溢出策略接口
- spill-policy: 溢出策略配置和评估逻辑决定何时以及如何将内容溢出到外部存储
- spill-local: 本地文件系统溢出实现将超出 context window 的历史内容序列化到磁盘

Spill 与 compaction 互补 compaction 用 LLM 摘要替换旧消息而 spill 将原始内容移到外部存储保留完整引用。
