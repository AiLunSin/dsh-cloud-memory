# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| `1.x` / `main` | ✅ |
| older tags | 尽力协助，不保证修复 |

安全问题优先在最新 `main` 上验证和修复。

## 报告漏洞

请使用 GitHub 的私密漏洞报告：

1. 打开仓库 **Security** 标签；
2. 选择 **Report a vulnerability**（GitHub Private Vulnerability Reporting）；
3. 提供：影响版本、复现步骤、影响范围、最小 PoC；不要附带真实用户数据。

如果私密报告不可用，请先开一个**不含漏洞细节**的 Issue，说明“需要安全联系方式”，维护者会跟进。不要在公开 Issue 中贴 Token、真实记忆、用户隐私或可直接利用的 PoC。

处理目标：3 个工作日内确认收到，后续修复时间取决于影响范围和复现难度。这是开源项目的尽力而为，不构成商业 SLA。

## 安全模型与边界

`dsh-cloud-memory` 当前是**单用户、本机优先**的 DSH 插件：

- HTTP API 只接受 loopback 连接，并校验 Origin 与 `application/json`；
- 没有多租户鉴权、没有公网暴露能力、没有 AES 列加密；
- 记忆数据存放在 `$DSH_HOME/storages/dsh_memory/`，默认依赖宿主机磁盘权限和磁盘加密；
- PII 脱敏是“降低风险”，不是“允许保存秘密”；不要保存密码、完整 API Key、私钥；
- L3 Redis 是可选组件；使用 `rediss://` 或受信网络，不要暴露公网 Redis；
- embedding endpoint 由部署者配置，属于受信上游；不要把不可信用户输入直接当作 endpoint URL；
- `plugin_manager` 安装的 Host 代码在 Harness 进程内执行，拥有较高权限；只安装可信 bundle。

## 部署建议

- 每个用户使用自己的 DSH profile / `$DSH_HOME`，不要多人共用同一份记忆目录；
- 不要把 `8090`、`56540` 或 Redis 端口直接暴露到公网；
- 需要跨设备/多人共享时，先补鉴权、租户隔离、加密和服务端部署，不要直接把当前插件暴露出去；
- embedding API Key 用环境变量/凭据服务注入，不要写进 `cordis.patch.yml` 或仓库；
- 定期备份 `$DSH_HOME/storages/dsh_memory/`，备份文件按敏感数据管理；
- 卸载不会自动删除记忆数据，退役设备时手动清理；
- 开启 GitHub 分支保护、依赖更新和 Actions 权限最小化。

## 供应链

- Host 插件运行时尽量保持零外部依赖；
- `embedding-service/` 的依赖仅用于本地验证，不属于插件运行时；
- 提交 PR 时不要引入未知来源的二进制、模型或安装脚本；
- 发布前执行 `npm pack --dry-run`，确认包内没有测试数据、模型、缓存或凭据。

## 已知限制

- 当前没有真正的多租户认证与授权；
- 没有应用层字段加密；
- 没有内置速率限制和 WAF；
- 没有对恶意 embedding 端点返回值的完整性校验（只做维度和格式检查）；
- 进程内索引和缓存会占用内存，超大记忆库需要换外部索引。

这些限制在 [`dsh-memory/README.md`](dsh-memory/README.md) 和 [`dsh-memory/docs/USAGE.md`](dsh-memory/docs/USAGE.md) 中有说明。部署者需要自行评估风险。

## 披露

修复发布后，会在 GitHub Security Advisory 或 Release Notes 中说明影响版本和升级建议。感谢负责任披露。
