---
title: Podman / Rootless
description: 使用 Podman 运行 AICodeReviewer，包括 rootless 本地配置与嵌套容器（Docker-out-of-Docker）沙箱模式。
---

Podman 沙箱路径使用与 Docker 相同的容器契约，但当选择 `sandbox.kind: podman` 或
`sandbox.engine: podman` 时，会把 CLI 解析为 `podman`。本页介绍何时选择 Podman、rootless 本地配置、
嵌套容器模式、运行时保证、SELinux 注意事项，以及 `--storage-driver=overlay` 故障恢复要点。

## 何时选择 Podman

当部署环境偏好 **rootless、无守护进程**的容器，或无法运行特权 Docker 守护进程时，使用 Podman。
AICR 仍然只把受限的审查目录挂载进每个运行容器，并保持 `source/` 只读，因此隔离保证与 Docker 路径
完全一致。

## Rootless 本地配置

用你的平台包管理器安装 Podman，然后验证服务用户能看到 CLI：

```bash
podman --version
podman run --rm --network none alpine:latest true
```

在 Linux 上，**仅**当基于 socket 的部署模式需要时，才启用用户 socket：

```bash
systemctl --user enable --now podman.socket
systemctl --user status podman.socket
```

rootless socket 路径通常是：

```text
/run/user/$UID/podman/podman.sock
```

## AICR 配置

为本地或自托管运行强制使用 Podman：

```yaml
agent:
  sandbox:
    kind: podman
    engine: podman
    image: ghcr.io/owent/aicr-agent:latest
```

让 AICR 先探测 Docker，再探测 Podman：

```yaml
agent:
  sandbox:
    kind: docker
    engine: auto
```

仅当需要提升隔离性或为特定 workspace 选择镜像时，才使用 workspace 覆盖：

```yaml
workspaces:
  instances:
    internal-python:
      source_repo: { trigger: gitea-internal, repo: owent/example }
      sandbox:
        kind: podman
        engine: podman
        image: ghcr.io/example/python-review:latest
```

## 嵌套容器沙箱（AICR 运行在容器内）

当 AICR 本身运行在容器内（例如通过 `deploy.sh`），且你希望沙箱为 agent 隔离派生**子容器**时，必须
把宿主容器引擎的 socket 挂载进 AICR 容器。这是一种应用于 Podman 的 Docker-out-of-Docker（DooD）
模式。

### 前置要求

1. 必须启用**宿主用户级 Podman socket**：

   ```bash
   systemctl --user enable --now podman.socket
   ```

2. AICR 镜像内有 **Podman CLI**。运行时镜像内置了 `podman`，因此
   `sandbox.kind: podman` / `sandbox.engine: podman` 能通过 `CONTAINER_HOST` 与挂载的宿主 socket
   通信。
3. AICR 镜像内有**可选的 Docker 静态二进制**，用于 Docker 兼容客户端（当
   `AICR_ENABLE_CONTAINER_SANDBOX=true` 时由 `deploy.sh` 安装）。
4. **`deploy.sh` 环境变量**：

   ```bash
   AICR_ENABLE_CONTAINER_SANDBOX=true   # 启用 socket 挂载 + Podman/Docker 客户端
   ```

5. **`config.yaml` 沙箱 kind** 尽可能设为原生 Podman：

   ```yaml
   agent:
     sandbox:
       kind: podman
       engine: podman
   ```

   当你确实需要 Docker CLI 语义时，Docker 兼容模式仍然可用：

   ```yaml
   agent:
     sandbox:
       kind: docker
       engine: auto
   ```

### 工作原理

- 运行时镜像安装了 `podman`、`buildah` 和 `skopeo`。AICR 容器内**不**启动 Podman 守护进程 — CLI
  只是被挂载的宿主 Podman API socket 的客户端。
- 当 `AICR_ENABLE_CONTAINER_SANDBOX=true` 时，`deploy.sh` 会下载 Docker 静态二进制并固化进镜像；
  否则它会创建一个无害的空 `deploy/docker-static` 占位文件，以保证干净的源码同步仍能满足 Dockerfile
  的可选 `COPY` 步骤。运行时镜像会移除这个空占位文件，而不是安装一个 0 字节的 `docker` 可执行文件。
- 运行时，`deploy.sh` 把宿主用户级 Podman socket
  （`/run/user/$UID/podman/podman.sock`）挂载进 AICR 容器。
- `deploy.sh` 设置 `CONTAINER_HOST=unix:///run/user/$UID/podman/podman.sock`，让 Podman CLI 与宿主
  Podman 服务通信。
