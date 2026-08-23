# packages 交互与编排层深度研究文档

## 1. packages/interaction — 用户交互协议

五个子包处理模型与用户之间的交互协议。

### 1.1 dsh-user-approval

ApprovalService 维护 pending approval 注册表。

完整审批流：

1. 工具调用触发 tools/pre-execute waterfall
2. ApprovalService 的 listener 检查工具是否需要审批
3. 需要时创建 PendingApproval 含稳定 approvalId
4. 通过 mux 流推送 approval/requested 帧：

       { type: 'approval/requested', sessionId, approvalId, toolName, reason?, callId? }

5. 浏览器端 Session.handleMuxEnvelope mint PendingWait 对象
6. ConversationRoot 的 composer chain selector selectApproval 匹配到 pending interaction
7. ApprovalPanel 接管 composer 渲染 Allow Once Reject 按钮
8. 用户点击后 PendingApproval.answer(outcome) 调用 wait.respond()

   respond 构造 ClientResponse:

       { type: 'client-response', rpcId: 原始帧的rpcId, result: { ok: true, value: { sessionId, approvalId, outcome } } }

9. 宿主 api.respond() 校验 rpcId 匹配和 payload 结构后 resolve pending
10. 通过 mux 流广播 approval/resolved 帧所有 subscriber 收到后清除 pending

浏览器端的 one-shot latch 设计：按钮点击后 disabled 直到 resolved 帧到达才移除 panel。失败 re-arm 允许 retry。

### 1.2 dsh-user-questions

类似的问答协议支持 multiSelect options intent。

question/requested 帧包含 questions 数组每个 question 有 id question options multiSelect intent detail 字段。

浏览器端 QuestionComposer 处理多题分步导航：

- drafts state 数组与 questions 一一对应
- 单选题选择后自动跳转下一题
- 多选题需要手动 Continue
- custom answer 输入替代选项选择
- skip 标记为 answered 但 selected 为空

planReviewOf(questions) 函数判定是否为 plan review 请求：

条件 全部满足才走 plan review surface：
1. 只有一个 question
2. intent.kind === 'plan-review'
3. detail 存在即计划文本
4. 非 multiSelect
5. options 不超过 2 个
6. 有一个 option label 与 intent.approve 匹配

### 1.3 dsh-tool-ask-user

ask_user_question 工具让模型主动提问。工具调用会阻塞直到用户回答或取消。错误码 ASK_CANCELLED 表示用户主动关闭 ASK_ABORTED 表示 turn interrupt 导致中止。

### 1.4 dsh-commands

CommandRegistry 管理 slash command 的注册目录缓存和执行。

命令来源两种：
- host-declared: 插件通过 ctx.commands.register() 注册
- client-contributed: 浏览器端通过 ctx.commandUi.register() 注册 popupSelect UI

执行流程：

1. 用户输入 /name args
2. InputTriggerController adjudicate 匹配到 command source
3. matchEnter 或 menu pick 路由
4. 如果有 leadingInput 则 claim token 进入参数编辑模式
5. 否则 consume token 并 detached execute
6. execute 调用 ctx.remote.commands.execute(sessionId, line)
7. Gateway dispatch 到 host CommandRegistry.execute()
8. 结果 durably 记录为 command/run + command/done 事件对
9. command/done 包含 kind success/error text sourceEventSeq

commands/change 事件通知客户端刷新目录缓存。

### 1.5 dsh-permission-presets

PermissionSelect 投影值由宿主计算并推送包含 currentValue 和 options 数组。

切换通过 /permission <preset> 命令完成两个入口写入同一路径：
- composer 工具行的 PermissionSelect chip
- /permission popup decoration

Full access 需要额外 RiskConfirmation 弹窗要求 acknowledge 后才能确认。

General settings 页面的默认 preset 行独立工作写入 settings namespace 供新 session 使用。

## 2. packages/subagent — 子代理系统

11 个子包构成完整的子代理委派栈。

### 核心服务: dsh-subagent

SubagentService 管理子代理创建生命周期 catalog 维护。

关键概念：

- SubagentAddress: { parentSessionId, childSessionId, mode } 路由到已发现的子会话
- mode: continuable 可继续对话 或 one-shot 只读历史
- delegationDepth: header 中持久化防止无限递归
- SubagentCatalog: parent 会话的子代理目录

catalog 数据结构：

    entries: (ChildEntry | DiagnosticEntry)[]
    ChildEntry: { kind:'child', id, label?, mode, activity, hasChildren }
    DiagnosticEntry: { kind:'diagnostic', id, reason: 'corrupt'|'unsupported'|'unavailable' }

SessionManager 中的 subagent catalog 管理：

- refreshSubagents(parentId): 单飞 RPC subagents.list 获取最新 catalog
- openCatalogs Set 追踪哪些 catalog 正在被 UI 消费
- scheduleCatalogRefresh 50ms debounce 合并连续变更
- catalogStale Set 在 in-flight pull 完成后追加 refresh
- updateCatalogActivity 将 running status 变更折叠到已加载 catalog

### Provider 子包

subagent-fork-in-process: fork 创建子 session 复制父 session 前缀。
subagent-spawn-in-process: spawn 创建全新子 session。
subagent-in-process-driver: 进程内驱动器管理子 Agent 的创建和运行。
subagent-acp: ACP 协议远程子代理。
subagent-claude-code: Claude Code CLI 作为子代理通过 stdio JSON-RPC 通信。
subagent-codex: Codex CLI 类似。
subagent-dsh-sdk: DSH SDK 作为子代理。

### Consumer 工具

tool-subagent: delegate 工具模型发起委派指定目标 prompt 和可选 maxRounds。
tool-subagent-control: list_agents interrupt 工具管理运行中的子代理。
tool-subagent-report: report 工具让子代理向父代理报告结果。

