# dsh-cloud-memory 技术说明与答辩手册

> 面向课程答辩、项目汇报、面试和代码评审。  
> 配套：[`../README.md`](../README.md)（架构）、[`USAGE.md`](USAGE.md)（操作）；发布流程见仓库根目录的 `PUBLISHING.md`。

---

## 0. 30 秒版本

> dsh-cloud-memory 是 DeepSeek Harness 的跨会话记忆插件。写入时做 PII 脱敏、内容去重、关键字抽取和 1024 维 embedding；检索时并行走向量余弦和 BM25，两路结果用加权 RRF 融合；外部用 L1/L2/L3 三层缓存和用户级 `index_version` 保证写后不脏读。插件以 Host 插件运行，提供 3 个 Agent 工具、REST API 和 Web 管理页，并用真实 BGE-M3 端点验证了语义质量。

关键数字：

| 指标 | 结果 |
| --- | --- |
| 语义单路 top1 / top3 | **100% / 100%**（16 条语料、8 条查询） |
| 混合 top1 / top3 | 88% / **100%** |
| BGE-M3 单条 embedding | 25–50ms（CPU 量化 ONNX） |
| 检索未命中 | 约 46ms |
| L1 命中 | 0.28–0.85ms |

---

## 1. 项目定位

### 1.1 问题

LLM 对话跨会话没有持久记忆：用户要重复说明偏好、项目约束、历史决策；长对话 token 贵；关键字检索处理不了同义改写，纯向量检索又容易漏精确术语。

### 1.2 目标

1. 记忆持久化、可备份；
2. 语义 + 关键字双通道召回；
3. 三层缓存降低延迟和重复计算；
4. 可插拔 Plugin，接入 DSH 工具链；
5. 用真实 embedding 模型验证，而不是只验证“能跑”。

### 1.3 交付形态

| 层 | 交付 |
| --- | --- |
| 数据 | Harness `ctx.storage` JSON KV，`per-record` |
| 业务 | `MemoryService`：写入、检索、CRUD、版本、统计 |
| 检索 | 余弦 + BM25 + 加权 RRF |
| 缓存 | L1 进程 LRU、L2 JSON 文件、L3 可选 Redis |
| 接入 | 3 个 Agent 工具、`/dsh-memory/api`、Web 页面 |
| 验证 | 7 组离线测试 + 真实 BGE-M3 语义基准 |

---

## 2. 架构

```text
Agent tools / Web UI / HTTP
          │
          ▼
MemoryService
 ├ WritePipeline: normalize → PII → dedup → keywords → embed → store → version+1
 ├ SearchPipeline: version → cache key → cache → singleflight
 │                 → vector ∥ BM25 → RRF → topk
 └ VersionManager: user → index_version
          │
          ▼
MemoryStore                         CacheStore
 ├ memories / versions              ├ L1 process LRU
 ├ idempotency / audit              ├ L2 JSON file
 ├ KeywordIndex (BM25)              └ L3 Redis (optional)
 └ VectorMap (1024-d)
          │
          ▼
Harness storage KV            EmbeddingProvider
 per-record JSON              BGE-M3 / local hash fallback
```

### 2.1 为什么是 Host 插件，不是 FastAPI 服务

技术方案默认 Python + FastAPI + PG/pgvector，但 §7 明确把 `EmbeddingProvider` / `VectorIndex` / `KeywordIndex` / `CacheStore` 定义成可替换 Protocol。当前交付环境是 DSH：

- Host 插件可直接用 `ctx.storage`、`ctx.tools`、`ctx.webServer`、`ctx.systemPrompt`、`ctx.slots`；
- 不需要额外服务、数据库和部署；
- 业务契约、RRF、缓存策略、版本锚点都保留。

面试可以说：

> 我实现的是技术方案“可替换实现”的一种；生产环境换回 PG/pgvector 时，只需替换 `VectorIndex`/`KeywordIndex`/`MemoryStore` 三个实现，`MemoryService` 不改。

### 2.2 选型映射

