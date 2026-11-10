# DeepSeek 记忆插件 技术方案

> 版本：v1.1
> 日期：2026-11-10
> 上游文档：dsh记忆插件需求单.md v1.0
> 范围：架构设计 + 接口契约（不含前端与运营后台）
> 修订：v1.1 定稿 §11 四项待确认——embedding 改自托管 BGE-M3、L3 Redis 保留、中文分词改应用层 jieba、新增批量写入接口

---

## 0. 前提假设

需求单未指定技术栈，本方案按以下默认选型展开，均设计为可替换实现（见 §7 内部接口）：

| 维度 | 默认选型 | 替换说明 |
| --- | --- | --- |
| 服务语言 | Python 3.11 + FastAPI | 接口契约与语言无关，可平移到 Go/Java |
| 关系库 + 向量 | PostgreSQL 16 + pgvector（HNSW） | 可换 Qdrant/Milvus，仅替换 `VectorIndex` 实现 |
| 关键字索引 | PostgreSQL `tsvector`（jieba 应用层分词写入 `content_tsv`）+ `ts_rank_cd` | 可换 Elasticsearch/Meilisearch，替换 `KeywordIndex` |
| 缓存 L1/L2/L3 | 进程内 LRU → SQLite(WAL) → Redis | L3 可换任意 KV，但版本号锚点需另选共享存储 |
| Embedding | 自托管 BGE-M3（1024 维，8192 token）为主，同维度 API 兜底 | 替换 `EmbeddingProvider`，维度须与 DDL 一致 |
| 部署形态 | 无状态 API 容器 + 有状态 PG/Redis | 水平扩展只扩 API 层 |

**关键取舍一**：不引入「向量库 + ES」双写。双写会带来跨库一致性、双份运维成本和删除时序问题，而 NFR-1（P95 < 300ms）在千万级记忆量下单库即可满足。向量与关键字同库不同索引，写入在同一事务内完成，从根本上消除 FR-1.6 的同步冲突。

**关键取舍二（修正上游前提）**：需求单 FR-2.1 假设存在「DeepSeek embedding」接口，但据核实 DeepSeek 开放平台仅提供 chat/reasoner/FIM 类接口，**没有公开 embedding 能力**，该需求项需同步修订。因此 embedding 改为自托管 BGE-M3：M3 单模型同时产出 dense + sparse 向量，未来关键字路升级为稀疏向量时无需换模型，且 1024 维与 DDL 一致。自托管的核心收益是**回填与换模型可自控**——千万条历史记忆一次性回填约 8 亿 token，走外部 API 会被限流卡住数天，GPU 上按 300 条/s 估算约 9 小时可完成。

---

## 1. 总体架构

### 1.1 分层视图

```
┌──────────────────────────────────────────────────────────────┐
│  接入层    DeepSeek 工具链 Plugin / SDK / HTTP Client          │
│            (MCP Tool 或 OpenAI-style function call)           │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTPS + Bearer
┌───────────────────────────▼──────────────────────────────────┐
│  API 层    FastAPI: 鉴权 / 限流 / 参数校验 / 脱敏网关 / 审计日志   │
│            /v1/memories  /v1/memories:search  /v1/cache/*      │
└───────────────────────────┬──────────────────────────────────┘
                            │ 进程内调用
┌───────────────────────────▼──────────────────────────────────┐
│  业务层    MemoryService（写入编排 / 检索编排 / 生命周期）        │
│            ├─ WritePipeline   脱敏 → 去重 → 关键词 → 向量 → 落库 │
│            ├─ SearchPipeline  归一化 → 缓存 → 双路召回 → 融合    │
│            └─ VersionManager  索引版本号（缓存失效锚点）          │
└───────┬───────────────────────────────┬──────────────────────┘
        │                               │
┌───────▼──────────────┐      ┌─────────▼────────────────────┐
│  检索层 Retrieval     │      │  缓存层 Cache（三层）          │
│  ├ VectorIndex       │      │  L1 进程内存 LRU+TTL（<1ms）   │
│  ├ KeywordIndex      │      │  L2 SQLite 文件（1-3ms）       │
│  └ RRFFusion         │      │  L3 Redis 共享（3-10ms）       │
└───────┬──────────────┘      └─────────┬────────────────────┘
        │                               │
┌───────▼───────────────────────────────▼──────────────────────┐
│  存储层  PostgreSQL(记忆表 + 向量索引 + 全文索引) / Redis       │
│          Embedding Provider（外部 API / 本地模型）             │
└──────────────────────────────────────────────────────────────┘
```

### 1.2 组件职责

