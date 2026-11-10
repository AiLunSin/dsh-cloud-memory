# 项目摘要

> 项目：`dsh-cloud-memory`  
> 类型：DeepSeek Harness 跨会话记忆插件  
> 版本：1.0.0（MIT）  
> 仓库：`https://github.com/AiLunSin/dsh-cloud-memory`

---

## 中文摘要

针对大语言模型对话在跨会话场景下缺乏持久记忆、长对话 token 成本高、单一关键字检索无法处理同义改写的问题，本项目设计并实现了一个面向 DeepSeek Harness 的可插拔云端记忆插件 `dsh-cloud-memory`。插件以 Harness Host 插件形式运行，将对话中的稳定事实、用户偏好和项目决策持久化到宿主存储，并在回答前通过“语义向量 + BM25 关键字”双通道召回，使用加权 Reciprocal Rank Fusion（RRF）融合两路结果。

系统实现了完整的写入与检索流水线：写入侧依次完成文本归一化、PII 脱敏、内容哈希去重、关键字抽取、1024 维 embedding 生成、持久化和用户级索引版本递增；检索侧依次完成查询归一化、版本号读取、三级缓存查询、singleflight 并发合并、向量与关键字并行召回、RRF 融合、阈值过滤和 top-k 截断。为降低延迟与重复计算，设计了 L1 进程 LRU、L2 本地 JSON 文件、L3 可选 Redis 的三层缓存，并以 `index_version` 作为缓存失效锚点，使写后旧缓存物理不可读。插件同时提供 3 个 Agent 工具、REST API 和 Web 管理页面，支持记忆 CRUD、软删除、批量写入、幂等键、乐观锁、TTL、审计和缓存指标。

在真实 BGE-M3（1024 维量化 ONNX）端点上的小规模可复现评测中，语义单路在 8 条查询上 top1/top3 达到 100%/100%，MRR 为 1.000；关键字单路 top1 为 50%；混合检索 top3 为 100%，top1 为 88%，并定位出 RRF 双通道加分导致的唯一排序偏差。单条查询 embedding 约 25–50ms，检索未命中约 46ms，L1 命中低于 1ms。项目包含 7 组离线测试和 1 组真实语义基准测试，`npm test` 全部通过；同时完成了 GitHub 发布所需的包元数据、MIT 许可证、变更日志、CI、文档与本地 Git 仓库/tag 准备。

**关键词**：DeepSeek Harness；持久记忆；混合检索；BGE-M3；BM25；RRF；三层缓存；插件化

---

## English Abstract

Large language model conversations lose context across sessions, repeat user preferences, and waste tokens on long histories. This project implements `dsh-cloud-memory`, a pluggable cross-session memory plugin for DeepSeek Harness. It persists durable facts, preferences, and decisions, and recalls them through hybrid semantic-vector and BM25 keyword retrieval fused with weighted Reciprocal Rank Fusion (RRF).

The write pipeline performs normalization, PII masking, content-hash deduplication, keyword extraction, 1024-dimensional embedding, durable storage, and per-user index-version increment. The search pipeline performs query normalization, version-aware cache lookup, singleflight coalescing, parallel vector and keyword retrieval, RRF fusion, threshold filtering, and top-k truncation. A three-tier cache (in-process LRU, local JSON file, optional Redis) reduces latency and repeated embedding work; the per-user `index_version` makes stale cache entries unreachable after writes. The plugin exposes three agent tools, a REST API, and a Web management page, with CRUD, soft delete, batch writes, idempotency keys, optimistic locking, TTL, audit records, and cache metrics.

On a reproducible small benchmark using a real BGE-M3 (1024-d quantized ONNX) endpoint, semantic-only retrieval achieved 100% top-1/top-3 and 1.000 MRR; keyword-only achieved 50% top-1; hybrid retrieval achieved 100% top-3 and 88% top-1. Single-query embedding latency was 25–50 ms, retrieval miss latency about 46 ms, and L1 hits below 1 ms. Seven offline test suites and one semantic benchmark are included; `npm test` passes.

**Keywords**: DeepSeek Harness; persistent memory; hybrid retrieval; BGE-M3; BM25; RRF; three-tier cache; plugin

---

## 关键结果

| 指标 | 结果 |
| --- | --- |
| 语义单路 top1 / top3 / MRR | 100% / 100% / 1.000 |
| 关键字单路 top1 / top3 / MRR | 50% / 100% / 0.729 |
| 混合 top1 / top3 / MRR | 88% / 100% / 0.938 |
| BGE-M3 单条 embedding | 25–50ms（CPU 量化 ONNX） |
| 检索未命中 | 约 46ms |
| L1 缓存命中 | <1ms |
| 离线测试 | 7 组，`npm test` exit 0 |
| npm 包 | `dsh-cloud-memory@1.0.0`，约 64.5KB |

