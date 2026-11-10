# dsh-cloud-memory 使用说明

> 适用包名：`dsh-cloud-memory`  
> 适用宿主：DeepSeek Harness（DSH）  
> 本文面向使用者；架构与接口细节见 [`../README.md`](../README.md)，发布流程见仓库根目录的 `PUBLISHING.md`。

---

## 1. 它是什么

`dsh-cloud-memory` 是 DSH 的跨会话记忆插件：

- Agent 可保存稳定事实、偏好、决策；
- 回答前做 **语义 + 关键字 + RRF** 混合召回；
- 左侧栏提供 **Memory / 记忆** 页面：搜索、手动保存、编辑、删除、缓存指标；
- 三层缓存降低重复向量计算和检索延迟；
- 支持 TEI / OpenAI-compatible embedding 端点；未配置时使用本地词法哈希兜底。

---

## 2. 快速开始

### 2.1 安装

在 DSH 的 Plugin Manager 中安装本地路径、Git 仓库或解压后的 bundle：

```text
target: <path-to>/dsh-memory
```

安装后确认：

- Settings → Plugins 中 `Cloud memory` 已启用；
- 左侧栏底部出现 **Memory / 记忆** 图标；
- Agent 工具列表出现 `memory_search`、`memory_write`、`memory_manage`。

如果页面没有图标：刷新一次 Web GUI，再检查插件是否 active。

### 2.2 打开页面

点击左侧栏 **Memory / 记忆**：

- **记忆** 标签：搜索、保存、编辑、删除；
- **缓存与状态** 标签：L1/L2/L3 命中率、条目、延迟、向量化调用、健康状态。

### 2.3 接入真实 BGE-M3（推荐）

仓库中的 `embedding-service/` 提供一个本地 BGE-M3 端点：

```powershell
cd embedding-service
npm install --ignore-scripts --registry=https://registry.npmmirror.com
node prepare-sharp.mjs
node download-model.mjs
node server.mjs
```

模型约 570MB，已下载时直接 `node server.mjs` 即可（加载约 3–5 秒）。验证：

```powershell
curl.exe http://127.0.0.1:8090/health
```

在 profile 的 `cordis.patch.yml` 中配置：

```yaml
- id: dsh-memory
  config:
    embedding:
      provider: tei
      baseUrl: http://127.0.0.1:8090
      model: BAAI/bge-m3
      dim: 1024
      timeoutMs: 120000
      fallbackToLocal: false
    retrieval:
      channelTimeoutMs: 120000
```

`examples/bge-m3.profile-patch.yml` 有同样示例。

不配置端点时默认使用本地哈希向量（`provider: auto` + 无 `baseUrl`），语义能力会降级为词面相似。

### 2.4 直接对话

- “记住：我偏好 Python 3.11 + FastAPI，部署在 Kubernetes。”
- “我之前说过后端技术栈是什么？”
- “列出我关于项目复盘的记忆。”
- “忘掉旧部署环境那条记忆。”

Agent 会调用工具；你也可以在页面手动保存。

---

## 3. Web 页面

### 3.1 搜索

- 输入自然语言，例如“我之前用什么框架写服务？”；
- 范围：
  - 全部会话（默认）；
  - 共享记忆（当前实现等同全部会话）；
  - 当前会话（需填写会话 ID）；
- 结果数：5 / 10 / 20；
- 卡片显示内容、会话、来源、版本、时间、命中通道（semantic / keyword / both）、融合分和子分数；
- 缓存命中时显示 `cache hit` 与 `l1/l2/l3`。

### 3.2 保存

1. 写一条 **自包含** 的事实；
2. 可选关键字，逗号分隔；
3. 点击保存。

服务端会归一化、PII 脱敏、去重、抽关键字、向量化，然后写入并递增 `index_version`。

### 3.3 编辑/删除

- 编辑带 `version` 乐观锁，冲突时刷新重试；
- 删除默认软删，检索立即不可见；
- 硬删需要 `security.allowHardDelete: true`，通过 Agent 工具执行；
- 页面不提供硬删。

### 3.4 缓存与状态

展示 L1/L2/L3 条目、命中率、命中/未命中 p95、embedding 调用、LRU/TTL 淘汰、端点状态、索引版本和运行时长。