| 组件 | 职责 | 有状态 |
| --- | --- | --- |
| Plugin/Adapter | 把 DeepSeek 对话上下文转成 write/search 调用；会话结束时触发批量写入 | 否 |
| API 层 | 鉴权、限流、请求校验、PII 脱敏、日志与指标埋点 | 否 |
| MemoryService | 唯一业务入口，编排写入与检索，不做 IO 细节 | 否 |
| WritePipeline | 归一化、脱敏、去重、分词与关键词抽取、向量化、事务落库、版本递增 | 否 |
| SearchPipeline | 查询归一化、缓存查询、双路并行召回、RRF 融合、回填缓存 | 否 |
| VersionManager | 维护 `user_id → index_version`，写操作同步递增，作为缓存键的一部分 | 是（Redis+PG） |
| VectorIndex | 向量 Top-K 检索，带过滤条件 | 依赖 PG |
| KeywordIndex | 全文/布尔检索，`ts_rank_cd` 排序 | 依赖 PG |
| RRFFusion | 双路结果加权融合 | 否 |
| CacheStore | 统一三层读写接口，LRU/TTL、singleflight、空值缓存 | 是 |
| EmbeddingProvider | 文本→向量，含结果缓存与降级 | 否 |

---

## 2. 关键链路设计

### 2.1 写入链路（FR-1.1 / 2.1 / 2.5）

```
content
  → normalize（去控制字符、折叠空白）
  → pii_mask（手机/邮箱/证件/密钥 → 占位符）        # 脱敏在向量化之前
  → content_hash = sha1(user_id|session_id|norm_content)
  → 幂等检查：content_hash 已存在 → 返回既有 id（去重）
  → keywords = 显式keywords ∪ extractor(取 Top 8)
  → content_tsv = to_tsvector('simple', jieba_cut(norm_content))
  → embedding = EmbeddingProvider.embed(norm_content)   # 先查 embedding 缓存
  → 事务：INSERT memory + UPDATE memory_version(+1)
  → 发布失效事件（进程内事件，非必需：版本号已覆盖）
  → 返回 {id, version}
```

要点：

- **幂等**：`content_hash` 唯一索引 + `Idempotency-Key` 双重保障，重复写入不产生重复记忆。
- **版本号即失效**：写入成功后版本号 `+1`，所有检索缓存键随之失效，无需遍历删除缓存（解决 FR-5.6 的实现复杂度）。版本号必须**在返回成功之前**落 Redis，保证写后读不脏。
- **向量化失败**：写入仍成功，`embed_status='pending'`，由补偿任务（每 30s 扫描）重试，最多 5 次后标记 `failed`；此期间该条记忆只能被关键字通道召回。

### 2.2 检索链路（FR-2.x / 3.x / 4.x / 5.x）

```
query
  → normalize（小写化、全半角统一、去首尾空白、截断 512 字符）
  → cache_key = sha256(user_id | scope | norm_query | topk | filters_hash | index_version)
  → L1 命中？→ 返回（cache.hit=l1）
  → L2 命中？→ 回填 L1 → 返回（hit=l2）
  → L3 命中？→ 回填 L1/L2 → 返回（hit=l3）
  → singleflight 抢占（同 key 仅一个请求计算）
  → 并行：[向量化 query → VectorIndex.topk] ∥ [KeywordIndex.search]   (asyncio.gather, 超时 200ms)
  → RRFFusion 融合 → 阈值过滤 → 截断 topk
  → 回填 L1/L2/L3（TTL + 抖动）
  → 返回（hit=none）
```

### 2.3 删除 / 更新链路

| 操作 | 数据动作 | 缓存动作 |
| --- | --- | --- |
| 删除 | `deleted_at` 置位（软删），`version+=1` | 版本号变化 → 旧键自然失效 |
| 硬删 | 物理删除 + 关联向量索引自动更新 | 同上；`hard=true` 需管理员权限 |
| 更新 content | 重新脱敏 + 重新向量化 + `version+=1`（记忆级） | 同上 |
| 更新 keywords/meta | 仅更新字段 + `version+=1`（记忆级） | 同上 |

---

## 3. 数据模型

