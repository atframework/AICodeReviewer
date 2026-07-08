# AICR 开发指导手册与任务提示

本文件是面向本仓库维护者的**任务与部署备忘**，不是仓库全局常驻指令。

AI agent 开始工作时仍应优先遵守 `AGENTS.md`，并按任务类型读取相关 `.agents/skills/*/SKILL.md`。

**要求所有的任务都要深度调研后制定方案，不要瞎猜，按需更新文档、AI agent提示词、skill、example和Plan.md，保持最佳实践。**

## 1. 使用原则

- 所有任务先深度调研再制定方案：读取 `AGENTS.md`、相关 skill、相关源码/测试/文档，必要时查官方资料；不要凭记忆猜实现、配置或环境状态。
- 方案中显式写清目标、约束、假设、验收方式，以及是否需要同步文档、AI agent 提示词、skill、example 和 `Plan.md`；如果无需同步，也要说明原因。
- 输出给人或写入文档时按主题分段；不要把历史背景、secret、部署步骤混进同一段自由文本。
- `Plan.md` 只作为当前路线图入口；需要稳定设计或历史阶段信息时，先读 `docs/ai/index.md`，再按需打开对应文档。
- 修改代码时优先补测试；修改配置、输出通道、部署行为或公开工作流时，同步更新 `Plan.md` 摘要、相关 `docs/`、`example/config.yaml` 与 `example/README.md`，或明确说明无需更新。
- 临时脚本、调试日志和一次性报告放在 `build/` 子目录下（如 `build/tmp/`、`build/logs/`），不放仓库根目录。运行前确保子目录存在。
- 只验证本轮新增或修复的能力；测试验收环境按第 8 节选择，生产签收仍以 Kilo Code 端到端验收为准。

## 2. 常用任务提示

### CodeReview

请分析当前路线图、相关架构文档和当前阶段代码实现，定位问题并修复；尽可能补齐单元测试。

执行顺序：

1. 读取 `AGENTS.md`、相关 skill，以及 `docs/ai/index.md`。
2. 读取 `Plan.md` 的当前里程碑状态和下一执行包。
3. 按需读取 `docs/ai/architecture.md`、专题文档和相关源码/测试。
4. 制定小步可验证方案。
5. 修改代码、测试、文档和示例。
6. 按仓库验证顺序运行必要检查。

### 文档或 AI 资产维护

当任务涉及 prompt、skill、bridge 文件、`AGENTS.md`、`Plan.md`、`docs/ai/*` 或类似 AI-facing 资产时：

1. 先读取 `AGENTS.md` 与 `.agents/skills/ai-agent-maintenance/SKILL.md`。
2. 保持常驻指令短小，长篇稳定细节放入 `docs/ai/index.md` 可导航的文档。
3. 已完成阶段写入 `docs/ai/milestones/*.md`，不要回填到 `Plan.md` 或 skill 正文。
4. 修改后至少运行 markdownlint；若同时改到代码或配置，按完整验证链执行。

## 3. Secret 与凭据安全

- 永远不要打印 `development/secret/*`、、`.env` 或任何完整 secret 文件或配置文件中的secret信息。
- 只用 `yq -r '<json-path>' development/secret/secret.yaml` 提取当前步骤需要的单个值，并直接赋给变量或环境变量。
- 不要把 token、签名密钥、API key 发送给 LLM、日志系统、issue、PR 评论或 IM 输出。
- 如果终端输出、debug log 或报告中可能包含 secret，只说明风险和清理/轮换建议，不复述 secret 原文。
- 命令示例必须使用占位变量；不要把真实值写进文档、脚本或 prompt。

示例模式：

```bash
LLM_BASE_URL="$(yq -r '.llm.provider.xiaomimimo_token_plan.baseURL' development/secret/secret.json)"
LLM_TOKEN="$(yq -r '.llm.provider.xiaomimimo_token_plan.token' development/secret/secret.json)"
```

## 4. Secret selector 速查

### LLM 默认 selector

| 用途    | selector                            |
| ------- | ----------------------------------- |
| baseURL | `.llm.provider.kimi_coding.baseURL` |
| token   | `.llm.provider.kimi_coding.token`   |

### 生产模型优先级

| 顺序 | baseURL selector                                 | token selector                                 | 模型              |
| ---- | ------------------------------------------------ | ---------------------------------------------- | ----------------- |
| 1    | `.llm.provider.zhipu.baseURL`                    | `.llm.provider.zhipu.token`                    | `glm-5.2`         |
| 2    | `.llm.provider.kimi_coding.baseURL`              | `.llm.provider.kimi_coding.token`              | `kimi-for-coding` |
| 3    | `.llm.provider.aliyun_coding_plan.baseURL`       | `.llm.provider.aliyun_coding_plan.token`       | `glm-5`           |
| 4    | `.llm.provider.tencentcloud_coding_plan.baseURL` | `.llm.provider.tencentcloud_coding_plan.token` | `glm-5`           |
| 5    | `.llm.provider.aliyun_coding_plan.baseURL`       | `.llm.provider.aliyun_coding_plan.token`       | `kimi-k2.5`       |
| 6    | `.llm.provider.tencentcloud_coding_plan.baseURL` | `.llm.provider.tencentcloud_coding_plan.token` | `kimi-k2.5`       |
| 7    | `.llm.provider.aliyun_coding_plan.baseURL`       | `.llm.provider.aliyun_coding_plan.token`       | `qwen3.6-plus`    |