| 方案 | 实现 | 原因 |
| --- | --- | --- |
| FastAPI | Host 插件（ESM，零外部依赖） | 原生集成工具/页面/生命周期 |
| PostgreSQL | `ctx.storage` JSON KV，`per-record` | 零运维；单条写入避免整库重写 |
| pgvector HNSW | 进程内归一化向量 + 余弦 | 万级个人记忆足够；可替换 |
| tsvector + jieba | `Intl.Segmenter('zh')` + 内存 BM25 | 零扩展依赖；词库可控 |
| BGE-M3 | TEI/OpenAI-compatible 端点 | 真实模型验证；可替换 |
| Redis L3 | 自实现最小 RESP 客户端 | 可选，多实例版本锚点 |
| 异步批量 | 同步批量 ≤100 | 与方案遗留项一致 |

---

## 3. 数据模型

```text
Memory {
  id, userId, sessionId,
  content,          // 脱敏后正文
  contentHash,      // sha1(userId|sessionId|maskedContent)
  keywords[],
  embedding,        // base64 float32 × 1024
  embedStatus,      // pending | ok | failed
  embedSource,      // tei | openai | local | disabled
  source, extra, score,
  expireAt, version,
  deletedAt, createdAt, updatedAt
}
```

存储布局：

```text
$DSH_HOME/storages/dsh_memory/
  memories/<uuid>.json
  versions/<sha1(user)>.json
  idempotency/<sha1(key)>.json
  audit/<timestamp>-<uuid>.json
```

派生索引：

- `hashIndex: userId|contentHash → id`：去重 O(1)；
- `KeywordIndex`：`term → (id → tf)`，维护 `df`、文档长度；
- `vectors: id → Float32Array`：启动解码，检索不重复解码。

这些索引都是派生数据，可从 `memories` 重建。

---

## 4. 代码走读

### 4.1 启动

`index.js`

- `inject = ['storage', 'storage.backend.json', 'tools']`；
- `resolveConfig` 手写默认值/范围校验；
- `apply`：打开 store/cache → 创建 embedder/service → 注册工具/提示/路由/定时器；
- 所有资源用 `ctx.effect` 注册 disposer，插件卸载时释放。

### 4.2 写入

`lib/service.js`

```text
content
 → normalizeText
 → maskPII
 → contentHash = sha1(user|session|content)
 → findByHash 去重
 → keywords = 显式 ∪ extractKeywords(Top 8)
 → embedding（先查向量缓存）
 → MemoryStore.addRecord（先持久化，再更新内存索引）
 → bumpVersion(user)
 → audit
```

关键：

- 脱敏在向量化之前，避免 PII 进入向量/缓存/日志；
- 去重键包含 session，同一句话在不同会话不合并；
- 先持久化再改内存，避免内存/磁盘分叉；
- 向量失败不阻塞写入，记录 `pending`，后续补偿。

### 4.3 批量写入

- ≤100 条，同一 `user_id`；
- 先全量预校验，逐条记录失败项；
- 新记录一次批量 embedding（按 32 条分片）；
- 逐条持久化，返回 `created/duplicated/failed`；
- 整批只 `bumpVersion` 一次；
- `atomic=true`：预校验失败 409/40903；中途失败尽力回滚已写记录。

限制：

> 底层 KV 无跨记录事务，`atomic` 是“预校验 + 尽力回滚”，不是数据库级原子。

### 4.4 检索

```text
query
 → normalizeQuery（≤512）
 → currentVersion(user)
 → cacheKey = m:s:sha256(user|scope|query|topk|filtersHash|version)
 → L1 → L2 → L3
 → singleflight（同 key 最多等 250ms）
 → 并行：
      semantic: embed(query) → 余弦 Top-K
      keyword : 分词 → BM25
 → 加权 RRF
 → min_score（仅语义分）
 → 截断 topk
 → 回填 L1/L2/L3
```

任一路超时/异常：另一路返回，`degraded=true`；两路都失败 503。

### 4.5 RRF

```text
score(d) = Σ w_i / (k + rank_i(d))
k = 60
默认 w_semantic = 0.6, w_keyword = 0.4
```

- 两路按 `id` 合并；
- 只有一路时该路权重 1.0；
- 融合分只用于排序，不与 `min_score` 比较。

为什么不用加权分数：BM25 无界，余弦 0–1，量纲不同；RRF 只看排名。

### 4.6 关键字

`lib/keyword.js`

