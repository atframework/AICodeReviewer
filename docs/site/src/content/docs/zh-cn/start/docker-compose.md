---
title: Docker Compose 部署
description: Compose 栈的卷布局、健康检查、重启策略，以及 .env 与 config.yaml 的职责划分。
---

最快的类生产部署方式是 `example/` 中的 Compose 栈。本页在[快速上手](/zh-cn/start/quick-start/)基础上补充长期运行 AICR 所需的细节。非 Compose 的 Docker 运行参见 [Docker 部署](/zh-cn/deployment/docker/)。

## 栈持久化什么

Compose 文件以只读方式挂载 `config.yaml`，并持久化三个命名卷：

| 卷 | 挂载点 | 用途 |
| --- | --- | --- |
| `aicr-data` | `/app/data` | SQLite 队列 DB、运行历史、dashboard 统计、model-catalog 缓存 |
| `aicr-workspaces` | `/app/workspaces` | 各 workspace 的 `source/`、`agent/`、`tmp/` 目录及克隆仓库缓存 |
| `aicr-logs` | `/app/logs` | review run 日志 |

服务监听 `8080` 端口，在 `example/` 目录下用 `docker compose up -d` 启动。

## 健康检查与重启策略

栈内置对 `/healthz` 的 Compose 健康检查（标准的存活探针，返回纯文本 `ok`）：

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:8080/healthz"]
  interval: 30s
  timeout: 5s
  retries: 3
```

搭配重启策略，让容器从瞬时故障中恢复：

```yaml
restart: unless-stopped
```

:::note[使用 `--init` 运行]
如果你构建自定义 run 命令或镜像，请保留 `--init`（Podman 和 Docker 都支持）。它让一个 init 进程作为 PID 1 运行，回收那些逃出沙箱 kill 的 agent 子进程留下的僵尸。去掉 `--init` 最终会让评审退化为超时失败。Compose 文件和 `deploy/deploy.sh` 已包含它。
:::

## `.env` 与 `config.yaml` 的划分

划分很简单：**密钥放在 `.env`，其余放在 `config.yaml`**。

`.env` 持有原始密钥值，且永不提交：

```bash
# 入站：webhook HMAC 密钥（保护 /webhooks/*）
AICR_WEBHOOK_SECRET=7f3a...
AICR_GITHUB_WEBHOOK_SECRET=b2c1...

# 入站：API key（保护 /triggers/* 如 P4/SVN）
AICR_API_KEY=c6d7e8f9...

# 出站：AICR 调用外部服务
AICR_LLM_API_KEY=sk-...
AICR_GITEA_TOKEN=4b5d...
AICR_FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/...
AICR_FEISHU_SECRET=3Ob2...
```

`config.yaml` 持有非密钥配置，并引用环境变量**名**（永不写值）：

```yaml
triggers:
  - name: gitea
    kind: gitea
    webhook_secret_env: AICR_WEBHOOK_SECRET

llm:
  providers:
    - id: primary
      kind: openai_compatible
      api_key_env: AICR_LLM_API_KEY
```

完整的分层认证模型（webhook HMAC、server API key、workspace 级 API key）以及 dashboard 独立的管理员登录，参见[认证与密钥](/zh-cn/configuration/authentication/)。

## 启动后修改配置

`config.yaml` 和 `.env` 是挂载进容器的，不是烘焙进镜像的。修改任一文件后，重启容器即可——只有代码变更才需要完整重建镜像：

```bash
docker compose restart
```

## 验证栈

```bash
# 存活
curl http://localhost:8080/healthz

# 服务日志
docker compose logs -f
```

健康检查通过后，跑一次 [dry-run 评审](/zh-cn/start/dry-run/) 确认 LLM 凭据、agent 和沙箱配置正确，然后接入你的[第一个 webhook](/zh-cn/start/first-webhook/)。