```sql
CREATE EXTENSION IF NOT EXISTS vector;
-- 不安装 pg_bigm / zhparser：中文分词在应用层完成，仅依赖内置 tsvector

CREATE TABLE memory (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        TEXT        NOT NULL,
  session_id     TEXT        NOT NULL,
  content        TEXT        NOT NULL,
  content_hash   CHAR(40)    NOT NULL,
  content_tsv    TSVECTOR    NOT NULL,       -- 应用层 jieba 分词后构造
  keywords       TEXT[]      NOT NULL DEFAULT '{}',
  embedding      vector(1024),
  embed_status   TEXT        NOT NULL DEFAULT 'pending'
                 CHECK (embed_status IN ('pending','ok','failed')),
  source         TEXT        NOT NULL DEFAULT 'chat',
  extra          JSONB       NOT NULL DEFAULT '{}',
  score          REAL,                       -- 外部写入时的初始相关度，可选
  expire_at      TIMESTAMPTZ,                -- 记忆级 TTL，NULL 表示永久
  version        INT         NOT NULL DEFAULT 1,
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, content_hash)
);

-- 向量索引：余弦距离
CREATE INDEX idx_memory_vec ON memory
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- 关键字索引：应用层 jieba 分词结果 + ts_rank_cd 排序
CREATE INDEX idx_memory_kw ON memory USING gin (keywords);
CREATE INDEX idx_memory_tsv ON memory USING gin (content_tsv);

-- 过滤与列表
CREATE INDEX idx_memory_scope ON memory (user_id, session_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- 索引版本号（缓存失效锚点）
CREATE TABLE memory_version (
  user_id      TEXT PRIMARY KEY,
  version      BIGINT NOT NULL DEFAULT 1,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 幂等键
CREATE TABLE idempotency_key (
  key          TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  response     JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);  -- 保留 24h，定时清理
```

设计说明：

- `embedding` 允许为 NULL，承载「向量化待补偿」状态（FR-2.5 更新重算也复用该字段）。
- `deleted_at` 为软删（FR-1.4），所有检索 SQL 强制 `deleted_at IS NULL`。
- `expire_at` 支撑记忆级 TTL，与缓存 TTL 独立，由每日任务清理。
- `content_tsv` 由应用层 `jieba` 分词后以空格连接、`to_tsvector('simple', ...)` 构造；不装扩展，避免编译与词典维护成本，同时保留词库可替换能力。
- 向量维度固定 1024（BGE-M3）；换模型必须保持同维度，否则需全量重算并重建列类型与 HNSW 索引。

---

## 4. 缓存设计（FR-5.x / NFR-1 / NFR-4）

### 4.1 三层职责边界

| 层 | 介质 | 作用域 | 典型延迟 | 容量 | 主要收益 |
| --- | --- | --- | --- | --- | --- |
| L1 | 进程内 dict（LRU+TTL） | 单进程 | < 0.5ms | 2000 条 / 64MB | 高频重复 query 免 IO |
| L2 | SQLite（WAL，按天分文件） | 单机多进程 | 1-3ms | 200MB，LRU 淘汰 | 进程重启/多 worker 复用，省 Redis 往返 |
| L3 | Redis | 集群/多端 | 3-10ms | 按内存配额，`allkeys-lru` | 跨设备、跨实例共享（多端同步的读侧收益） |

读穿透顺序 L1→L2→L3，任一层命中即回填上层。写回填为异步（`asyncio.create_task`），不阻塞响应。

### 4.2 缓存键规范（FR-5.5）

```
检索结果键  m:s:{sha256(user_id|scope|norm_query|topk|filters_hash|index_version)}
向量化键    m:e:{sha256(model_id|norm_text)}
空结果键    m:n:{同检索结果键}        # 空值缓存，防穿透
版本号键    m:v:{user_id}             # L3 only，无 TTL
```

- `filters_hash`：过滤条件按固定字段序序列化后哈希，保证同义条件同键。
- `index_version`：读取时从 L3 取（缺失则回源 PG），缺失视为 0。**它使「写后旧缓存」在物理上不可读**，因此不存在脏读，满足 NFR-4，且失效是 O(1)。
- `norm_text` 用于向量缓存，与查询归一化规则一致，保证 `" 你好"` 与 `"你好"` 复用同一向量。

### 4.3 失效策略（FR-5.4 / 5.6）

| 场景 | 策略 |
| --- | --- |
| 容量淘汰 | L1 严格 LRU；L2/L3 按 LRU + 最大条目数双重限制 |
| 时间过期 | 默认 TTL：检索结果 300s，向量 7d，空结果 30s |
| 雪崩防护 | TTL 加 ±10% 随机抖动，避免同批键同时过期 |
| 击穿防护 | 同 key `singleflight`，等待方最多等 250ms，超时降级为直接计算 |
| 穿透防护 | 空结果写 30s 负缓存 |
| 数据变更 | 版本号递增（同步、写前完成）；不做键级遍历删除 |
| 手动清空 | `POST /v1/cache/purge`，仅运维角色 |