- `deploy.sh` 还设置 `DOCKER_HOST=unix:///run/user/$UID/podman/podman.sock`，让 Docker 兼容工具能
  使用 Podman 的 Docker API 层。
- `--userns=keep-id --group-add keep-groups` 确保容器进程能访问用户级 socket。
- 当挂载了 Podman socket 时，会添加 `--security-opt label=disable`，这与 Podman 官方文档关于在
  SELinux 启用的宿主上从另一个容器内访问 Unix socket 的建议一致。

:::warning[把 socket 当作特权访问]
Podman API 能启动容器，并以拥有该 socket 的宿主用户身份执行任意代码。挂载它就等于把这种控制力
交给了 AICR 容器 — 仅在你完全可控的宿主上这样做。参见 [运维与安全](/zh-cn/deployment/operations/)。
:::

### 验证

部署完成后，从 AICR 容器内确认：

```bash
podman exec aicr sh -c 'podman --version && podman run --rm alpine:latest echo podman-ok'
podman exec aicr sh -c 'docker --version && docker run --rm alpine:latest echo docker-ok'
```

## 运行时保证

Podman 路径与 Docker 保持相同的沙箱保证：

- 在调用 Podman 之前，会先针对 `ALLOWED_COMMANDS` 检查容器命令。
- 除非显式接入了未来的白名单代理，容器以 `--network none` 运行。
- `source/` 以只读方式挂载到 `/workspace/source`。
- `agent/` 和 `tmp/` 是仅有的可写 workspace 挂载。
- 临时 `--env-file` 文件创建在挂载的 workspace 目录**之外**，并在运行后删除。
- 默认**不**挂载 Docker 和 Podman 宿主 socket。

## SELinux 注意事项

在启用了 SELinux 的宿主上，bind mount 可能需要重新打标签。优先使用专用的审查镜像和归服务用户所有
的 workspace 目录。如果宿主要求显式标签，请在后端挂载策略中添加，而不要手工编辑生成的命令。

## 排障

### `invalid internal status, try resetting the pause process with "podman system migrate"`

当 rootless Podman 的存储驱动初始化失败时会出现此错误 — 常见于系统重启、OOM kill，或
`/etc/containers/storage.conf` 使用了自定义 `rootless_storage_path` 之后。

:::caution[错误信息具有误导性]
末尾的 `"could not find any running process"` **不是**缺少 pause 进程。根因几乎总是**存储层
初始化失败**，而非缺少进程。
:::

快速修复（非破坏性）：

```bash
# 显式强制 overlay 驱动 — 绕过损坏的自动探测
podman --storage-driver=overlay system migrate

# 重启已停止的容器
podman start aicr caddy

# 验证
curl -sf http://127.0.0.1:8090/healthz
```

**原理：** 当 `/etc/containers/storage.conf` 配置了自定义路径（`graphroot`、`runroot`、
`rootless_storage_path`）时，Podman 5.x 在 rootless 模式下可能无法自动探测存储驱动。显式指定
`--storage-driver=overlay` 会跳过自动探测，直接打开基于 overlay 的存储。

**如果 migrate 仍然崩溃：** 检查 `/run/user/$UID/libpod/tmp/exits/` 或
`/run/user/$UID/libpod/tmp/persist/` 下是否有退出码为 137（SIGKILL）的陈旧容器退出记录。删除这些
文件后再重试 migrate。

**在部署脚本中预防：** 当 `deploy.sh` 运行 Podman（默认的 `AICR_ENGINE=podman` 路径）时，始终指定
`--storage-driver=overlay`：

```bash
podman --storage-driver=overlay build -t aicr:latest ...
podman --storage-driver=overlay run -d --name aicr ...
```

如果选择了 `AICR_ENGINE=docker`，请省略这个 Podman 专属标志，并在 `docker ps` 无法连接守护进程时
快速失败。

用于自动化的预检：

```bash
if ! podman ps >/dev/null 2>&1; then
  podman --storage-driver=overlay system migrate
fi
```

### 其他常见问题

- `podman --version` 失败：为服务用户安装 Podman，并确保服务环境中可用 `PATH`。
- 容器无法读取 `/workspace/source`：验证宿主源目录存在，且服务用户有读权限。
- 容器无法写入 `/workspace/agent` 或 `/workspace/tmp`：验证 workspace 归属和 rootless UID 映射。
- 沙箱回退到 native 模式：设置 `agent.sandbox.kind: podman` 和 `agent.sandbox.engine: podman`，
  让缺失的 Podman 二进制在预检阶段失败，而不是静默优先使用 Docker。