### VCS 与输出 selector

| 系统               | 字段               | selector                                          |
| ------------------ | ------------------ | ------------------------------------------------- |
| Gitea              | token              | `.integration.gitea.token`                        |
| Gitea              | webhook secret     | `.integration.gitea.webhook_secret`               |
| Gitea              | watch path         | `.integration.gitea.watch_path`                   |
| Gitea              | include files      | `.integration.gitea.include_cr_file`              |
| Gitea              | exclude files      | `.integration.gitea.exclude_cr_file`              |
| GitHub App (atframework/owent) | app_id             | `.integration.github-app-aicr.app_id`                        |
| GitHub App (atframework/owent) | client_id          | `.integration.github-app-aicr.client_id`                     |
| GitHub App (atframework/owent) | private key file   | `.integration.github-app-aicr.private_key_file`              |
| GitHub App (atframework/owent) | webhook secret     | `.integration.github-app-aicr.webhook.secret`                  |
| GitHub atframework | watch path         | `.integration.github-atframework.watch_path`                   |
| GitHub atframework | include files      | `.integration.github-atframework.include_cr_file`              |
| GitHub atframework | exclude files      | `.integration.github-atframework.exclude_cr_file`            |
| GitHub owent       | watch path         | `.integration.github-owent.watch_path`                         |
| GitHub owent       | include files      | `.integration.github-owent.include_cr_file`                    |
| GitHub owent       | exclude files      | `.integration.github-owent.exclude_cr_file`                    |
| P4                 | username           | `.integration.p4.username`                        |
| P4                 | password           | `.integration.p4.password`                        |
| P4                 | depot path         | `.integration.p4.depot_path`                      |
| P4                 | port               | `.integration.p4.port`                            |
| P4                 | analysis workspace | `.integration.p4.workspace`                       |
| P4                 | watch path         | `.integration.p4.watch_path`                      |
| P4                 | include files      | `.integration.p4.include_cr_file`                 |
| P4                 | exclude files      | `.integration.p4.exclude_cr_file`                 |
| Feishu robot       | webhook            | `.channel.feishu_robot.webhook`                   |
| Feishu robot       | token              | `.channel.feishu_robot.token`                     |
| 企业微信 robot     | webhook            | `.channel.wxwork_robot.webhook`                   |
| AICR server        | global API key     | `.aicr.server.api_key`                            |

### GitHub repo → selector / trigger / workspace 映射

| GitHub 仓库             | 本地 selector 组     | 远端 trigger         | 远端 workspace        | 说明                                                                 |
| ----------------------- | -------------------- | -------------------- | --------------------- | -------------------------------------------------------------------- |
| `atframework/atsf4g-co` | `github-atframework` | `github-atframework` | `github-atsf4g-co`    | 使用统一 GitHub App `atframework-aicr` 认证；文件过滤保持独立 |
| `owent/libatapp`        | `github-owent`       | `github-owent`       | `github-libatapp`     | 使用统一 GitHub App `atframework-aicr` 认证；文件过滤保持独立 |
| `owent/hiredis-happ`    | `github-owent`       | `github-owent`       | `github-hiredis-happ` | 使用统一 GitHub App `atframework-aicr` 认证；文件过滤保持独立 |

- `/webhooks/github` 现在允许挂多个 GitHub trigger profile；服务端会先按 webhook secret 校验，再按 `repository.full_name` 选择最终 trigger。
- 不同 GitHub 仓库若使用不同的 `watch_path`、`include_cr_file`、`exclude_cr_file`，仍可继续复用同一个 App 认证，但应使用独立 trigger 保证过滤规则隔离。
- 远端 `.env` 统一使用 GitHub App 凭据：`AICR_GITHUB_APP_PRIVATE_KEY`（base64 PEM）和 `AICR_GITHUB_APP_WEBHOOK_SECRET`；旧的 `GITHUB_ATFRAMEWORK_*`/`GITHUB_OWENT_*` PAT 变量已移除。禁止互相复用或打印原文。
- 已确认 `owent/hiredis-happ` 已加入 `owent` 账号的 App 已选仓库。

## 5. P4 操作边界

- P4 拉取必须保持最小范围，只拉取本次 review 必需文件，不做全仓库拉取。
- P4 trigger 当前通过 AICR API Key 保护；`p4.webhook_secret` 为预留项。
- P4 trigger 脚本：`example/p4-trigger.sh`。
- 运行 trigger 时使用环境变量：
  - `AICR_URL=<部署环境入口URL>`
  - `AICR_API_KEY` 通过 selector 提取并注入环境变量
  - `AICR_DEPOT_PATH` 通常可省略，默认使用服务端 `config.yaml` 的 P4 trigger `depot_path`
- 只有一个脚本需要覆盖服务端 depot 配置时，才设置 `AICR_DEPOT_PATH`。

## 6. 验收要求

### Kilo Code 生产签收