评测限制：16 条记忆、8 条查询、8 个关键词干扰项，属于可复现的小规模基准，不代表生产全量效果。

---

## 主要工作

1. 将技术方案中的 FastAPI 服务收敛为 DSH Host 插件，保留可替换的存储、检索、缓存和 embedding 边界。
2. 实现“归一化 → PII 脱敏 → 哈希去重 → 关键字抽取 → embedding → 持久化 → 版本递增”的写入流水线。
3. 实现“查询归一化 → 版本读取 → 三级缓存 → singleflight → 向量/BM25 并行 → 加权 RRF → top-k”的检索流水线。
4. 以 `index_version` 作为缓存失效锚点，避免遍历删除和写后脏读。
5. 实现 L1/L2/L3 缓存、TTL 抖动、负缓存、singleflight、LRU/TTL 淘汰和指标统计。
6. 实现 PII 脱敏、内容去重、幂等键、乐观锁、软/硬删除、TTL、审计和批量写入。
7. 接入真实 BGE-M3 端点，增加 `embedSource` 来源隔离和 `reembed force=true` 全量重算，避免不同向量空间混算。
8. 提供 3 个 Agent 工具、REST API 和 Web 管理页，三者共用同一套业务服务。
9. 完成 7 组离线测试、1 组真实语义基准、GitHub 发布元数据、CI、许可证、文档和本地 Git 仓库/tag。

---

## 交付物与当前状态

| 项 | 状态 |
| --- | --- |
| 插件源码 | 已完成，位于 `dsh-memory/` |
| BGE-M3 端点服务 | 已完成，位于 `embedding-service/` |
| 使用说明 | [`docs/USAGE.md`](USAGE.md) |
| 答辩/面试手册 | [`docs/DEFENSE.md`](DEFENSE.md) |
| 架构说明 | [`../README.md`](../README.md) |
| 发布流程 | 仓库根目录 `PUBLISHING.md` |
| 许可证/变更日志 | MIT / `CHANGELOG.md` |
| CI | `.github/workflows/ci.yml` |
| 本地 Git | `main` 分支、`v1.0.0` tag、origin 已配置 |
| GitHub 远程 | **尚未 push**，需创建空仓库后推送 |
| 真实截图 | 待从 GUI 补拍（当前无浏览器控制） |
| npm 发布 | **尚未 publish**，已完成 `npm publish --dry-run` |

---

## 待完成事项

1. 在 GitHub 创建空仓库 `AiLunSin/dsh-cloud-memory`，推送 `main` 和 `v1.0.0`。
2. 基于 tag 创建 Release。
3. 补 2–3 张真实 Web 页面截图/GIF。
4. 如要上架 DSH 官方索引，再补 npm publish、clean profile 安装验证和索引条目。

---

## 30 秒汇报稿

> 这个项目解决的是 LLM 跨会话没有记忆的问题。我在 DeepSeek Harness 里实现了一个可插拔记忆插件：写入时做 PII 脱敏、去重、关键字抽取和 BGE-M3 向量化；检索时并行走向量和 BM25，用 RRF 融合；外面用三层缓存加用户级版本号保证写后不脏读。真实 BGE-M3 小基准上语义 top1 是 100%，混合 top3 也是 100%。项目有 7 组测试、完整文档、MIT 许可证和 GitHub 发布准备。

---

## 一分钟汇报稿

> 这个项目的目标是给 DeepSeek Harness 增加跨会话的持久记忆，同时控制延迟和成本。架构上我把它做成 Host 插件，而不是额外起 FastAPI 服务；存储用 Harness 的 KV，语义索引和 BM25 放在进程内，BGE-M3 通过可替换的 endpoint 接入。
>
> 写入链路是：归一化、PII 脱敏、内容哈希去重、关键字抽取、1024 维向量化、持久化、版本号加一。检索链路是：读用户版本号、查 L1/L2/L3 缓存、singleflight、并行走向量和 BM25、加权 RRF、阈值过滤和 topk。缓存键里带 `index_version`，所以写后旧缓存不可达，不需要遍历删缓存。
>
> 实测方面，真实 BGE-M3 单条 embedding 约 25–50ms，检索未命中约 46ms，L1 命中低于 1ms。16 条语料的小基准上，语义 top1 100%，关键字 50%，混合 top3 100%、top1 88%；唯一 top1 失手是 RRF 双通道加分，不是向量质量问题。项目有 7 组离线测试、真实语义基准、完整使用/答辩文档，以及 MIT 许可证和 GitHub 发布准备。