## 3. packages/workflow — 工作流引擎

workflow Service 定义多步骤工作流的执行接口。

workflow-worker-thread 基于 worker_threads 运行工作流避免阻塞主进程。

tool-workflow 注册 workflow_run workflow_stop 工具。工作流产生 durable 的 workflow/* session 事件 Web UI 有专用 WorkflowRunPanel 渲染进度。

tool-ralph Ralph 循环工具迭代改进循环模式。

## 4. packages/goal — 目标管理

GoalService CRUD 操作加状态机 active paused blocked completed。

goal-round-driver 多轮目标驱动逻辑控制 agent 在目标框架下的迭代行为。

command-goal 注册 /goal 命令创建和管理目标。

tool-goal 提供 goal_pause goal_resume goal_clear 等模型工具。

Goal 数据通过 session/projection frame 以 whole value 推送浏览器端 GoalDock 读 useProjection('goal') 渲染。

mutation verbs 走 generated GoalsApi Remote CAS ref 从 projection 快照读取。

## 5. packages/plan — Plan Mode

plan projection key 包含 pending 和 active 两个字段。

effective target 计算 pending ? !active : active 即如果处于 pending 状态则取 active 的反值。

PlanChip 组件在 effective target 为 true 时渲染 Plan 关闭按钮执行 ctx.remote.commands.execute(sessionId, '/plan off')。

进入 plan mode 通过 /plan on 命令或 agent/pre-step waterfall 中的插件逻辑。

## 6. packages/compaction — 上下文压缩

四阶段事件序列：

1. compaction/start: 标记压缩开始含 sourceCommandId 手动触发时
2. compaction/summary: LLM 生成的摘要文本和 shadowedSeqs shadowedTokenCount
3. checkpoint user/message replace surfaceOp: 替换被 shadow 的消息范围
4. compaction/end: 标记压缩完成

checkpoint 是一个 replace-surface user/message 其 source.plugin='compact' source.compactionId 标识事务。

后续 deriveMessages() 从 checkpoint 开始重建上下文 shadowed 部分不再发送给模型但保留在 log 中维持 model-visible 即 logged 不变量。

compaction-basic 实现 LLM 摘要旧消息。compaction-tool-result-pruner 裁剪旧工具结果减少 token 占用。

## 7. packages/guard — 循环卫生

tool-call-timeout-policy 工具调用超时策略通过 tools/guard 或 timeoutMs 实现。

repeat-tool-reminder 当工具被重复调用相同参数时注入提醒消息防止无限循环。通过 agent/pre-step 或 tool post hook 注入。

两者都是通过 Cordis waterfall 实现的 guard 插件注册到全局 layer 对所有 agent 生效。

## 8. packages/jobs — 后台任务

JobsRegistry 按 owner Agent 分区存储任务快照。

JobSnapshot 包含 id kind label status startedAt finishedAt detail。

状态机 running -> stopping -> completed/killed/failed。

onJobsChanged(owner) 回调通知 ApiProxy 推送 session/jobs 帧。owner undefined 时表示 unowned task 所有 subscribed session 都收到更新。

Web UI JobListAction 在 header actions 渲染 popover 列表 live rows 先按 start time 排序然后 settled rows newest first。时钟只在 open 且有 running job 时 tick。

## 9. packages/feedback

message-feedback 消息级 Like Dislike 加 note 存储在 sidecar 表非 session log。

Host 做 per item compare and set 每次 mutation 携带 ifVersion version-conflict 回复携带 authoritative item。

浏览器端 MessageFeedbackController 序列化 mutation 操作 behind operationTail promise 保证排队操作总是比较 against committed version。reconnect 使用 resync 在 queued mutations 之后 re-read list。

## 10. packages/skill — Skill 系统

SkillRegistry 分层合并目录 deployment level providers 注册到 global layer preset local discovery 注册到 scope layer。

skill-filesystem 文件系统发现 provider 扫描指定目录下的 skill 文件。

tool-skill 让模型读取 skill 内容并按指令行动。pre-step boundary 识别 leading /name inject rendered body。

浏览器端 ui-skill 注册 slash trigger source candidates 来自 skill.list RPC 缓存 per session。

## 11. packages/todo

todo_write 工具写入 todo 列表。Todo list 作为 projection key todos 由宿主计算推送。

TodoPanel 在 input dock 上方渲染进度条 done active pending 计数。

## 12. packages/schedule — 定时调度

cron 式定时触发能力可用于自动化任务。

## 13. packages/hooks — 外部 Hook 桥接

hook-protocol 定义通用 hook 协议 hooks-claude-code 和 hooks-codex 桥接外部格式。

允许外部工具在 agent loop 关键节点 pre-step post step 注入自定义逻辑。

## 14. packages/preset — Agent Presets

PresetRegistry 管理命名的 agent 配置文件 cordis.yml 片段。

每个 preset 决定一个 session 的 tools prompt delegation 组合。Preset 在 session 创建时挂载一次运行中的 session 不受后续变更影响。

resolveSessionPreset 从 session log 的 request/header 读取创建时的 preset id 用于 resume 时恢复正确组合。

## 15. packages/workspace — 工作区管理

WorkspaceRegistry 服务管理工作区分组名称 path session 成员排序归档。

数据通过 storage-domain 持久化 domain changed 事件广播 ApiProxy 转发为 host/workspace-* 帧。

workspace-changed 帧携带完整 WorkspaceView 包括 workspaceId title path createdAt sessionIds。

order 变更单独发 host/workspace-order-changed 帧避免每次 reorder 发送全量数据。

archived sessions 单独管理 host/archived-sessions-changed 帧归档的 session 隐藏但 log 保留 unarchive 恢复位置。
