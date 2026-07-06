---
title: 快速上手
description: 在本地或 Docker Compose 运行 AICodeReviewer，并触发第一次评审。
---

本指南介绍运行 AICodeReviewer (AICR) 最快的两种方式：[Docker Compose](#docker-compose)
适合类生产环境，[本地 Node.js](#本地-nodejs) 适合开发。选一种后，用
[健康检查](#验证服务是否运行)和[dry-run 评审](#dry-run-评审)验证。

## Docker Compose

`example/` 目录提供了开箱即用的 Compose 栈。

```bash
cd example/

# 1. 从示例创建 .env 并填入密钥
cp .env.sample .env
# 编辑 .env：设置 AICR_LLM_API_KEY、AICR_GITEA_TOKEN、AICR_WEBHOOK_SECRET

# 2. 编辑 config.yaml：设置 Gitea URL、仓库和模型

# 3. 构建并启动
docker compose up -d
```

Compose 文件以只读方式挂载 `config.yaml`，并持久化三个命名卷：
`aicr-data`（队列 DB、运行历史）、`aicr-workspaces`（克隆仓库缓存）、
`aicr-logs`。服务暴露在 `8080` 端口，并内置对 `/healthz` 的健康检查。

各文件职责：

- `example/.env` —— 所有密钥以环境变量形式存放。切勿提交此文件。参见
  [认证与密钥](/zh-cn/configuration/authentication/)。
- `example/config.yaml` —— 非密钥配置。只引用环境变量**名**
  （如 `api_key_env: AICR_LLM_API_KEY`），不写值。
- `example/docker-compose.yaml` —— 栈定义。

## 本地 Node.js

无需 Docker，适合开发或评估：

```bash
# 在仓库根目录：

# 1. 安装依赖并构建运行时包
pnpm install
pnpm build

# 2. 设置环境变量（一次性 source，或手动 export）
source example/.env

# 3. 启动服务
node packages/cli/dist/index.js serve \
  --config example/config.yaml \
  --port 8080
```

:::note[Windows PowerShell]
`pnpm`、`npx` 和 `.ps1` 脚本可能被默认执行策略阻止。直接调用 Node 工具即可：

```powershell
node node_modules/vitest/vitest.mjs run
node packages/cli/dist/index.js serve --config example/config.yaml --port 8080
```

:::

## 验证服务是否运行

服务启动后，确认健康端点可响应：

```bash
curl http://localhost:8080/healthz
# ok
```

`/healthz` 返回纯文本 `ok`，是标准的存活探针（也是 Compose 健康检查使用的端点）。
如果启用了可观测性 dashboard（config 中的 `admin.*`），访问
`http://localhost:8080/dashboard`。

## Dry-run 评审

在配置 webhook 之前，先对本地检出跑一次一次性评审，确认 LLM 和流水线健康。
Dry-run 不会发布任何输出。

```bash
export AICR_LLM_API_KEY=sk-xxx

node packages/cli/dist/index.js review \
  --config example/config.yaml \
  --repo "my-org/my-repo" \
  --provider gitea \
  --source-root . \
  --dry-run
```

关键参数：

- `--provider` —— config 中的 trigger provider 类型（`gitea`、`github`、
  `gitlab`、`p4`、`svn`）。
- `--source-root` —— 待评审的检出目录。
- `--dry-run` —— 准备并运行评审，但跳过所有输出通道。

如果 dry-run 成功，说明 LLM 凭据、agent 和沙箱都已正确配置。下一步，把 VCS
webhook 指向服务——见[第一个 Webhook 评审](/zh-cn/start/first-webhook/)。

## 下一步

- [认证与密钥](/zh-cn/configuration/authentication/) —— 在向 webhook 开放服务前，
  理解三层认证模型。
- [输出通道](/zh-cn/integrations/output-channels/) —— 评审结果发布到哪里。
- [VCS 提供商](/zh-cn/integrations/vcs-providers/) —— 各提供商的 webhook 和
  trigger 配置。
