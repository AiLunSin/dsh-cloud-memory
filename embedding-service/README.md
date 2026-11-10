# dsh-memory embedding service

本地 **BGE-M3**（1024 维，ONNX 量化版）HTTP 端点，用于验证 `dsh-memory` 的语义检索质量。模型来自 ModelScope 的 `Xenova/bge-m3`，与 `@xenova/transformers` 兼容。

## 启动

```powershell
npm install --ignore-scripts --registry=https://registry.npmmirror.com
node prepare-sharp.mjs
node download-model.mjs
node server.mjs
```

- `--ignore-scripts` 避免 `sharp` 的本地编译/下载；本服务只做文本 embedding，`prepare-sharp.mjs` 会放置一个不会被调用的 `sharp` stub。
- `download-model.mjs` 从 ModelScope 下载约 570MB 的量化 ONNX 模型到 `.cache/Xenova/bge-m3/`。
- `server.mjs` 默认监听 `127.0.0.1:8090`，可用 `EMBEDDING_PORT` / `EMBEDDING_HOST` 覆盖。

## 接口

```text
GET  /health
POST /embed  {"inputs": ["文本1", "文本2"]}
     -> {"embeddings": [[...1024...], ...], "dim": 1024, "latency_ms": 123}
```

## 与插件联调

在 `dsh-memory` 的 `cordis.patch.yml` 配置行：

```yaml
- id: dsh-memory
  config:
    embedding:
      provider: tei
      baseUrl: http://127.0.0.1:8090
      model: BAAI/bge-m3
      dim: 1024
      timeoutMs: 60000
    retrieval:
      channelTimeoutMs: 60000
```

CPU 上量化模型单条查询约几十到几百毫秒；首轮加载约数十秒。GPU 部署可换用 TEI / vLLM，插件侧配置不变。

## 语义质量测试

```powershell
cd ..\dsh-memory
npm run test:semantic
```

测试会写入 16 条带干扰项的语料，比较 semantic-only、keyword-only 与两种 RRF 权重的 top1/top3/MRR。