按钮：

- **清空检索缓存**：清 `m:s:`/`m:n:`，保留 `m:e:` 向量缓存；
- **重试待向量化**：把 `embed_status != ok` 的记忆重新向量化。

---

## 4. Agent 工具

### 4.1 `memory_search`

| 参数 | 说明 |
| --- | --- |
| `query` | 必填，自然语言；支持 `AND`/`OR`/`NOT` 和 `"短语"` |
| `topk` | 1–20，默认 8 |
| `scope` | `user`（默认）/ `session` / `global` |
| `session_id` | `scope=session` 时必填 |
| `min_score` | 语义相似度下限 0–1 |
| `filters` | `session_ids` / `sources` / `time_range` |

### 4.2 `memory_write`

| 参数 | 说明 |
| --- | --- |
| `content` | 必填，≤8000 字符 |
| `session_id` | 默认当前会话 |
| `keywords` | ≤20 个，每个 ≤32 字符 |
| `source` | 默认 `chat` |
| `ttl_seconds` | 60–31536000，缺省永久 |
| `need_embedding` | 默认 true |
| `need_keywords` | 默认 true |

### 4.3 `memory_manage`

| action | 用途 |
| --- | --- |
| `list` | 游标分页；可带 `session_id`、`limit`、`cursor` |
| `get` | 读取单条 |
| `update` | 更新 `content` / `keywords` / `extra` / `ttl_seconds`；可带 `version` |
| `delete` | 软删；`hard=true` 需配置允许 |
| `stats` | 缓存命中率、条目、延迟、embedding 状态 |
| `purge_cache` | 清检索缓存，`level=all/l1/l2/l3` |
| `reembed` | 重试 pending/failed；`force=true` 全量重算 |

切换 embedding 模型后必须：

```text
memory_manage action="reembed" force=true
```

---

## 5. 配置

配置入口是当前 profile 的 `cordis.patch.yml`，row id 为 `dsh-memory`。插件不导出 Config schema，因此没有表单，配置走 YAML。

```yaml
- id: dsh-memory
  config:
    userId: local
    embedding:
      provider: auto          # auto | local | tei | openai
      api: tei
      baseUrl: ""             # 配了才走远端
      model: BAAI/bge-m3
      dim: 1024
      timeoutMs: 120000
      apiKeyEnv: BGE_M3_API_KEY
      fallbackToLocal: true
    retrieval:
      rrfK: 60
      wSemantic: 0.6
      wKeyword: 0.4
      candidateMultiplier: 3
      channelTimeoutMs: 120000
      defaultTopK: 8
    cache:
      ttlSearch: 300
      ttlEmbedding: 604800
      ttlNegative: 30
      ttlJitterRatio: 0.1
      l1MaxEntries: 2000
      l2MaxEntries: 20000
      l2MaxBytes: 67108864
      l2Path: ""
      l3Url: ""
      singleflightTimeoutMs: 250
    security:
      piiMask: true
      allowHardDelete: false
    prompt:
      enabled: true
      text: ""
```

常用调整：

| 目标 | 调整 |
| --- | --- |
| 纯离线 | `embedding.provider: local` |
| TEI/vLLM | `provider: tei`，`baseUrl: http://host:port` |
| OpenAI-compatible | `provider: openai`，`api: openai`，`baseUrl: .../v1` |
| 语义权重更高 | `wSemantic: 0.8`，`wKeyword: 0.2` |
| CPU 端点慢 | `timeoutMs` / `channelTimeoutMs` 调到 60000–120000 |
| 启用 L3 | `cache.l3Url: redis://127.0.0.1:6379/0` |
| 允许硬删 | `security.allowHardDelete: true` |

---

## 6. 端点不可用时

- 检索：语义通道失败，`degraded: semantic: fetch failed`，只返回关键字结果；
- 写入：成功，但 `embed_status=pending`，不会写入不同向量空间的向量；
- 已有 BGE-M3 向量保留；
- 降级结果不写入 300s 检索缓存；
- 端点恢复后执行 `memory_manage action="reembed"` 补算 pending。

默认 `fallbackToLocal: false` 用于真实模型，避免 local hash 与 BGE-M3 混算。若希望纯离线，直接 `provider: local`。