- 部署测试必须使用 **Kilo Code** 做至少一次完整端到端验证，确认真实 agent 路径可用，而不是只验证 direct LLM / `native-llm` 路径。
- `example/config.yaml` 的默认验收路径应保持 `agent.default: kilo`。
- Kilo CLI 可作为自动化烟测补充，但不能替代 Kilo Code 人工确认。
- 验收至少覆盖：触发入口（Gitea webhook 或 P4 trigger）→ VCS 最小拉取 / diff → Kilo agent → AICR MCP 工具提交 problem/summary → 输出通道（PR/MR/Issue/飞书/企微）。
- 在 Kilo `.kilo/mcp.json` 与外部 `aicr-output` stdio/HTTP MCP 服务补齐前，Kilo 验收只能算 agent/stdout tool-call 兼容路径通过，不能关闭外部 MCP 服务验收项。
- 生产发布前若 Kilo Code 无法完成 MCP 工具调用或输出发布，视为部署未通过。

### 本轮功能验证

- 不需要每次都全部重新验证；重点验证本轮新增功能、修复路径和受影响输出通道。
- 选择测试验收环境时按第 8.1 节执行；不要因为远程测试环境已知就跳过本地容器或 WSL2 能力探测。
- 文档-only 变更至少运行 markdownlint；若会影响镜像或部署包，仍需验证服务健康检查。
- 代码或配置变更按 `AGENTS.md` 默认验证顺序执行。

### Health check

远程服务地址：`<部署环境入口URL>`（反向代理到 `http://10.64.8.2:8090`）。

```bash
curl -sf <部署环境入口URL>/healthz
# 预期输出: ok
```

## 7. 远程部署备忘

### 7.1 公网正式环境

- 远程服务器：内网ip `10.0.4.9` , 公网ip: `42.192.55.130`（公网域名 `aicr.x-ha.com`）
- SSH 用户：通过 `yq '.deploy.normal.ssh.user' development/secret/secret.yaml` 提取
- SSH 端口：通过 `yq '.deploy.normal.ssh.port' development/secret/secret.yaml` 提取
- SSH key：通过 `yq '.deploy.normal.ssh.key_file' development/secret/secret.yaml` 提取文件名（该值是远程主机路径；本地部署用同名私钥的本地镜像副本）
- **部署目录**：`/home/tools/AICodeReviewer`
- 容器引擎：Podman
- 反向代理：<部署环境入口URL> → `http://10.0.4.9:8090`
- 如果公网机本机监听了 TCP `3128`，`deploy.sh` 会自动探测这个 HTTP 代理并用于宿主下载与镜像构建；详细规则见下文“关于构建期 HTTP 代理”。

### 7.2 内网公共环境

- 远程服务器：`10.64.8.2`
- SSH 用户：`tools`
- SSH 端口：`36000`
- SSH key：`D:/workspace/keys/id_ed25519.it`
- **生产部署目录**：`/data/disk2/AICodeReviewer`
- **测试验收目录**：`/data/disk2/AICodeReviewerTest`（与生产完全隔离）
- 容器引擎：Podman
- 反向代理：`https://aicr.m-oa.com:6023` → `http://10.64.8.2:8090`

### 7.3 镜像源配置（国内部署必填）

构建镜像时默认使用 `ubuntu:24.04` + 官方 `node:22-bookworm-slim`
userspace。国内环境建议切换 Ubuntu apt、Kubernetes apt、npm、PyPI/pip
和 Docker static 下载源；如果目标机已经统一配置容器 registry mirror，通常
不必单独设置 `NODE_IMAGE`，只有需要覆盖默认拉取策略时再显式指定。
这样既能保留官方 Perforce Ubuntu APT 支持，又避免因切回 Alpine /
Wolfi 而失去 `p4-cli` 的可安装性。

`deploy.sh` 与 `Dockerfile` 读取以下环境变量：