`scope` 语义：`session`（仅当前会话）/ `user`（该用户全部）/ `global`（共享知识，默认关闭）。不同 scope 使用不同键，互不污染。

### 4.4 延迟预算（NFR-1 分解）

| 环节 | 命中缓存 P95 | 未命中 P95 |
| --- | --- | --- |
| 鉴权 + 参数校验 | 3ms | 3ms |
| 缓存查询 | 1ms | 12ms（三级全 miss） |
| query 向量化 | - | 80ms（含向量缓存命中则 1ms） |
| 向量检索 | - | 60ms |
| 关键字检索 | - | 45ms（并行，取 max） |
| RRF 融合 | - | 5ms |
| 序列化 + 回填 | 2ms | 8ms（回填异步） |
| **合计** | **≈ 10ms（< 50ms 达标）** | **≈ 165ms（< 300ms 达标，留 45% 余量）** |

---

## 5. 混合检索算法

### 5.1 加权 RRF

$$
\text{score}(d) = \sum_{i \in \{\text{sem},\text{kw}\}} w_i \cdot \frac{1}{k + \text{rank}_i(d)}
$$

- `k = 60`（经验值，抑制头部排名差异）
- 默认 `w_semantic = 0.6`，`w_keyword = 0.4`；约束 `w_sem + w_kw = 1`，服务端归一化，非法入参返回 400。
- 仅一路召回时，另一路权重按 1.0 归一化处理（避免分数整体缩水）。
- 融合后按 `score` 降序，应用 `min_score` 阈值（默认 0，仅对语义路生效）后截断 `topk`。

### 5.2 单路召回参数

| 通道 | 候选数 | 说明 |
| --- | --- | --- |
| 语义 | `candidate_k = max(topk * 3, 20)` | `ef_search = 64`，过滤 `user_id`、`session_id`、时间范围 |
| 关键字 | `candidate_k = max(topk * 3, 20)` | `content_tsv` 与 `keywords` 双字段加权（`keywords` 权重 2.0），`ts_rank_cd` 排序后按当批最大值归一到 0-1 |

### 5.3 伪代码

```python
async def search(req: SearchRequest) -> SearchResponse:
    norm = normalize(req.query)
    ver = await version_manager.get(req.user_id)
    key = cache_key(req, norm, ver)

    if hit := await cache.get(key):
        return hit.to_response(cache_hit=hit.level)

    async with singleflight(key, timeout=0.25):
        if hit := await cache.get(key):        # 双检
            return hit.to_response(cache_hit=hit.level)

        vec_task = embed_and_search(norm, req)          # 内部带向量缓存
        kw_task = keyword_index.search(norm, req)       # 内部 jieba 分词 → tsquery
        sem, kw = await asyncio.gather(vec_task, kw_task, return_exceptions=True)

        fused = rrf_fuse(sem or [], kw or [], req.w_semantic, req.w_keyword, k=60)
        results = truncate(filter_by_score(fused, req.min_score), req.topk)

        resp = build_response(results, sem, kw)
        await cache.set_async(key, resp, ttl=cfg.ttl_search)
        return resp
```

**降级策略**：向量通道超时或异常时仅返回关键字结果，响应体 `degraded=true` 并带 `degraded_reason`；两路均失败返回 503。

---

## 6. 接口契约

### 6.1 通用约定

| 项 | 约定 |
| --- | --- |
| Base URL | `https://{host}/v1` |
| 鉴权 | `Authorization: Bearer <token>`，token 内解析 `user_id`，请求体中的 `user_id` 仅作校验，不一致返回 403 |
| 内容类型 | `application/json; charset=utf-8` |
| 追踪 | 请求 `X-Request-Id`（可选，服务端缺失则生成）；响应必带 `X-Request-Id` |
| 幂等 | 写接口支持 `Idempotency-Key`，24h 内同键返回首次结果 |
| 时间格式 | RFC3339 UTC，如 `2026-11-10T08:00:00Z` |
| 成功响应 | `{"code":0,"message":"ok","data":{...},"request_id":"..."}` |
| 失败响应 | `{"code":40001,"message":"...","data":null,"request_id":"..."}` |
| 分页 | 游标式：`limit`(1-200, 默认 20) + `cursor`（不透明串） |

