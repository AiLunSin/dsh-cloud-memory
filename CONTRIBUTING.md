# Contributing

感谢你愿意改进 `dsh-cloud-memory`。本仓库采用 MIT 许可证，欢迎使用、fork、二次开发和提交 PR。

## 可以先做什么

- 报告 bug 或使用问题（Issue）
- 改进文档、示例、错误提示
- 增加测试用例
- 优化检索、缓存、存储或 UI
- 提交与现有架构一致的扩展点实现

## 仓库结构

```text
dsh-memory/          # 插件包，真正的 DSH bundle
  lib/               # Host 侧业务代码
  client.js          # Web 页面
  test/              # 离线测试 + 语义基准
  docs/              # 使用说明
embedding-service/   # 可选的本地 BGE-M3 验证服务
PUBLISHING.md        # 发布说明
```

- 插件包在 `dsh-memory/`，不是仓库根目录。
- 根目录 `package.json` 是 workspace，不直接作为 DSH bundle 安装。

## 开发环境

要求：Node.js >= 22。

```bash
git clone https://github.com/AiLunSin/dsh-cloud-memory.git
cd dsh-cloud-memory
npm test
```

`npm test` 不需要真实 embedding 端点，覆盖：

- 写入/脱敏/去重/检索/缓存/CRUD
- Fetch 与 Node HTTP 接口
- 远端 embedding 降级、批量原子性、过滤、乐观锁
- L2 持久化、并发版本号、Redis mock
- embedding 批量分片

真实语义测试需要先启动 `embedding-service/`：

```bash
cd embedding-service
npm install --ignore-scripts --registry=https://registry.npmmirror.com
node prepare-sharp.mjs
node download-model.mjs
node server.mjs

# 另一个终端
cd dsh-memory
npm run test:semantic
```

## 隐私与敏感数据

**绝对不要提交以下内容：**

- `$DSH_HOME/storages/dsh_memory/` 下的真实记忆数据
- `$DSH_HOME/.credentials.yaml`、API Key、Token、Cookie
- `embedding-service/.cache/` 里的模型文件
- `node_modules/`、`.tmp/`、本地日志和缓存
- 真实用户的手机号、邮箱、证件号、公司内部数据

测试请使用合成数据；截图请先脱敏。`.gitignore` 已覆盖常见产物，但提交前仍需自己检查 `git status`。

## 提交 PR

1. Fork 仓库，从 `main` 创建分支：
   ```bash
   git checkout -b feat/your-change
   ```
2. 保持改动聚焦，一个 PR 解决一个问题。
3. 新增行为请补测试；修改配置/接口请同步文档。
4. 运行：
   ```bash
   npm test
   npm pack --dry-run
   ```
5. 提交 PR，说明：
   - 解决什么问题；
   - 如何验证；
   - 是否改变配置、数据格式或兼容性。

CI 会运行 Node 22/24 的离线测试和 `npm pack --dry-run`。CI 未通过前不会合并。

## 代码约定

- 使用 ESM（`"type": "module"`）。
- Host 侧尽量保持零运行时依赖；新增依赖需要说明理由。
- 不要为了让单测通过而跳过失败分支；先修根因。
- 不要在日志中打印正文、Token、手机号、邮箱等敏感内容。
- 涉及缓存、版本号、并发、降级的行为，必须补对应测试。
- UI 文本走 `client.js` 的 locale 字典，不要硬编码中文/英文到组件里。
- 新配置项走 `index.js` 的 `resolveConfig` 默认值和 `README` 文档。

## 扩展点

优先替换/实现这些边界，而不是改 `MemoryService` 的编排逻辑：

- `EmbeddingProvider`：接入 TEI / vLLM / OpenAI-compatible / 其他模型
- `VectorIndex`：换 pgvector / HNSW / Qdrant
- `KeywordIndex`：换 PostgreSQL tsvector / OpenSearch
- `CacheStore`：换 SQLite / Redis / 其他 KV
- `MemoryStore`：换共享存储后端

切换 embedding 模型必须保持维度一致，并执行：

```text
memory_manage action="reembed" force=true
```

## 发布与包名

- 官方包名是 `dsh-cloud-memory`。
- 二次开发请使用自己的包名或 scope，避免和上游冲突。
- 发布流程见根目录 `PUBLISHING.md`。
- 保留 MIT `LICENSE` 和版权声明；不要宣称是官方版本。

## 安全问题

请不要在公开 Issue 中披露漏洞细节或真实用户数据。报告方式见 [`SECURITY.md`](SECURITY.md)。

## 行为准则

保持尊重、就事论事。不接受骚扰、歧视、泄露他人隐私或提交恶意代码。
