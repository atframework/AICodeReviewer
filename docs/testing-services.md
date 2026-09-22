# 本地临时服务验收

WSL2 Debian 可运行 rootless Podman 服务，并让 Windows 测试进程访问回环映射端口。
2026-09-22 实测 Debian 13.6、Podman 5.4.2、cgroup v2/systemd；
主机当前能力仍需用 `wsl --list --verbose`、`podman info`、`podman ps -a` 核对。
测试服务只使用合成账户和仓库，不读取部署凭据。

## 按依赖选择服务

| 依赖 | 本地可验证 | 资源与剩余限制 |
| --- | --- | --- |
| Gitea | 真实 commit 作者关联、issue 发布及最终 assignees、权限失败 | 单容器 + SQLite，1 CPU / 512 MiB；关闭 SSH/Actions/邮件/注册。固定 1.25.4，不能替代其他版本/Forgejo/GitHub |
| Redis | 配置/队列/catalog、故障恢复与持久化 | 可复用本机镜像；普通和 OOM 独立容器，按测试实际峰值限额，只删自有前缀，禁止 FLUSHDB |
| PostgreSQL | 配置/业务存储、迁移与角色权限 | 独立 cluster；角色需 CREATE ROLE。共享迁移套件串行或独立数据库，不混用生产连接 |
| SVN/P4 | hook、diff、辅助仓库物化与本地身份合同 | 优先复用已有 CLI/fixture；P4 固定已验证版本，不能推断部署认证/TLS。辅助仓库 e2e 仍列路线图 |
| GitLab | 本地真仓库/token/webhook、push/MR 入队与发布 | 可自建，但官方受限单节点至少 8 GB 内存；本轮不启动。单独串行安排，关闭非必要组件，固定镜像后再制定版本对应配置 |
| 飞书、GitHub App、付费 LLM | 请求构造与故障替身 | 本地服务不提供真实租户/安装/套餐/自然流量证据，仍需目标环境和明确预算 |

GitLab 的资源判断依据[官方安装要求](https://docs.gitlab.com/install/requirements/)；
Gitea 的 SQLite/目录布局依据[rootless 镜像说明](https://docs.gitea.com/installation/install-with-docker-rootless/)。
表内 Gitea 限额是本仓库小型 fixture 的实测配置，不是生产容量建议。

## Gitea 复现

在仓库根目录使用 Linux Node/pnpm（版本要求以 package.json 为准）：

```bash
bash tests/services/with-gitea.sh \
  pnpm exec vitest run packages/outputs/test/gitea-assignment-live.test.ts --maxWorkers=1
```

WSL 的系统 Node 可能低于项目下限。已有 Windows 依赖时可在 PowerShell 7 中使用
Windows Node，避免复制 checkout 或再次安装依赖：

```powershell
$nodePath = (Get-Command node).Source
$wslNodePath = wsl -d Debian -- wslpath -u $nodePath
wsl -d Debian -- bash tests/services/with-gitea.sh $wslNodePath `
  node_modules/vitest/vitest.mjs run packages/outputs/test/gitea-assignment-live.test.ts --maxWorkers=1
if ($LASTEXITCODE -ne 0) { throw 'Gitea acceptance failed' }
```

脚本要求 Podman、curl、node、timeout；默认在
`~/workspace/github/atframework/aicr-acceptance.<随机值>/build/tmp/` 创建数据，
可用 `AICR_ACCEPTANCE_ROOT` 指定父目录。`keep-id` 让容器写入保持当前用户所有权。
脚本创建临时管理员并通过环境传递 `AICR_GITEA_TEST_URL` / `AICR_GITEA_TEST_TOKEN`；
WSLENV 仅追加这两个 fixture 变量以便启动 Windows 子进程。
测试创建随机私有仓库和普通用户，通过真实发布器调用后 GET issue 核验持久状态。
权限与 422 重试场景核对固定版本的
[issue handler](https://github.com/go-gitea/gitea/blob/v1.25.4/routers/api/v1/repo/issue.go)。
两变量都不设时明确跳过；只设一个或使用非回环 HTTP 地址时失败。

## 生命周期与清理

容器绑定 `127.0.0.1` 随机端口，无 restart policy。
脚本在成功、失败、INT/TERM/HUP 时移除自己的容器及临时目录；仅当镜像原先不存在时
删除本轮拉取的镜像，不执行全局 prune，也不修改已有容器。
Podman `--rm --timeout 900` 给服务设置独立于测试进程的运行上限；
语义见[Podman 5.4.2 run](https://docs.podman.io/en/v5.4.2/markdown/podman-run.1.html)。
SIGKILL/主机断电无法执行 shell 清理，恢复后仍须核对该次目录；不要把超时停服务说成数据已清理。

版本、digest、日志和资源采样保留在调用目录 `build/logs/gitea-*`，不保留 token。
清理失败返回非零；验收结束检查：

```bash
podman ps -a --filter label=aicr.acceptance=gitea
find ~/workspace/github/atframework -maxdepth 1 -type d -name 'aicr-acceptance.*'
```

核对结果应无本轮容器/目录；若有其他验收并行运行，只处理日志中本轮的准确名称。
先检查失败日志，再重跑同一验收，不能将环境启动失败算作产品通过。