### 6.2 错误码

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | 40001 | 参数校验失败 |
| 400 | 40002 | 权重非法（`w_semantic + w_keyword != 1`） |
| 400 | 40003 | query 为空或超长（> 512 字符） |
| 401 | 40101 | token 缺失或无效 |
| 403 | 40301 | user_id 与 token 不匹配 |
| 403 | 40302 | 无该操作权限（如硬删） |
| 404 | 40401 | 记忆不存在或已删除 |
| 409 | 40901 | 并发更新冲突（`version` 不匹配） |
| 409 | 40902 | 幂等键复用但请求体不一致 |
| 409 | 40903 | `atomic=true` 时批次内存在失败项，已整体回滚 |
| 422 | 42201 | 内容被脱敏后为空，拒绝写入 |
| 429 | 42901 | 触发限流 |
| 503 | 50301 | 检索依赖不可用（双通道失败） |
| 503 | 50302 | Embedding 服务不可用（写入降级为 pending） |
| 500 | 50000 | 服务内部错误 |

### 6.3 写入记忆

`POST /v1/memories`

请求：

```json
{
  "user_id": "u_10086",
  "session_id": "s_20261110_01",
  "content": "用户偏好 Python 3.11，使用 FastAPI 构建服务，部署在 K8s。",
  "keywords": ["Python", "FastAPI"],
  "source": "chat",
  "extra": {"turn": 12, "role": "user"},
  "ttl_seconds": 2592000,
  "need_embedding": true,
  "need_keywords": true
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| user_id | string | 是 | 1-64 字符，与 token 一致 |
| session_id | string | 是 | 1-128 字符 |
| content | string | 是 | 1-8000 字符（超长请调用方先分段） |
| keywords | string[] | 否 | ≤ 20 项，每项 ≤ 32 字符 |
| source | string | 否 | 默认 `chat` |
| extra | object | 否 | ≤ 4KB，不参与检索 |
| ttl_seconds | int | 否 | 60 - 31536000，缺省永久 |
| need_embedding | bool | 否 | 默认 true |
| need_keywords | bool | 否 | 默认 true，false 时不自动抽取 |

响应 `201`：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "id": "0b7e2f5a-9f0e-4a1c-9a6d-3b1f2c7d8e11",
    "version": 1,
    "deduplicated": false,
    "embed_status": "ok",
    "keywords": ["Python", "FastAPI", "K8s", "服务部署"],
    "index_version": 42,
    "created_at": "2026-11-10T08:00:00Z"
  },
  "request_id": "req_7f3a"
}
```

重复内容返回 `200`，`data.deduplicated=true`，`id` 为既有记录 ID。

### 6.4 批量写入记忆

`POST /v1/memories:batch`

会话结束上传的主路径。单次 ≤ 100 条，向量化一次批量完成；`Idempotency-Key` 作用于整个批次。

请求：

```json
{
  "atomic": false,
  "items": [
    {"user_id": "u_10086", "session_id": "s_20261110_01", "content": "用户偏好 Python 3.11。", "keywords": ["Python"]},
    {"user_id": "u_10086", "session_id": "s_20261110_01", "content": "服务部署在 K8s，使用 FastAPI。", "extra": {"turn": 13}}
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| items | object[] | 是 | 1-100 条，单条字段同 §6.3；所有 `user_id` 必须一致 |
| atomic | bool | 否 | 默认 false（部分成功）；true 时全成全败，任一失败返回 409/40903 |

响应 `200`（部分成功同样是 200，逐条看 `status`）：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "total": 2,
    "succeeded": 1,
    "failed": 1,
    "embed_status": "ok",
    "index_version": 43,
    "items": [
      {"index": 0, "id": "0b7e2f5a-9f0e-4a1c-9a6d-3b1f2c7d8e11", "status": "created"},
      {"index": 1, "id": null, "status": "failed", "error_code": 42201, "message": "内容脱敏后为空"}
    ]
  },
  "request_id": "req_7f3b"
}
```

- `status`：`created` / `duplicated` / `failed`。
- 整批只递增一次 `index_version`，避免逐条失效造成缓存抖动。
- 单批同步耗时超过 2s 时需改走异步通道（当前版本未提供，见 §11 遗留项）。

### 6.5 混合检索

`POST /v1/memories:search`（复杂条件，推荐）

`GET /v1/memories:search?q={query}&topk=10&scope=user`（快捷形式，仅支持 `q/topk/scope/session_id`）

请求：