- `Intl.Segmenter('zh')` 分词；未知复合词把相邻单字合并成 bigram；
- 倒排索引 + `df` + 文档长度；
- BM25：`k1=1.2`、`b=0.75`；
- `keywords` 字段权重 2.0；
- 支持 `AND` / `OR` / `NOT`、`-term`、`"短语"`；
- 分数按当批最大值归一到 0–1。

### 4.7 向量

- 1024 维，L2 normalize；
- query 与记忆点积（等价余弦）；
- 只比较 `embedSource` 相同的向量；
- `candidateK = max(topk × 3, 20)`；
- 万级用暴力检索，千万级换 HNSW/pgvector。

### 4.8 Embedding

`lib/embedding.js`

- 支持 TEI `/embed` 与 OpenAI-compatible `/v1/embeddings`；
- 向量缓存 `m:e:sha256(modelId|text)`，TTL 7 天；
- 远端批量按 32 条分片；
- 失败可 `fallbackToLocal`；但 local 与 BGE 向量不混算；
- 状态 `unknown → ok/degraded`，health 暴露错误和延迟。

### 4.9 三层缓存

`lib/cache.js`

| 层 | 实现 | 作用域 |
| --- | --- | --- |
| L1 | 进程 Map，LRU+TTL | 单进程 |
| L2 | JSON 文件，原子写 | 单机/重启 |
| L3 | Redis，最小 RESP | 多实例 |

键：

```text
m:s:sha256(user|scope|query|topk|filtersHash|version)
m:e:sha256(model|text)
m:n:*（负缓存 30s）
m:v:<user>（L3 only）
```

TTL：检索 300s、向量 7d、空结果 30s，±10% 抖动。

防护：

- 击穿：singleflight；
- 穿透：负缓存；
- 雪崩：TTL 抖动；
- 脏读：版本号进键，写后旧键不可达。

`purge` 只清检索/负缓存，保留向量缓存。

### 4.10 版本一致性

- `memory_version`：`user_id → version`；
- 写/更新/删除后 `bumpVersion`，版本落盘并尽量写 Redis；
- 检索键带当前版本，旧键不可达；
- `versionChain` 串行 bump，避免并发拿同一 next version；
- 更新 `version` 乐观锁，冲突 409/40901。

### 4.11 并发/幂等/去重

- `MemoryStore.mutate` 单写链；
- `versionChain` 串行版本；
- `Idempotency-Key` + body hash，24h 同键同 body 返回首次结果；
- `contentHash` 去重，重复写入 200 + `deduplicated=true`。

### 4.12 HTTP / 工具 / UI

- `lib/http.js`：Fetch handler 便于测试；WebServer 实际注册 Node handler，因为 resource route 在 HTTP 下只接受 GET/HEAD，面板需要 POST/PUT/DELETE；
- 本机 loopback + Origin + JSON Content-Type；
- `lib/tools.js`：三个工具，与 UI 共用 service；
- `client.js`：`ctx.slots.inject('sidebar.panellist')` + `main`，`ctx.locale.register`；只用 `--dsw-alias-*` 主题变量。

---

## 5. 关键取舍

### 5.1 不做“向量库 + ES”双写

双写有一致性、删除时序、双份运维成本；单库（KV + 内存索引）在个人记忆规模下足够，索引可从同一份记录重建。

### 5.2 进程内索引 vs 外部向量库

| 维度 | 进程内 | 外部 |
| --- | --- | --- |
| 延迟 | 极低 | 网络+查询 |
| 规模 | 万级 | 千万级 |
| 运维 | 无 | 需要部署/备份 |
| 一致性 | 同进程 | 跨系统 |

### 5.3 RRF vs 分数融合

RRF 对量纲不敏感；代价是双通道加分可能让关键词干扰项压过语义正确项（基准 top1 88% 的原因）。

### 5.4 版本锚点 vs 主动删缓存

版本锚点 O(1)、无遍历、无“删后写回”竞态；代价是旧键占空间到 TTL，需要 LRU/TTL 回收。

### 5.5 BGE-M3 + 本地兜底 + 来源隔离

真实模型保证语义；本地哈希只用于离线；不同 `embedSource` 不比较；切模型必须 `reembed force=true`。

### 5.6 零依赖