| 环境变量                      | 用途                                  | 默认值                                                         | 国内/镜像建议                                                      |
| ----------------------------- | ------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `BASE_IMAGE`                  | Ubuntu 24.04 兼容基础镜像             | `ubuntu:24.04`                                                 | 保持默认，或替换为自建/缓存的 Ubuntu 24.04 mirror                  |
| `NODE_IMAGE`                  | Node 22 userspace 来源镜像            | `node:22-bookworm-slim`                                        | 默认不设置；如需显式覆盖，再填镜像仓库地址                         |
| `APT_MIRROR`                  | Ubuntu apt 包源                       | （使用镜像内置源）                                             | `http://mirrors.ustc.edu.cn/ubuntu`                                |
| `PERFORCE_APT_DISTRO`         | Perforce apt 仓库发行版代号           | `noble`                                                        | `noble`                                                            |
| `NPM_REGISTRY`                | pnpm/npm registry                     | `https://registry.npmjs.org`                                   | `http://mirrors.tencent.com/npm/`                                  |
| `NPM_STRICT_SSL`              | npm strict-ssl                        | `true`                                                         | `false`（HTTP 镜像必须）                                           |
| `PIP_INDEX_URL`               | Python pip simple index               | `https://pypi.org/simple`                                      | `https://mirrors.tencent.com/pypi/simple`                          |
| `PIP_TRUSTED_HOST`            | pip HTTP/私有源信任主机               | （空）                                                         | 使用 HTTPS 的腾讯源时留空                                          |
| `KUBERNETES_APT_REPO_BASE`    | `kubectl` APT 源 base                 | `https://pkgs.k8s.io/core:/stable:`                            | `https://mirrors.tencent.com/kubernetes_new/core:/stable:`         |
| `KUBERNETES_APT_REPO_VERSION` | `kubectl` minor 版本源                | `v1.36`                                                        | 需与集群 minor 相差不超过 1；例如 `v1.36`                          |
| `HELM_APT_REPO`               | Helm Debian/Ubuntu apt 源             | `https://packages.buildkite.com/helm-linux/helm-debian/any/`   | 腾讯源未提供 Helm 专用镜像；保留默认或替换为内部缓存               |
| `HELM_APT_KEY_URL`            | Helm apt signing key                  | `https://packages.buildkite.com/helm-linux/helm-debian/gpgkey` | 与 `HELM_APT_REPO` 的内部缓存配套                                  |
| `YQ_VERSION`                  | Mike Farah `yq` 版本                  | `v4.53.2`                                                      | 按需固定                                                           |
| `YQ_DOWNLOAD_BASE`            | `yq` GitHub release 下载根路径        | `https://github.com/mikefarah/yq/releases/download`            | 腾讯源未提供 yq 专用镜像；保留默认或替换为内部缓存                 |
| `DOCKER_DOWNLOAD_MIRROR`      | Docker 静态二进制下载（容器嵌套沙箱） | `https://download.docker.com/linux/static/stable/x86_64`       | `https://mirrors.tencent.com/docker-ce/linux/static/stable/x86_64` |

> **关于 `BASE_IMAGE`**：默认使用 `ubuntu:24.04`，因为官方 Perforce 包仓库支持 Ubuntu APT，且 `p4-cli` 不适合依赖 Alpine / Wolfi / 非 glibc 发行版。`BASE_IMAGE` 只建议替换为 Ubuntu 24.04 的镜像仓库地址，不建议再切回 Alpine / Chainguard / Wolfi。
>
> **关于 `NODE_IMAGE`**：如果目标机已经在 Podman/Docker 侧统一配置了容器 registry mirror，保持默认 `node:22-bookworm-slim` 即可，不必在每次部署时额外导出 `NODE_IMAGE`；只有需要按任务覆盖拉取源时再显式设置。
>
> **关于 `APT_MIRROR`**：`deploy.sh` 仍接受旧的 `APK_MIRROR` 变量作为兼容别名，但新文档统一使用 `APT_MIRROR`。当前国内示例改为使用 USTC 的 HTTP Ubuntu 镜像：`amd64/i386` 使用 `http://mirrors.ustc.edu.cn/ubuntu`，其他架构按 USTC `ubuntu-ports` 文档改为 `http://mirrors.ustc.edu.cn/ubuntu-ports`。Dockerfile 会在首次 `apt-get update` 之前同时兼容替换 `archive.ubuntu.com`、`security.ubuntu.com` 与 `ports.ubuntu.com/ubuntu-ports`（含 `sources.list` / `ubuntu.sources` 两种格式），因此不再需要先回官方源安装 `ca-certificates`。
>
> **关于额外企业 CA**：如果目标机通过企业代理或本地缓存访问外部 HTTPS 仓库（例如 `package.perforce.com`、Helm Buildkite 源或 GitHub release），请把目标机 `/usr/local/share/ca-certificates/*.crt` 复制到构建上下文的 `deploy/extra-ca/`。Dockerfile 会在联网前把这些额外根证书安装进镜像信任链。
>
> **关于 `PIP_INDEX_URL`**：Dockerfile 会把该值写入 `/etc/pip.conf` 并设置 `PIP_INDEX_URL` 环境变量；腾讯 PyPI 镜像必须包含 `/pypi/simple` 路径。
>
> **关于 Kubernetes/Helm/yq**：Dockerfile 使用官方 Kubernetes apt 源安装 `kubectl`，国内示例切换到腾讯 `kubernetes_new`；Helm 官方文档当前列出的 Debian/Ubuntu apt 源由 Buildkite 托管，Mike Farah `yq` 官方建议下载预编译二进制。腾讯镜像站已验证没有 `/helm/` 与 `/yq/` 专用入口，如需全内网构建，请用内部缓存覆盖 `HELM_APT_REPO`、`HELM_APT_KEY_URL` 与 `YQ_DOWNLOAD_BASE`。
>
> **关于 Podman socket**：运行时镜像现在内置 `podman` CLI，并继续支持可选 Docker static CLI。`AICR_ENABLE_CONTAINER_SANDBOX=true` 时，`deploy.sh` 会挂载宿主 Podman socket，同时设置 `CONTAINER_HOST`（Podman 原生客户端）和 `DOCKER_HOST`（Docker 兼容客户端）。容器内不需要启动 Podman daemon；真正创建/管理子容器的是宿主 Podman socket。
>
> **关于 `DOCKER_DOWNLOAD_MIRROR`**：仅当 `AICR_ENABLE_CONTAINER_SANDBOX=true` 且需要 Docker 兼容 CLI 时才需要下载 Docker 静态二进制；使用 `sandbox.kind: podman`/`engine: podman` 可直接走镜像内置 Podman CLI。
>
> **关于构建期 HTTP 代理**：`deploy.sh` 会优先使用已显式导出的 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`（或对应小写变量）。如果这些变量都没有设置，但部署宿主机正在监听 TCP `3128`，脚本会自动探测该代理并把宿主侧下载（例如 Docker static CLI）以及 `podman build` / `docker build` 的联网步骤切到 `http://<宿主机IP或域名>:3128`。如果代理只绑定到 loopback（如 `127.0.0.1:3128`），脚本会在构建时临时切换到 `--network=host`，保证 Dockerfile 中的 `apt`、`curl`、`npm`、`pip`、`yq` 下载同样能命中这个代理，而不会把代理地址永久写进最终镜像。

