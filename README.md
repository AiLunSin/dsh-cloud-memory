# dsh-cloud-memory

DSH（DeepSeek Harness）的跨会话记忆插件：语义 + 关键字混合检索、三层缓存、可插拔工具与 Web 管理页。

## 功能

- 跨会话持久化用户偏好、事实和项目决策
- BGE-M3 语义向量 + BM25 关键字双通道召回
- 加权 RRF 融合，支持权重、阈值、过滤条件
- L1 进程内存 → L2 本地文件 → L3 Redis 三层缓存
- 用户级 `index_version`，写后不脏读
- PII 脱敏、内容去重、幂等键、乐观锁、软/硬删除
- 3 个 Agent 工具：`memory_search` / `memory_write` / `memory_manage`
- Web 管理页：搜索、保存、编辑、删除、缓存与健康指标

## 仓库结构

```text
dsh-memory/          # 插件包（真正的 DSH bundle）
embedding-service/   # 可选的本地 BGE-M3 验证端点
PUBLISHING.md        # GitHub / npm 发布步骤
