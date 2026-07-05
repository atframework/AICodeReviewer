---
title: Docker 部署
description: 使用 Docker 构建并运行 AICodeReviewer 单容器镜像，配置运行时工具基线，并启用嵌套容器沙箱。
---

大多数部署场景下，最快的方式是使用 [Docker Compose](/zh-cn/start/docker-compose/)。
本页介绍与之等价的纯 `docker build` / `docker run` 流程、运行时镜像基线（镜像内置了哪些
工具以及为什么）、在内网受限环境下可覆盖的构建参数，以及两种基于容器的沙箱后端。

## 不使用 Compose 的构建与运行

```bash
# 在仓库根目录构建镜像
docker build -t aicodereviewer -f deploy/Dockerfile .

# 运行
docker run -d \
  --name aicr \
  --init \
  --env-file example/.env \
  -p 8080:8080 \
  -v $(pwd)/example/config.yaml:/app/config.yaml:ro \
  -v aicr-data:/app/data \
  -v aicr-workspaces:/app/workspaces \
  -v aicr-logs:/app/logs \
  aicodereviewer
```

:::tip[务必传入 --init]
容器的入口是 `node packages/cli/dist/index.js`。Node **不是** PID 1 init 进程：
它不会回收 agent 子进程遗留的孤儿/僵尸进程。务必加上 `--init`（Docker 会注入 `tini`），
以保证子进程回收和信号转发正常。原因见
[agent 超时与进程清理](#agent-超时与进程清理) 小节。
:::

### 卷布局

| 宿主侧 | 容器路径 | 模式 | 用途 |
| --- | --- | --- | --- |
| `example/config.yaml` | `/app/config.yaml` | `:ro` | 主配置 — LLM、triggers、outputs、workspaces |
| `aicr-data` | `/app/data` | rw | 持久化队列数据库、运行历史、SQLite 存储 |
| `aicr-workspaces` | `/app/workspaces` | rw | 克隆仓库 / 检出缓存 |
| `aicr-logs` | `/app/logs` | rw | 应用日志文件 |

`config.yaml` 以只读方式挂载是有意为之：它应当**只包含环境变量名**，绝不含密钥值
（参见 [身份认证与密钥](/zh-cn/configuration/authentication/)）。密钥本身通过
`--env-file example/.env` 注入 — 该文件**不**挂载进容器文件系统，Docker 在宿主侧读取它，
并把变量注入到进程环境中。

容器对外暴露端口 `8080`（`-p 8080:8080`），并提供 `/healthz` 用于健康检查。Compose 文件把
它接到了 `healthcheck` 块中；如果是纯 `docker run`，请把你的探针指向
`http://localhost:8080/healthz`。

## 运行时镜像基线

镜像有意采用 `ubuntu:24.04` 作为发行版基线，并从官方 `node:22-bookworm-slim` 镜像拷贝 Node 22
用户态。这样既让 Node 保持在官方 LTS 用户态上，又能让 AICR 安装**官方 Perforce Ubuntu APT 包
（`p4-cli`）**。Perforce 包需要 glibc 和 Ubuntu 的包布局 — 如果把整个基线都构建在精简的 Node
镜像上，是拿不到这些的。

### 工具列表

按用途分组的运行时工具基线：

| 分组 | 工具 |
| --- | --- |
| 版本控制 | `git`、`git-lfs`、`subversion`、`p4` |
| 搜索与检视 | `rg`、`fd`、`bat`、`jq`、`tree`、`universal-ctags` |
| Kubernetes 与 YAML | `kubectl`、`helm`、Mike Farah `yq`；当不需要独立的 `kustomize` 二进制时，使用 `kubectl kustomize` 处理 Kustomize overlays |
| 容器客户端 | `podman`、`buildah`、`skopeo`，外加一个可选的 Docker 静态 CLI，用于 Docker 兼容 socket 工作流 |
| 构建与静态分析 | `build-essential`、`cmake`、`ninja`、`pkg-config`、`clang`、`clang-format`、`clang-tidy`、`cppcheck` |
| Python | `python3`、`python`、`pip`、`venv`、Python 头文件、setuptools、wheel |
| 调试与排障 | `gdb`、`valgrind`、`shellcheck`、`strace`、`lsof`、`inotify-tools`、`curl`、`wget`、`dnsutils`、`iputils-ping`、`iproute2`、`tcpdump`、`netcat-openbsd`、`openssl` |
| 数据与同步 | `sqlite3`、`rsync`、`xxd`、`bsdextrautils` |
| 补丁与归档 | `diffutils`、`patch`、`unzip`、`zip`、`xz`、`tar`、`gzip`、`bzip2`、`zstd`、`lz4` |

在 Debian/Ubuntu 上，发行版包提供的是 `fdfind` 和 `batcat`。镜像添加了兼容性符号链接
（`fd`、`bat`），这样 agent 的提示词就能一致地引用这些名字。容器还直接内置了 `p4`，因此部署
不再依赖 bind-mount 宿主侧的 Perforce 二进制。

## 可配置的构建参数

以下参数均为可选。当你的网络无法访问上游镜像源，或想锁定到不同版本时，用
`docker build --build-arg ...` 覆盖它们。

| 构建参数 | 默认值 | 用途 |
| --- | --- | --- |
| `BASE_IMAGE` | `ubuntu:24.04` | 构建与运行时阶段的发行版基线 |
| `NODE_IMAGE` | `node:22-bookworm-slim` | 作为 Node 用户态来源的官方 Node 22 镜像。当宿主已经通过全局镜像源重写 registry 拉取时，可省略/保持默认 |
| `APT_MIRROR` | *(空)* | Ubuntu apt 镜像根，例如 `http://mirrors.ustc.edu.cn/ubuntu` |
| `PERFORCE_APT_DISTRO` | `noble` | Perforce APT 仓库对应的 Ubuntu 代号 |
| `NPM_REGISTRY` | `https://registry.npmjs.org` | npm/pnpm registry |
| `NPM_STRICT_SSL` | `true` | 使用 HTTP 镜像时设为 `false` |
| `PIP_INDEX_URL` | `https://pypi.org/simple` | pip simple index URL |
| `KUBERNETES_APT_REPO_BASE` | `https://pkgs.k8s.io/core:/stable:` | kubectl APT 仓库基址（必须以 `core:/stable:` 结尾） |
| `KUBERNETES_APT_REPO_VERSION` | `v1.36` | kubectl 对应的 Kubernetes 小版本仓库 |
| `HELM_APT_REPO` | `https://packages.buildkite.com/helm-linux/helm-debian/any/` | Helm Debian 包仓库 |
| `HELM_APT_KEY_URL` | `https://packages.buildkite.com/helm-linux/helm-debian/gpgkey` | Helm 仓库签名密钥 |
| `YQ_VERSION` | `v4.53.2` | Mike Farah `yq` 发布版本 |
| `YQ_DOWNLOAD_BASE` | `https://github.com/mikefarah/yq/releases/download` | `yq` release 下载基址 |

以下是 `deploy.sh` 的环境变量（不是 Dockerfile `ARG`），仅在嵌套容器沙箱下载可选 Docker 静态 CLI 时使用：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `DOCKER_DOWNLOAD_MIRROR` | `https://download.docker.com/linux/static/stable/x86_64` | `deploy.sh` 下载可选 Docker 静态 CLI 时使用的镜像源 |

:::note[已废弃的别名]
`APK_MIRROR` 仍被接受，作为 `APT_MIRROR` 的向后兼容别名。新部署应使用 `APT_MIRROR`。
:::

### USTC 镜像说明（arm64 与 amd64）

USTC 镜像文档建议：`amd64`/`i386` 使用 `http://mirrors.ustc.edu.cn/ubuntu`，而
`arm64`/`armhf`/`ppc64el`/`s390x` 应使用 `http://mirrors.ustc.edu.cn/ubuntu-ports`。
`deploy/Dockerfile` 在第一次 `apt-get update` **之前**会同时重写标准的 Ubuntu
`archive`/`security` 条目**以及** `ports.ubuntu.com` 变体，因此一个 HTTP 镜像值即可同时
适用于两种架构，无需提前引导 CA。

对于腾讯云镜像，Kubernetes 路径为 `kubernetes_new`（通过 `KUBERNETES_APT_REPO_BASE` 设置）。
未验证有专门的 `mirrors.tencent.com/helm/` 或 `mirrors.tencent.com/yq/` 端点 — 如果要完全在内网构建，
请把 Helm/yq 参数指向一个保留相同仓库布局的内部缓存。

## 企业代理的额外 CA

如果你的构建宿主通过使用私有根 CA 的企业代理或本地镜像访问外部 HTTPS，请在构建前把所需的
`.crt` 文件拷贝到 `deploy/extra-ca/`：

```bash
cp /etc/ssl/certs/my-corporate-root.crt deploy/extra-ca/
docker build -t aicodereviewer -f deploy/Dockerfile .
```

`deploy/Dockerfile` 会在拉取任何外部密钥、npm 包或 release 制品**之前**，把 `deploy/extra-ca/`
拷贝到 `/usr/local/share/ca-certificates/` 并执行 `update-ca-certificates`，这样后续构建就信任
你的私有根证书。

## HTTP 代理自动探测

如果部署宿主在 TCP `3128` 上暴露了 HTTP 代理，`deploy.sh` 会自动探测到，并把它用于宿主侧下载
以及 `podman build` / `docker build` 的拉取。显式的 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`
环境变量始终**优先于**自动探测；如果代理只监听回环地址（`127.0.0.1:3128`），构建会自动切换到 host
networking，以便 Dockerfile 的 `RUN` 步骤仍能访问它。

## 沙箱后端

AICR 可以把每个 agent 运行隔离在独立的容器中。当服务本身运行在 Docker 内时，有两种容器后端相关。

### `docker_socket` 后端

`docker_socket` 使用与 `docker` 相同的容器契约，但用于标识通过 Unix socket 访问 Docker 守护进程的
运行。当服务本身运行在一个挂载了 `/var/run/docker.sock` 的容器内时，配置它：

```yaml
agent:
  sandbox:
    kind: docker_socket
    engine: docker
    image: ghcr.io/owent/aicr-agent:latest
```

无需额外的 Docker Engine API 客户端 — AICR 调用 `docker` CLI，并依赖服务容器能访问到宿主 socket。

:::warning[Socket 即特权访问]
挂载 `/var/run/docker.sock` 等于把宿主 Docker 守护进程的完整、root 等效控制权交给了容器。仅在你
完全可控的宿主上这样做。威胁模型见 [运维与安全](/zh-cn/deployment/operations/)。
:::

### 嵌套容器沙箱（AICR 运行在容器内）

当 AICR 本身运行在容器内，且你希望沙箱为 agent 隔离派生**子容器**时，在 `deploy.sh` 中启用嵌套容器
沙箱：

```bash
AICR_ENABLE_CONTAINER_SANDBOX=true bash deploy/deploy.sh
```

这会告诉 `deploy.sh`：

1. 当需要 Docker 兼容 socket 客户端时，把 Docker 静态二进制下载到构建上下文中。
2. 把宿主用户级 Podman socket 挂载进 AICR 容器。
3. 为原生 `podman` CLI 设置 `CONTAINER_HOST`，为 Docker CLI 设置 `DOCKER_HOST`，使两者都路由到
   宿主 Podman 服务。
4. 添加 `--userns=keep-id --group-add keep-groups`，使容器用户能访问该 socket。

当嵌套容器沙箱**未启用**时，`deploy.sh` 仍会创建一个空的 `deploy/docker-static` 占位文件，以保证
干净的同步不会让 Dockerfile 的可选 `COPY` 步骤失败。运行时镜像会移除这个空占位文件，而不是安装一个
0 字节的 `docker` 可执行文件。

#### 宿主要求

启用宿主用户级 Podman socket（rootless）：

```bash
systemctl --user enable --now podman.socket
```

然后，当通过宿主 Podman socket 审查容器化工作负载时，优先使用原生 Podman：

```yaml
agent:
  sandbox:
    kind: podman
    engine: podman
```

对于 Docker 兼容工作流，设置 `sandbox.kind: docker`，让容器内的 Docker CLI 通过 `DOCKER_HOST`
与 Podman 通信：

```yaml
agent:
  sandbox:
    kind: docker
    engine: auto
```

完整的 Podman rootless 配置、运行时保证、SELinux 注意事项，以及 `--storage-driver=overlay`
故障恢复要点，请见 [Podman](/zh-cn/deployment/podman/) 页面。

## agent 超时与进程清理

`agent.timeout_seconds` 是对一次 agent 运行的硬性上限。触发时，沙箱会杀死**整个进程树** — agent
二进制及其 worker 子进程 — 而不仅仅是直接子进程，因此一次运行无法通过遗留孤儿 worker 来超支预算。

如果审查看起来卡住，或在多次重试间变得越来越慢，原因通常是逃过了进程树清理的遗留 agent 进程
（这正是 `--init` 重要的原因）。**重启 AICR 容器** — 运行时会在重启时回收任何遗留的 agent 进程。