国内部署完整示例：

```bash
export BASE_IMAGE=ubuntu:24.04
export APT_MIRROR=http://mirrors.ustc.edu.cn/ubuntu
export PERFORCE_APT_DISTRO=noble
export NPM_REGISTRY=http://mirrors.tencent.com/npm/
export NPM_STRICT_SSL=false
export PIP_INDEX_URL=https://mirrors.tencent.com/pypi/simple
export KUBERNETES_APT_REPO_BASE=https://mirrors.tencent.com/kubernetes_new/core:/stable:
export KUBERNETES_APT_REPO_VERSION=v1.36
export DOCKER_DOWNLOAD_MIRROR=https://mirrors.tencent.com/docker-ce/linux/static/stable/x86_64
./deploy.sh
```

远程部署时优先读取 `.agents/skills/remote-deployment/SKILL.md`，并遵守以下约束：

- 使用 `tar + scp + ssh` 同步文件，不依赖 Windows 上不可用的 `rsync`。
- 不打印远程 `.env` 或本地 `development/secret/secret.json`。
- 修改远程 `config.yaml` 时使用定点文本替换，不通过 YAML parser round-trip，避免破坏 anchors/aliases。
- 使用远端 `deploy.sh` 构建和重启服务。
- 部署后验证远端本机 `/healthz` 与反向代理 `/healthz`。

标准 SSH 选项（内网）：

```bash
ssh -p 36000 -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no \
  -o User=tools -i D:/workspace/keys/id_ed25519.it 10.64.8.2
```

标准 SSH 选项（公网，连接参数全部从 `development/secret/secret.yaml` 提取，不硬编码 key 路径）：

```bash
SSH_HOST="$(yq -r '.deploy.normal.ssh.host' development/secret/secret.yaml)"  # aicr.x-ha.com
SSH_PORT="$(yq -r '.deploy.normal.ssh.port' development/secret/secret.yaml)"  # 36000
SSH_USER="$(yq -r '.deploy.normal.ssh.user' development/secret/secret.yaml)"  # tools
# ssh.key_file 是远程主机上的路径（如 /home/tools/.ssh/<key>）；本机需把同名私钥镜像到本地后，用本地路径作为 -i
SSH_KEY="$(yq -r '.deploy.normal.ssh.key_file' development/secret/secret.yaml)"

ssh -p "$SSH_PORT" -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no \
  -o User="$SSH_USER" -i "$SSH_KEY" "$SSH_HOST"
```

> `ssh.key_file` 指向的是**远程主机上的路径**，从 Windows 本地部署时该路径不存在；需先把同名私钥镜像到本机本地 SSH 密钥目录（本地副本 basename 与远程一致，例如 `…/Keys/home/<key 文件名>`），再用本地路径作为 `-i`。不要继续使用工作区的 `id_ed25519` 或 `id_ed25519.it`——`id_ed25519` 会被公网服务器拒绝。

### 7.4 部署常见陷阱

- **SSH key 选择**：以 `development/secret/secret.yaml` 的 `.deploy.normal.ssh.key_file` 为准，提取文件名并用本地镜像副本作为 `-i`。不要用工作区的 `id_ed25519`（会被公网服务器拒绝）。若认证返回 `Permission denied (publickey)`，说明所选公钥尚未加入公网机 `~/.ssh/authorized_keys`，需先从已可登录的主机把该公钥追加进去。
- **`.env` 文件编码**：Windows PowerShell 5.1 的 `>` 重定向和 `Out-File` 默认 UTF-16 LE，远程容器无法读取。使用 `scp` 传输或远端 `printf` 写入。`deploy.sh` 会在启动前自动检测 UTF-16 编码并报错。
- **Config-only 变更只需重启**：`config.yaml` 和 `.env` 通过 volume 挂载到容器，修改后执行 `podman restart aicr` 即可；只有代码变更才需要 `deploy.sh` 完整重建。
- **外层容器必须保留 `--init`**：`deploy/deploy.sh` 用 `podman run -d --init` 启动服务。`--init` 让 `tini`/`catatonit` 作为 PID 1 回收被沙箱超时 kill 后 reparent 的 `.kilo` worker 僵尸（Kilo 会把 worker `setsid` 进独立 session，进程组信号杀不到，必须靠 `/proc` PPID 遍历 + PID 1 回收兜底）。删掉 `--init` 会让僵尸在 PID 1 下堆积（公网实测 31 个 `Z` 状态进程），并在退出窗口内拖慢重试形成死亡螺旋。若出现 `Agent kilo timed out after <N>ms` 且 N 远超 `agent.timeout_seconds`，先用 `podman exec aicr ps -eo pid,ppid,etime,comm | grep kilo` 确认是否有大量 PPID=1 的残留进程，再 `podman restart aicr` 清理并重新部署带修复的镜像。
- **Admin session TTL**：`adminAuthSchema` 使用 `session_ttl_seconds`（默认 28800 = 8 小时），不是 `session_ttl_minutes`。设置 `minutes` 字段会被静默忽略。
- **pnpm 10.x 原生模块**：必须通过 `pnpm-workspace.yaml` 的 `onlyBuiltDependencies: [better-sqlite3]` 授权构建，不能用 `pnpm config set` 或 `--allow-build`。
- **P4 运行时基线**：运行时镜像默认固定在 `ubuntu:24.04` + `p4-cli`
  官方 APT 安装链路。若替换 `BASE_IMAGE`，只建议使用 Ubuntu 24.04 的
  registry mirror；切回 Alpine / Chainguard / Wolfi 会直接破坏 `p4`
  可安装性和当前工具基线。