```json
{
  "user_id": "u_10086",
  "query": "我之前用什么框架写服务？",
  "scope": "user",
  "session_id": null,
  "topk": 10,
  "candidate_k": 30,
  "min_score": 0.0,
  "w_semantic": 0.6,
  "w_keyword": 0.4,
  "filters": {
    "session_ids": ["s_20261110_01"],
    "time_range": {"from": "2026-10-01T00:00:00Z", "to": "2026-11-10T23:59:59Z"},
    "sources": ["chat"]
  },
  "include_embedding": false,
  "use_cache": true
}
```

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| query | string | 是 | - | 1-512 字符 |
| scope | enum | 否 | user | `session` / `user` / `global` |
| session_id | string | 否 | null | scope=session 时必填 |
| topk | int | 否 | 10 | 1-50 |
| candidate_k | int | 否 | 30 | 每路候选数，1-200 |
| min_score | float | 否 | 0.0 | 语义相似度下限，0-1 |
| w_semantic / w_keyword | float | 否 | 0.6 / 0.4 | 和为 1，服务端归一化 |
| filters | object | 否 | {} | 会话、时间、来源过滤 |
| include_embedding | bool | 否 | false | 调试用，返回时置 `embed_status` |
| use_cache | bool | 否 | true | 压测/强一致场景可置 false |

响应 `200`：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "query": "我之前用什么框架写服务？",
    "results": [
      {
        "id": "0b7e2f5a-9f0e-4a1c-9a6d-3b1f2c7d8e11",
        "content": "用户偏好 Python 3.11，使用 FastAPI 构建服务，部署在 K8s。",
        "keywords": ["Python", "FastAPI"],
        "session_id": "s_20261110_01",
        "source": "chat",
        "score": 0.0312,
        "scores": {"semantic": 0.87, "keyword": 0.0, "semantic_rank": 1, "keyword_rank": null},
        "sources": ["vector"],
        "created_at": "2026-11-10T08:00:00Z",
        "meta": {"turn": 12}
      }
    ],
    "total": 1,
    "cache": {"hit": true, "level": "l1", "age_ms": 1200},
    "degraded": false,
    "latency_ms": 8,
    "index_version": 42
  },
  "request_id": "req_7f3a"
}
```

- `score`：RRF 融合分（无量纲，仅用于排序，勿与阈值比较）。
- `scores.semantic`：余弦相似度（0-1）；`scores.keyword`：`ts_rank_cd` 归一化后的相关度。
- `sources`：命中通道，取值 `vector` / `keyword` / `both`，对应 FR-4.3。
- `cache.level`：`l1` / `l2` / `l3` / `null`。

### 6.6 读取单条

`GET /v1/memories/{id}?include_embedding=false`

`200` 响应 `data` 字段：`id, user_id, session_id, content, keywords, source, extra, version, embed_status, created_at, updated_at, expire_at, deleted_at`。已软删返回 404（管理员可带 `include_deleted=true`）。

### 6.7 更新记忆

`PUT /v1/memories/{id}`

```json
{
  "content": "用户偏好 Python 3.12，使用 FastAPI。",
  "keywords": ["Python", "FastAPI"],
  "extra": {"turn": 12},
  "version": 1
}
```

- 全部字段可选，至少传一个。
- `content` 变更 → 重新脱敏、重新向量化、`version+1`。
- 传 `version` 时做乐观锁，不匹配返回 `409/40901`；不传则强制覆盖（PATCH 语义）。
- 响应 `200`，`data` 同 §6.6。

### 6.8 删除记忆

`DELETE /v1/memories/{id}?hard=false`

- 默认软删：置 `deleted_at`，`version+1`，返回 `200 {"data":{"id":"...","deleted":true,"hard":false}}`。
- `hard=true` 需管理员角色（`403/40302`），物理删除不可恢复。
- 重复删除幂等返回 200。

### 6.9 列出记忆

`GET /v1/memories?session_id={sid}&limit=20&cursor={c}&order=created_at:desc`

返回 `data.items[]`（字段同 §6.6，不含 embedding）+ `data.next_cursor`。该接口不走向量检索，纯列表。

### 6.10 缓存指标

`GET /v1/cache/stats?window=300s`

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "window": "300s",
    "hit_rate": {"overall": 0.72, "l1": 0.55, "l2": 0.12, "l3": 0.05},
    "entries": {"l1": 1832, "l2": 12043, "l3": 98120},
    "latency_ms": {"cache_hit_p95": 1.2, "cache_miss_p95": 168.0},
    "embedding_calls": {"total": 4210, "cached": 3100, "api": 1110},
    "evictions": {"lru": 87, "ttl": 1204}
  },
  "request_id": "req_7f3a"
}
```

对应 FR-5.7。

