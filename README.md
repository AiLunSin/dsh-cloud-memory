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
```

## 安装

在 DSH Plugin Manager 中选择仓库内的 `dsh-memory/` 目录，或使用本地路径安装。

- 完整说明：`dsh-memory/docs/USAGE.md`
- 插件技术细节：`dsh-memory/README.md`
- 发布步骤：`PUBLISHING.md`

## 测试

```bash
npm test
```

真实语义质量测试需要先启动 `embedding-service/`，再运行：

```bash
npm run test:semantic
```

## 状态

- 插件包：`dsh-cloud-memory@1.0.0`
- 离线测试：7 组通过
- 真实 BGE-M3 基准：语义 top1 100%，混合 top3 100%
- npm：尚未发布；目前从 GitHub/本地安装
- License：MIT