- **公网环境 `podman build` 网络限制**：公网环境 `apt-get`、Perforce APT
  仓库、Kubernetes APT、Helm APT、GitHub release、npm、pip 或 Docker
  static 下载都可能因网络策略失败；优先配置 `APT_MIRROR`、
  `KUBERNETES_APT_REPO_BASE`、`NPM_REGISTRY`、`PIP_INDEX_URL` 和
  `DOCKER_DOWNLOAD_MIRROR`。如果目标机没有统一配置容器 registry mirror，
  再按需覆盖 `NODE_IMAGE`。Helm/yq 如果无法直连官方源，使用内部缓存
  覆盖 `HELM_APT_REPO`、`HELM_APT_KEY_URL`、`YQ_DOWNLOAD_BASE`。
- **公网机构建代理（loopback + host 网络）**：公网机 `10.0.4.9` 上 `*:3128` 监听的是一个**可用 HTTP 转发代理**（实测经 `http://127.0.0.1:3128` 可代理到 npm/USTC ubuntu/Perforce 等）。`deploy.sh` 的构建代理自动探测会把监听端点解析成主网卡 IP，注入 `HTTP_PROXY=http://10.0.4.9:3128`；但该地址从 bridge 构建网络命名空间不可达，导致 `apt-get` 报 `Connection refused`、`ca-certificates has no installation candidate`。同时 Perforce APT 等下载在 bridge 直连时容易卡死（本机直连可达、容器内挂起，日志停在 `Get: … package.perforce.com … p4-cli` 无增长）。正确做法（已验证可用）：构建时显式用 loopback 代理 + host 网络，让构建容器经 `127.0.0.1:3128` 取包——

  ```bash
  HTTP_PROXY=http://127.0.0.1:3128 HTTPS_PROXY=http://127.0.0.1:3128 \
  NO_PROXY=127.0.0.1,localhost,::1,10.0.4.9 \
  AICR_DEPLOY_DIR=/home/tools/AICodeReviewer bash deploy.sh
  ```

  `deploy.sh` 检测到 loopback 代理会自动加 `--network=host`，使构建容器能访问宿主 loopback 上的代理。镜像内的运行时容器不需要该代理，故 `NO_PROXY` 必须包含 `127.0.0.1,localhost`，否则 `deploy.sh` 末尾的 `curl /healthz` 健康检查会误走代理。若想完全不走代理（仅当本机直连所有源都稳定时），需用一份把代理自动探测块（`if [ -z "$BUILD_HTTP_PROXY" ] && [ -z "$BUILD_HTTPS_PROXY" ]; then`）改为 `if false; then` 的 `deploy.sh` 副本构建。

## 8. 测试验收环境（与生产隔离）

### 8.1 环境选择顺序

AI agent 做测试验收前先记录环境选择结果：宿主系统、可用容器 CLI、是否 rootless、验收目录、跳过更高优先级环境的原因。不要瞎猜，也不要直接默认远程环境。

1. **优先使用本地容器能力**：如果当前开发环境可以运行容器，优先在本机验收，目录固定为 `$HOME/AICodeReviewerTest`。
   - 首选 rootless 容器：`podman`，或连接到 rootless Docker daemon 的 `docker`。
   - 没有 rootless 时，再尝试 rootful 容器：`docker`、`nerdctl`、`crictl` 等；只有在该 CLI 能完成本轮所需的 build/run/healthz/logs 操作时才使用。
   - 探测示例：

     ```bash
     podman info
     docker info
     nerdctl info
     crictl info
     ```

2. **Windows 本地无合适容器时尝试 WSL2**：先用 `wsl.exe --status` 与 `wsl.exe -l -v` 确认 WSL2 可用，再进入合适的 Linux distro。WSL2 内仍按“rootless 容器优先、rootful 容器其次”的顺序选择，验收目录使用 WSL 用户的 `$HOME/AICodeReviewerTest`。
3. **最后才使用配置的远程测试验收环境**：只有本地容器和 WSL2 都不可用或无法满足本轮验收需求时，才使用第 8.3 节的远程测试环境与测试验收目录。