### 6.11 运维接口

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/v1/cache/purge` | admin | body `{"level":"all","scope":"user","user_id":"u_1"}`，返回清理条数 |
| POST | `/v1/memories:reembed` | admin | 重建 `embed_status != ok` 的记忆向量，异步任务，返回 `task_id` |
| GET | `/v1/healthz` | 公开 | 依赖探活：`pg` / `redis` / `embedding` 三项状态 |
| GET | `/v1/metrics` | 内网 | Prometheus 文本格式 |

---

## 7. 内部模块接口

```python
from typing import Protocol, Sequence, Any
from dataclasses import dataclass

@dataclass
class MemoryRecord:
    id: str; user_id: str; session_id: str; content: str
    keywords: list[str]; source: str; extra: dict[str, Any]
    version: int; embed_status: str; created_at: str

@dataclass
class ScoredItem:
    record: MemoryRecord
    score: float          # 语义相似度或关键字相关度，0-1
    rank: int             # 1-based

class EmbeddingProvider(Protocol):
    model_id: str
    dim: int
    async def embed(self, texts: Sequence[str]) -> list[list[float]]: ...
    async def embed_one(self, text: str) -> list[float]: ...

class VectorIndex(Protocol):
    async def upsert(self, record: MemoryRecord, vector: list[float]) -> None: ...
    async def search(self, vector: list[float], *, user_id: str, session_ids: list[str] | None,
                     time_range: tuple[str, str] | None, candidate_k: int,
                     timeout_ms: int = 200) -> list[ScoredItem]: ...
    async def delete(self, ids: list[str], *, hard: bool) -> None: ...

class KeywordIndex(Protocol):
    async def search(self, query: str, *, user_id: str, session_ids: list[str] | None,
                     time_range: tuple[str, str] | None, candidate_k: int,
                     timeout_ms: int = 200) -> list[ScoredItem]: ...
    async def upsert(self, record: MemoryRecord) -> None: ...

class CacheStore(Protocol):
    """三层统一门面，内部按 L1→L2→L3 编排。"""
    async def get(self, key: str) -> tuple[bytes, str] | None: ...   # (payload, level)
    async def set(self, key: str, payload: bytes, ttl_s: int) -> None: ...
    async def delete(self, key: str) -> None: ...
    async def invalidate_user(self, user_id: str, level: str = "all") -> int: ...

class VersionManager(Protocol):
    async def get(self, user_id: str) -> int: ...
    async def bump(self, user_id: str) -> int: ...     # 写事务提交后调用，同步完成

class Fusion(Protocol):
    def fuse(self, sem: list[ScoredItem], kw: list[ScoredItem],
             w_semantic: float, w_keyword: float, k: int = 60) -> list[ScoredItem]: ...
```

替换实现只需满足上述 Protocol，`MemoryService` 不感知具体存储。

---

## 8. 非功能落地

### 8.1 安全（NFR-2 / NFR-5）

| 项 | 措施 |
| --- | --- |
| 传输 | 全链路 TLS 1.3，内部服务间 mTLS |
| 落盘 | PG 开启 `pgcrypto` 对 `content` 列做 AES-256 加解密（密钥走 KMS，应用侧解密）；或依赖云盘加密 |
| 脱敏 | 写入前正则 + 规则脱敏手机号、身份证、邮箱、`sk-`/`AKIA` 类密钥；日志只记录 `content_hash` 与长度 |
| 鉴权 | token → `user_id`，所有查询强制注入 `user_id` 条件，杜绝越权读；管理员接口独立角色 |
| 审计 | 写/删/管理员操作写审计表（操作人、目标 id、IP、时间） |

### 8.2 可观测指标

| 指标 | 类型 | 标签 |
| --- | --- | --- |
| `memory_search_latency_ms` | Histogram | `cache_level`, `degraded` |
| `memory_cache_hit_total` | Counter | `level` |
| `memory_embedding_requests_total` | Counter | `source=api\|cache\|fallback` |
| `memory_write_total` | Counter | `deduplicated`, `embed_status` |
| `memory_retrieval_candidates` | Histogram | `channel=vector\|keyword` |
| `memory_degraded_total` | Counter | `reason` |

告警阈值：`cache_hit_rate < 0.5` 持续 10min；`search_p95 > 300ms` 持续 5min；`degraded_total` 5min 内 > 10。

### 8.3 容量与扩展（NFR-3）

- 单条记忆：正文均值 200B + 向量 1024×4B = 4KB，加索引开销约 6KB。
- 100 万用户 × 平均 5000 条 = 50 亿条不现实，按真实场景取 **1000 万条 ≈ 60GB**，单实例 PG 可承载。
- 水平扩展：API 层无状态，按 CPU/QPS 扩容；PG 读多写少，可加只读副本承接向量/关键字检索；L3 Redis 集群模式分片。
- 分片预留：`user_id` 作为一致性哈希键，未来切分库时路由不改。

---

## 9. 部署拓扑

```yaml
services:
  api:            # 无状态，2+ 副本，HPA 按 CPU 60%
    image: dsh-memory:1.0
    env: { PG_DSN, REDIS_URL, EMBEDDING_BASE_URL, CACHE_L1_MAX: "2000", CACHE_TTL_SEARCH: "300" }
  embedding-worker:  # 补偿任务：pending 向量重算
    command: python -m app.jobs.reembed
  postgres:       # pgvector 0.7，无需 pg_bigm / zhparser
  redis:          # 6.x，allkeys-lru，maxmemory 1gb（版本号锚点 + L3 缓存）
  embedding:      # BGE-M3，TEI / vLLM 部署，输出 1024 维