Host 只用 Node 内置模块；代价是没有 Config schema 表单，配置走 YAML。

---

## 6. 失败模式

| 失败 | 行为 |
| --- | --- |
| 端点不可用 | keyword-only，`degraded=true`；写入 pending；不缓存降级结果 |
| 向量化失败 | 写入成功，pending；补偿/手动 reembed |
| 存储写失败 | 不更新内存索引，抛错 |
| 版本写失败 | 请求失败；记录可能已写入，需重试/对账（边界） |
| 并发更新 | 乐观锁 409，版本串行 |
| 批量中途失败 | atomic 尽力回滚；无跨记录事务 |
| 缓存雪崩/击穿/穿透 | TTL 抖动 / singleflight / 负缓存 |
| L3 不可用 | 降级 L1/L2；多实例一致性下降 |
| 跨模型向量 | source 隔离；需 force reembed |

---

## 7. 性能与扩展

- 向量 O(N·D)，N=用户记忆数，D=1024；万级可接受；
- BM25 倒排候选；
- 缓存命中 L1 O(1)；
- 扩展：pgvector/HNSW、tsvector/OpenSearch、user_id 分片、API 无状态、Redis 集群、批量异步化。

---

## 8. 安全

- PII 向量化前脱敏：手机、邮箱、证件、`sk-`/`AKIA`/GitHub token、JWT、Luhn 银行卡；
- 日志不记录正文；
- HTTP 仅 loopback + Origin + JSON；
- 缺口：无 AES 列加密、无真正多租户鉴权、无公网暴露。

---

## 9. 测试

### 离线 `npm test`

7 组：smoke、http、node-http、edge、cache、redis、chunk。

### 真实语义 `npm run test:semantic`

| 模式 | top1 | top3 | MRR |
| --- | --- | --- | --- |
| semantic-only | 100% | 100% | 1.000 |
| keyword-only | 50% | 100% | 0.729 |
| hybrid 0.6/0.4 | 88% | 100% | 0.938 |

解释：混合 top1 唯一失手是 RRF 双通道加分；top3 100%。

---

## 10. 代码地图

| 文件 | 职责 |
| --- | --- |
| `index.js` | 装配、注册、配置 |
| `lib/util.js` | 归一化、PII、分词、关键字、local embed、hash |
| `lib/keyword.js` | BM25、布尔/短语查询 |
| `lib/embedding.js` | 远端 embedding、缓存、兜底、来源 |
| `lib/store.js` | KV 持久化、内存索引、写链、版本/幂等/审计 |
| `lib/service.js` | 写入/检索/CRUD/版本/统计 |
| `lib/cache.js` | L1/L2/L3、TTL、统计、RESP |
| `lib/http.js` | Fetch/Node HTTP、路由、幂等、错误码 |
| `lib/tools.js` | 三个 Agent 工具 |
| `client.js` | Web 页面、侧栏图标、locale、样式 |

---

## 11. 面试问答

**Q1：为什么不用 FastAPI + PostgreSQL？**  
> 技术方案把存储/索引定义为可替换实现；当前环境是 DSH，Host 插件能原生接工具、页面和存储。生产换回 PG/pgvector 只替换三个实现，`MemoryService` 不改。

**Q2：为什么用 RRF？**  
> BM25 无界，余弦 0–1，直接相加要校准；RRF 只看排名，消除量纲差异，对单路分数校准不敏感。

**Q3：k=60 怎么来的？**  
> 经验值，来自方案；k 越大头部差异越平滑。可配置，上线后按语料调。

**Q4：混合 top1 为什么低于 semantic？**  
> 唯一失手是“什么时候总结本周工作”：语义选中“周五复盘”，关键词把“周一开周会”排第一，RRF 给双通道命中额外加分，所以压过语义第一。top3 仍 100%。可以调高语义权重或给 keyword-only 加阈值，但我没有为单条语料过拟合。

**Q5：缓存一致性？**  
> 用户级 `index_version` 进缓存键；写后 +1，旧键不可达；版本落盘并尽量写 Redis；bump 串行化。

**Q6：穿透/击穿/雪崩？**  
> 空结果 30s 负缓存；同 key singleflight 250ms；TTL ±10% 抖动；L3 不可用降级 L1/L2。