本地或 WSL2 验收目录初始化：

```bash
mkdir -p "$HOME/AICodeReviewerTest"
```

### 8.2 隔离原则

- 测试目录 `/data/disk2/AICodeReviewerTest` 与生产目录 `/data/disk2/AICodeReviewer` **完全隔离**。
- 不得共享：容器镜像（使用不同 tag）、容器名（`aicr-test` vs `aicr`）、端口（`8091` vs `8090`）、数据卷、网络配置。
- 测试环境用于：新功能验证、回归测试、破坏性配置实验、跨平台兼容性验证。
- 生产环境仅用于：已验收版本的稳定运行。

### 8.3 配置的远程测试环境信息

| 项目     | 开发自测环境                                          | 内网测试环境                                          | 公网正式环境                                          |
| -------- | ----------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| 部署目录 | `/data/disk2/AICodeReviewerTest`                      | `/data/disk2/AICodeReviewer`                          | `/home/tools/AICodeReviewer`                          |
| 容器名   | `aicr-test`                                           | `aicr`                                                | `aicr`                                                |
| 本机端口 | `8091`                                                | `8090`                                                | `8090`                                                |
| 反向代理 | （暂无，直接访问或临时配置）                          | `https://aicr.m-oa.com:6023`                          | `https://aicr.x-ha.com:6023`                          |
| 健康检查 | `http://10.64.8.2:8091/healthz`                       | `http://10.64.8.2:8090/healthz`                       | `http://10.0.4.9:8090/healthz`                        |
| 数据卷   | bind: `…/data/workspaces`, `…/data/db`, `…/data/logs` | bind: `…/data/workspaces`, `…/data/db`, `…/data/logs` | bind: `…/data/workspaces`, `…/data/db`, `…/data/logs` |

### 8.4 从零部署验证（已验证通过）

从空目录到完整运行的验收流程：

```bash
# === 本地准备 ===
# 1. 创建源码 tarball
node -e "require('fs').mkdirSync('build/tmp',{recursive:true})"
cmd /c "tar czf build/tmp/aicr-test-deploy.tar.gz --exclude=.git --exclude=node_modules --exclude=dist --exclude=coverage --exclude=build ."

# 2. 上传到远程
scp -P 36000 -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no `
  -i D:/workspace/keys/id_ed25519.it `
  build/tmp/aicr-test-deploy.tar.gz tools@10.64.8.2:/data/disk2/

# === 远程从零部署 ===
# 3. 清理并创建空目录
ssh -p 36000 ... 10.64.8.2 "podman --storage-driver=overlay rm -f aicr-test 2>/dev/null; rm -rf /data/disk2/AICodeReviewerTest; mkdir -p /data/disk2/AICodeReviewerTest"

# 4. 解压源码并搭建目录结构
ssh -p 36000 ... 10.64.8.2 "cd /data/disk2/AICodeReviewerTest; mkdir -p source; tar xzf /data/disk2/aicr-test-deploy.tar.gz -C source; cp -r source/deploy .; cp source/deploy/deploy.sh ."

# 5. 写入 .env（从生产复制并追加容器沙箱标志，不要打印原文）
ssh -p 36000 ... 10.64.8.2 "cp /data/disk2/AICodeReviewer/.env /data/disk2/AICodeReviewerTest/.env; echo 'AICR_ENABLE_CONTAINER_SANDBOX=true' >> /data/disk2/AICodeReviewerTest/.env"

# 6. 写入 config.yaml（可从生产复制或按需精简）
ssh -p 36000 ... 10.64.8.2 "cp /data/disk2/AICodeReviewer/config.yaml /data/disk2/AICodeReviewerTest/config.yaml"

# 7. 确保 Podman user socket 活跃
ssh -p 36000 ... 10.64.8.2 "systemctl --user enable --now podman.socket 2>/dev/null; ls -la /run/user/$(id -u)/podman/podman.sock"

# 8. 执行部署（启用容器嵌套沙箱）
ssh -p 36000 ... 10.64.8.2 "cd /data/disk2/AICodeReviewerTest; AICR_DEPLOY_DIR=/data/disk2/AICodeReviewerTest AICR_IMAGE_NAME=aicr:test AICR_CONTAINER_NAME=aicr-test AICR_HOST_PORT=8091 AICR_ENABLE_CONTAINER_SANDBOX=true bash deploy.sh"

# === 验证 ===
# 9. 健康检查
ssh -p 36000 ... 10.64.8.2 "curl -sf http://127.0.0.1:8091/healthz"

# 10. 容器嵌套沙箱验证
ssh -p 36000 ... 10.64.8.2 "podman exec aicr-test sh -c 'docker --version && docker run --rm alpine:latest echo sandbox-ok'"

# 11. 网络隔离验证（应失败）
ssh -p 36000 ... 10.64.8.2 "podman exec aicr-test sh -c 'docker run --rm --network none alpine:latest wget -q -O /dev/null http://example.com 2>&1; echo exit=\$?'"
```

### 8.5 容器嵌套沙箱验证清单

已验证通过的项目：

