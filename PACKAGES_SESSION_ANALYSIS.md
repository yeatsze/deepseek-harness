# packages/session 与 session-query 深度研究文档

## 1. packages/session（13 个子包）

### 1.1 dsh-session-persistence-sqlite

SQLite 持久化后端。

schema.ts 定义单调递增 SCHEMA_VERSION。load 时校验版本不匹配即拒绝。

存储结构：
- sessions 表：header JSON 一行包含 version id createdAt cwd 等元数据
- events 表：每个 event 一行按 seq 排序 data 为 JSON string
- 使用 WAL 模式提高并发读写性能

session/flush 事件触发时将内存中未持久化的 events batch 写入 SQLite。dispose 时做最终 flush。

append-only 设计意味着更新操作（如 compaction replace）不修改已有行而是追加新行 surface fold 在读取时重建正确的视图。

### 1.2 dsh-session-title / dsh-session-title-all-prompts-llm

会话标题生成投影系统。

session-title 定义投影接口注册 SessionProjectionMap 中的 title key。types.ts 定义 TitleProjection 值类型。

all-prompts-llm 变体用 LLM 从全部用户消息生成标题而非仅第一条。生成结果作为 session/projection frame 推送：

    { type: 'session/projection', sessionId, key: 'title', value: '标题文本', seq }

浏览器端 SessionManager 收到后写入 ProjectionValueStore 列表行无需打开 session 即可显示标题。

normalize.ts 清理 LLM 生成的原始文本去除引号截断长度等。

### 1.3 dsh-session-projection-cache

投影缓存层将宿主计算的 projection values 持久化到 SQLite 避免冷启动时重新计算。

配置项 writeEveryEvents 和 writeIntervalMs 控制写入频率。启动时从 cache 加载已有的 projection values 避免 LLM 标题生成等昂贵操作在每次重启时重新执行。

缓存失效：当检测到 source projection 的 seq 超过 cached seq 时重新计算。

### 1.4 dsh-session-checkpoint-policy

Compaction checkpoint 策略决定何时触发自动压缩。

策略输入包括当前 token 用量消息数上下文窗口大小。当超过阈值时发出 compaction 触发信号。

### 1.5 其他子包概览

| 子包 | 职责 |
|---|---|
| session-persistence | 持久化接口定义 PersistenceService 类型 |
| session-store | SessionStore 服务 创建列出 fork 获取 session |
| session-projection | 投影注册表和 frame 推送逻辑 |
| session-stats | 全量 turn step 计数投影 |
| session-log-export | Web only /export 命令注册 |
| session-reference | 会话引用上下文注入 |
| session-format | 格式常量和升级机制 |

## 2. packages/session-query（4 个子包）

### 2.1 dsh-session-query

全文搜索 Service Definition。

SessionQueryService 接口：

    search(query, opts) → Promise SearchResult

SearchResult:

- items: { sessionId, snippet } 数组
- hasMore: boolean 是否还有更多结果

SESSION_SEARCH_RESULT_LIMIT 是 wire 协议常量所有 transport 共享同一上限。

SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS 控制 snippet 截断使用 Unicode code point 计数防止 surrogate pair 截断。

truncateUnicodeCodePoints(text, max) 工具函数安全截断 UTF-16 字符串不破坏 emoji 等多 code unit 字符。

搜索是 literal phrase 匹配不做正则或模糊搜索——安全且可预测。

### 2.2 dsh-session-query-sqlite

node:sqlite FTS5 实现的搜索 provider。

FTS5 虚拟表索引所有可见 message content。索引构建时机通过 openAt 配置控制：

- startup: 启动时构建索引保证首次搜索即有结果但增加 Node 22 启动开销 node:sqlite import
- first-search: 首次搜索时懒加载 defer node:sqlite import 和 in-memory handle 到第一次搜索调用

Web bundle 默认 openAt: never 配合 in-memory index 不启用磁盘持久化搜索。

### 2.3 dsh-tool-session-query

Consumer 注册 session_search 工具让模型能搜索历史对话内容。

### 2.4 dsh-session-log-export

Web 导出功能分两部分：

Host half（src/index.ts）注册 /export 命令到 commands registry。命令 handler 只验证无参数然后返回 success text "Session log download requested."。

Browser half（src/client/）监听 command/executed 事件：

    ctx.on('command/executed', (sessionId, name, result) => {
      if (name === 'export' && result.kind === 'success') {
        void controller.download(sessionId)
      }
    })

SessionLogDownloadController 流程：

1. 先发 HEAD /api/session.export?sessionId=... includeDescendants=true 探测可用性
2. 如果 HEAD 返回 200 则创建 a 标签设置 download 属性和 href 触发浏览器下载
3. 如果失败显示错误 modal

sessionLogZipFilename(sessionId) 将不可信 sessionId 清理为安全的文件名替换非字母数字下划线短横线字符。

ApiProxy 的 downloads.sessionLog 在宿主端流式生成 ZIP 包含 root session raw artifact 所有 subagent descendant 的 artifact 和所有引用的 image attachments。