```

配置项（`config.yaml`）：

```yaml
retrieval:
  rrf_k: 60
  w_semantic: 0.6
  w_keyword: 0.4
  candidate_k_multiplier: 3
  channel_timeout_ms: 200
  keyword:
    tokenizer: jieba
    keywords_field_boost: 2.0
cache:
  ttl_search_s: 300
  ttl_embedding_s: 604800
  ttl_negative_s: 30
  ttl_jitter_ratio: 0.1
  l1_max_entries: 2000
  l2_path: /var/lib/dsh/cache.db
  l2_max_entries: 50000
  singleflight_timeout_ms: 250
security:
  pii_mask: true
  encrypt_content: true
```

---

## 10. 需求覆盖矩阵

| 需求 | 落地位置 |
| --- | --- |
| FR-1.1 云端存储 | §2.1 写入链路、§3 `memory` 表 |
| FR-1.2 租户隔离 | §3 所有索引带 `user_id`；§6.1 鉴权强制注入 |
| FR-1.3 触发方式 | §2.1 单条写入 + §6.4 批量写入（会话结束主路径） |
| FR-1.4 CRUD/软删 | §6.3 / 6.6 / 6.7 / 6.8 |
| FR-1.5 加密脱敏 | §8.1 |
| FR-1.6 增量同步与冲突 | §3 `version` + §6.7 乐观锁；单库免跨库冲突 |
| FR-2.1 ~ 2.3 | §2.2 检索链路、§5.2 参数 |
| FR-2.4 过滤条件 | §6.5 `filters` |
| FR-2.5 重算向量 | §6.7 更新链路 + §6.11 `reembed` |
| FR-3.1 ~ 3.3 | §3 `content_tsv` GIN 索引、§5.2 关键字路 |
| FR-3.4 自动抽关键字 | §2.1 extractor（jieba + TF-IDF 兜底） |
| FR-4.1 ~ 4.3 | §5.1 RRF、§6.5 `scores`/`sources` |
| FR-5.1 ~ 5.7 | §4 全节、§6.10 |
| NFR-1 延迟 | §4.4 延迟预算 |
| NFR-2 安全 | §8.1 |
| NFR-3 扩展 | §8.3 |
| NFR-4 无脏读 | §4.2 `index_version` 进键 |
| NFR-5 日志脱敏 | §8.1 |

---

## 11. 已定决策与遗留项

| 项 | 决策 | 依据 |
| --- | --- | --- |
| Embedding 选型 | 自托管 BGE-M3（1024 维），同维度 API 兜底 | 上游假设的 DeepSeek embedding 接口不存在；自托管可自控回填与换模型成本 |
| L3 Redis | 首版必上，配额 1GB | 承担的是一致性锚点（多实例共享 `index_version`），不是命中率；不引入则多实例写后读会脏 |
| 中文分词 | jieba 应用层分词写入 `content_tsv`，`ts_rank_cd` 排序 | 零扩展依赖、词库可控；`pg_bigm` 二元切分排序质量差，会污染 RRF 融合分 |
| 批量写入 | `POST /v1/memories:batch`，≤100 条，部分成功语义 | 会话结束上传是 FR-1.3 主路径；逐条调用会带来 N 次鉴权/事务/往返，且 embedding 天然可批量 |

遗留项：

1. **合规**：记忆存储地域与留存期限需法务确认，直接影响 §3 `expire_at` 默认值。
2. **异步批量**：单批常打满 100 条且耗时超 2s 时，需补 `202 + task_id` 的异步写入通道（当前仅同步实现）。
3. **维度变更**：若后续换模型导致维度变化，`embedding` 列类型与 HNSW 索引需重建并全量重算，切换方案另出。