---

## 7. 数据与缓存

| 内容 | 路径 |
| --- | --- |
| 记忆 | `$DSH_HOME/storages/dsh_memory/memories/` |
| 版本 | `$DSH_HOME/storages/dsh_memory/versions/` |
| 幂等键 | `$DSH_HOME/storages/dsh_memory/idempotency/` |
| 审计 | `$DSH_HOME/storages/dsh_memory/audit/` |
| L2 缓存 | `$DSH_HOME/storages/dsh-memory/l2-cache.json` |
| 模型（可选） | `embedding-service/.cache/Xenova/bge-m3/` |

- 备份：停止 DSH 后复制 `$DSH_HOME/storages/dsh_memory/`；
- 软删保留文件；硬删物理删除；
- `ttl_seconds` 到期后由每小时清理任务软删；
- L2 缓存可丢弃，不影响记忆数据。

---

## 8. 测试

工作区根目录或插件目录：

```powershell
npm test
```

离线测试不需要 embedding 端点，当前为 7 组：

| 测试 | 内容 |
| --- | --- |
| smoke | 写入/脱敏/去重/检索/缓存/更新/批量/删除/force reembed/来源隔离 |
| http | Fetch REST + 幂等键 |
| node-http | WebServer Node handler 的 POST/PUT/DELETE |
| edge | 远端降级、原子批量、过滤、乐观锁、min_score |
| cache | L2 持久化、版本并发、purge 保留向量缓存 |
| redis | L3 RESP（mock server） |
| chunk | 70 条文本按 32 条分片 embedding |

真实语义质量：

```powershell
cd dsh-memory
npm run test:semantic
```

需要先启动 `embedding-service`。基准结果见 [`../README.md`](../README.md)。

---

## 9. 常见问题

**页面无 Memory 图标**：刷新；确认插件 active；检查 `sidebar.panellist` 注册。

**`degraded: semantic: fetch failed`**：端点未启动；`cd embedding-service && node server.mjs`。

**记忆 pending**：端点停止期间写入；恢复后 `memory_manage action="reembed"`。

**409/40901 version mismatch**：编辑版本过期；刷新后用新 `version` 重试。

**409/40902 Idempotency-Key**：同键不同请求体；换 key 或复用相同 body。

**422/42201 content is empty after masking**：正文只有 PII；补充上下文。

**403/40302 hard delete**：默认关闭；配置允许或用软删。

**8090 被占用**：`$env:EMBEDDING_PORT=8091; node server.mjs`，同步改 `baseUrl`。

**`sharp` 安装错误**：`npm install --ignore-scripts` 后 `node prepare-sharp.mjs`。

**L3 未连接**：检查 `cache.l3Url`、Redis 可达性；TLS 用 `rediss://`。

**第一次搜索慢**：模型冷启动；后续命中缓存或热模型会快。

---

## 10. 安全与边界

- PII 在向量化前脱敏；仍不要保存密码或完整密钥；
- HTTP API 仅本机、校验 Origin 和 JSON Content-Type；
- 无 AES 列加密，依赖磁盘加密；
- 单用户 `userId` 隔离，不是多租户 SaaS；
- 无跨设备同步；
- 不扫描 Session 事件日志，自动写入靠系统提示/手动保存；
- 未实现同义词扩展；
- 页面实际视觉效果需在 Web GUI 中确认。

---

## 11. 卸载

- Settings → Plugins 关闭/移除 bundle；
- 或 Agent 执行 `plugin_manager remove_bundle target="dsh-cloud-memory"`；
- 停止端点：`Ctrl+C`；
- 卸载不会删除 `$DSH_HOME/storages/dsh_memory/`，需要时手动删除。

---

## 12. 快速参考

```text
页面入口：左侧栏 Memory / 记忆
端点：    cd embedding-service && node server.mjs
离线测试：npm test
语义测试：npm run test:semantic
全量重算：memory_manage action="reembed" force=true
清空缓存：memory_manage action="purge_cache" level="all" scope="all"
数据：    $DSH_HOME/storages/dsh_memory/
L2：      $DSH_HOME/storages/dsh-memory/l2-cache.json
```