- Docker 静态二进制（v27.5.1）正确打包到镜像
- Podman user socket 正确挂载到容器内
- `DOCKER_HOST=unix:///run/user/$(id -u)/podman/podman.sock` 正确注入
- `--userns=keep-id --group-add keep-groups` 正确传递
- 嵌套 `docker run --rm alpine echo sandbox-ok` 成功
- `--network none` 正确阻断 DNS（安全隔离）
- 容器内进程无法写入根文件系统（只读）
- `/healthz` 和 `/metrics` 端点正常
- 生产环境（8090）与测试环境（8091）完全隔离

### 8.6 测试环境配置差异

测试 `config.yaml` 与生产的差异要点：

- `agent.default` 保持 `kilo`（验收主路径）。
- LLM 模型可降级到成本更低的模型做快速验证。
- 输出通道应指向测试仓库 / 测试 IM 机器人，避免污染生产通知。
- `server.auth.api_key_env` 可使用与生产不同的 key，防止测试触发误调用生产 webhook。
- workspace 实例只配置测试仓库，不要包含生产仓库。

### 8.7 容器接入与跨平台验证

- 如需进入测试容器排查：

  ```bash
  ssh -p 36000 ... 10.64.8.2 "podman exec -it aicr-test /bin/sh"
  ```

- 如需查看测试容器日志：

  ```bash
  ssh -p 36000 ... 10.64.8.2 "podman logs --tail 100 -f aicr-test"
  ```

- 如需在测试容器内手动触发 review：

  ```bash
  ssh -p 36000 ... 10.64.8.2 "podman exec aicr-test node packages/cli/dist/index.js review --config /app/config.yaml --repo 'test-org/test-repo' --dry-run"
  ```

## 10. 生产配置目标

- 测试环境公共系统提示词应包含“使用简体中文回答最终分析报告”。
- AICR 需要支持 PR/MR，也需要支持新 commit 自动触发分析。
- 对于 Gitea 输出：
  - 有问题时支持自动创建 issue。
  - 自动创建的 issue / PR / MR 需通过可配置标题前缀、tag 或标签标识来源。
  - 后续提交修复问题、代码位置无效或问题过期时，应支持自动关闭或删除旧 issue。

## 10. 已配置 review 目标

- Gitea：`https://git.w-oa.com:6023/ProjectY/server`
- Gitea：`https://git.w-oa.com:6023/ProjectY/pipeline`
- Gitea：`https://git.w-oa.com:6023/ProjectY/robot`
- Gitea：`https://git.w-oa.com:6023/ProjectX/server`
- Gitea：`https://git.w-oa.com:6023/ProjectX/Pipeline`
- P4：`ssl:p4.w-oa.com:8666`
- GitHub：`https://github.com/atframework/atsf4g-co`
- GitHub：`https://github.com/owent/libatapp`
- GitHub：`https://github.com/owent/hiredis-happ`

## 11. Podman 故障排查

### 11.1 `invalid internal status` — rootless Podman 存储驱动初始化失败

**现象：**

```bash
$ podman ps
ERRO[0000] invalid internal status, try resetting the pause process with "podman system migrate": could not find any running process: no such process
```

**根因（深度调研结果）：**

- 系统 `/etc/containers/storage.conf` 配置了自定义存储路径（`graphroot=/data/disk2/docker-image`、`runroot=/data/disk2/docker-container`、`rootless_storage_path=/data/disk2/docker-storage/$USER`）。
- Podman 5.x 在 rootless 模式下，存储驱动自动检测与自定义路径配置存在兼容性问题。
- 错误消息 `"could not find any running process"` 具有误导性；真正原因是**存储层初始化失败**，而非 pause 进程缺失。
- `podman system migrate` 在默认模式下可能因 nil pointer 崩溃，因为它尝试引用已损坏的 `storageService`。

**修复步骤（已验证）：**

```bash
# 1. 强制指定 overlay 驱动，绕过损坏的自动检测
podman --storage-driver=overlay system migrate

# 2. 重新启动被 migrate 停止的容器
podman start aicr caddy

# 3. 验证本地和反向代理健康检查
curl -sf http://127.0.0.1:8090/healthz
curl -sf $(jq ".deploy.normal.url" ./development/secret/secret.yaml)/healthz
```

**预防措施：**

- `deploy.sh` 中所有 `podman build` / `podman run` / `podman rm` 命令必须显式加 `--storage-driver=overlay`；如果通过 `AICR_ENGINE=docker` 切到 Docker，则不要传这个 Podman 专用参数。
- 部署脚本开头加入 pre-flight 检查：

  ```bash
  if ! podman ps >/dev/null 2>&1; then
    podman --storage-driver=overlay system migrate
  fi
  ```

- 考虑将 AICR 容器注册为 systemd user service（`podman generate systemd`），避免依赖手动 `podman start`。

## 12. 命令执行守则

- 命令必须设置合理超时，避免流程卡死。
- 如果命令长时间无输出或超时，先尝试清理卡住进程，再重试或换方案。
- 交互式命令需要逐个 prompt 处理，不要一次性发送多段输入。
- 运行验证命令时遵守 `AGENTS.md` 的 Windows PowerShell workaround：优先用 `node` 直接调用 CLI，避免 `.ps1` 执行策略问题。