**Q7：并发写版本号？**  
> `MemoryStore.mutate` 串行写入；`versionChain` 串行 bump；更新还有乐观锁。

**Q8：批量是原子的吗？**  
> 不是数据库级；`atomic=true` 预校验 + 尽力回滚，底层 KV 无跨记录事务。

**Q9：embedding 失败为什么不阻塞写入？**  
> 记忆主数据，向量派生；pending 后补偿；端点关闭时 `fallbackToLocal=false`，不写不同空间向量。

**Q10：为什么 `embedSource`？**  
> local hash 与 BGE 不在同一空间，余弦没意义；source 隔离，切模型 force reembed。

**Q11：PII 为什么在向量化前？**  
> 否则 PII 进入 embedding、缓存、日志；脱敏后原文不落库。

**Q12：为什么 L2 用文件？**  
> 零依赖；临时文件 rename 原子；可读可备份；整文件重写用容量限制/LRU 控制。生产可换 SQLite/Redis。

**Q13：L3 必须吗？**  
> 单实例不必；多实例时是版本锚点（`m:v:user`）。没有 Redis 只能保证单进程。

**Q14：缓存键为什么带 filtersHash？**  
> 同 query 不同过滤必须区分，否则越权/错误范围；固定字段序序列化后 hash。

**Q15：去重 hash 为什么含 session？**  
> 需求是同一会话内去重；同一句话跨会话可能上下文不同。需要全局去重可改 user+content。

**Q16：千万级怎么扩展？**  
> 向量换 HNSW/pgvector，关键字换 PG tsvector/OpenSearch，user_id 分片，API 无状态，L3 集群。

**Q17：为什么没有 Config 表单？**  
> 零依赖，没有引入 schemastery；配置走 YAML。这是取舍/边界。

**Q18：最大的坑？**  
> ① resource route 只支持 GET/HEAD，POST 405，改 Node handler；② local hash 与 BGE 混算会给出错误相似度，加 source 隔离；③ 中文未知词退化成单字，做相邻 bigram 合并。

**Q19：重做会改什么？**  
> pgvector/tsvector、Config schema、AES/鉴权/多租户、异步批量、同义词/学习排序、更大评测集。

**Q20：这个项目体现什么能力？**  
> 需求到系统落地、缓存一致性/并发/失败降级、真实模型评测与诚实解释、宿主约束下的取舍。

---

## 12. 5 分钟演示

1. 启动 `embedding-service`；
2. 打开 Memory 页面；
3. 保存一条“用户偏好 Python 3.11 + FastAPI，部署 K8s”；
4. 搜“后端 Web 框架选型是什么？”展示 semantic / both；
5. 再搜一次展示 L1 命中 <1ms；
6. 展示缓存页 L1/L2 条目、命中率、embedding 延迟；
7. 终端 `npm test`（离线）和 `npm run test:semantic`（真实端点）。

注意：端点必须先启动；演示缓存 miss 用新 query；不要现场下载 570MB 模型。

---

## 13. 一页速记

```text
写入：normalize → PII → hash 去重 → keywords → embedding → store → version+1
检索：version → cache key → L1/L2/L3 → singleflight → 向量 ∥ BM25 → RRF → topk
RRF：Σ w_i / (k + rank_i)，k=60，0.6/0.4
缓存：m:s(user|scope|query|topk|filters|version)，m:e(model|text)，m:v(user)
TTL：300s / 7d / 30s，±10%
失效：version 进键，O(1)
并发：单写链 + 版本串行 + 乐观锁 + 幂等键
降级：keyword-only；不缓存降级；不混用来源
规模：万级进程内；千万级换外部索引
实测：语义 top1 100%，混合 top3 100%/top1 88%，embedding 25–50ms
```

---

## 14. 诚实边界

1. 语义基准只有 16 条记忆、8 条查询；
2. 混合 top1 88%，低于 semantic-only 100%；
3. KV 无跨记录事务，atomic 是尽力回滚；
4. 无 AES、无多租户鉴权、无公网部署；
5. 无同义词扩展、不扫描 Session 日志；
6. 无 Config 表单；
7. L3 默认关闭；
8. 进程内索引占内存，千万级需外部索引。

> 主动讲边界比被追问后补救更加分。
