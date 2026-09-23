# 本地临时服务验收

WSL2 Debian 可运行 rootless Podman 服务，并让 Windows 测试进程访问回环映射端口。
2026-09-22 实测 Debian 13.6、Podman 5.4.2、cgroup v2/systemd；
主机当前能力仍需用 `wsl --list --verbose`、`podman info`、`podman ps -a` 核对。
Podman fixture 只使用合成账户和仓库。真实飞书/LLM 验收单独通过环境变量启用，
普通测试不读取本地凭据文件。

Debian 容器统一通过 `tests/services/debian-mirror.sh` 使用中科大国内镜像，覆盖主仓库
与 `debian-security`，保留镜像原有 suite 和 Debian 签名校验。固定 slim 镜像没有 CA
证书，先通过 HTTP 镜像安装 `ca-certificates`，再切换 HTTPS 下载服务包；不关闭签名
或证书验证，不修改 WSL 宿主 APT 配置。配置依据[中科大 Debian 镜像帮助](https://mirrors.ustc.edu.cn/help/debian.html)
及[清华镜像的 HTTPS 引导说明](https://mirrors.tuna.tsinghua.edu.cn/help/debian/)。

## 按依赖选择服务

| 依赖 | 本地可验证 | 资源与剩余限制 |
| --- | --- | --- |
| Gitea | 真实 commit 作者关联、issue 发布及最终 assignees、权限失败 | 单容器 + SQLite，1 CPU / 512 MiB；关闭 SSH/Actions/邮件/注册。固定 1.25.4，不能替代其他版本/Forgejo/GitHub |
| Redis | 配置/队列/catalog、故障恢复与持久化 | 可复用本机镜像；普通和 OOM 独立容器，按测试实际峰值限额，只删自有前缀，禁止 FLUSHDB |
| PostgreSQL | 配置/业务存储、迁移与角色权限 | 独立 cluster；角色需 CREATE ROLE。共享迁移套件串行或独立数据库，不混用生产连接 |
| SVN | hook、diff、辅助仓库物化、分析与发布 | svnserve 单容器，1 CPU / 256 MiB；HTTPS/权限测试使用下述部署夹具 |
| GitLab | 真实仓库/token/webhook、push/MR 入队、managed issue 发布与成员指派、窗口外 MR 延期持久化与重启恢复 | 2 CPU / 6 GiB 单独串行；固定 `gitlab/gitlab-ce:19.4.0-ce.0`，omnibus 精简组件，首次引导 3-10 分钟。CE 语义不等同 EE/SaaS，不能替代其他版本 |
| 飞书、付费 LLM | 真实 API 短请求，见下文环境变量 | 飞书发送后撤回；LLM 每例一次、最多 256 输出 token，无自动重试。不能替代身份匹配质量或套餐边界验收 |

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
$nodePath = (Get-Command node).Source.Replace('\','/')
$wslNodePath = wsl -d Debian -- wslpath -u $nodePath
if (!$wslNodePath -or $LASTEXITCODE -ne 0) { throw 'Node path conversion failed' }
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

## GitLab 复现

在仓库根目录使用 Linux Node/pnpm（先 `pnpm install` 和 `pnpm build`：端到端用例通过
workspace 的 dist 出口启动真实 serve 子进程）：

```bash
bash tests/services/with-gitlab.sh bash -c \
  'pnpm --filter @aicr/outputs exec vitest run test/gitlab-assignment-live.test.ts &&
   pnpm --filter @aicr/server exec vitest run test/gitlab-flow-live.test.ts'
```

脚本要求 Podman、curl、node、timeout；数据目录、随机回环端口、本轮命名卷与
`AICR_ACCEPTANCE_ROOT` 语义与 Gitea 一致。external_url 携带发布端口，omnibus nginx
监听同端口；精简配置关闭 Prometheus 族/KAS/registry 并限制 puma/sidekiq 规模，
readiness 以 `/users/sign_in` 探测全栈。PAT 经 `gitlab-rails runner` 从 stdin 注入，
不出现在参数或日志。脚本传递 `AICR_GITLAB_TEST_URL` / `AICR_GITLAB_TEST_TOKEN`；
两变量都不设时明确跳过，只设一个或使用非回环 HTTP 地址时失败。容器运行上限 7200 秒。

webhook 目标是宿主回环（`host.containers.internal`），脚本启动时一次性开启
`allow_local_requests_from_web_hooks_and_services`；用例不要在收尾时复位该设置——
sidekiq 进程内设置缓存与快速开关存在竞态，会把后续投递拦成 `URL is blocked`
（投递记录见实例的 `web_hook_logs`，脚本失败退出时自动导出到
`build/logs/gitlab-webhooks.log`）。指派用例核验真实成员身份：GitLab 只允许给项目
成员指派，且 CE 静默丢弃 `assignee_ids` 复数形式（多人指派是 Premium 功能），发布器
对单个 assignee 使用 `assignee_id`。成员的指派资格由 `project_authorizations`
异步传播（busy 实例上延迟可达秒级），用例先以作者模拟令牌轮询 `read_project`
生效再发布。flow 用例经 `agent.default: native-llm` 直连回环假
OpenAI 端点返回固定评审，不调用付费 LLM；push 身份按设计来自 git 作者证据，用例经
`outputs.author_resolution.email_mappings` 解析为平台用户。MR 与窗口腿的 webhook
关闭 push 事件：夹具分支提交触发的 push 评审会按批次 scope 另建 issue 并与 MR 评审
竞争 assignee 归属。push 腿则按至多一次投递语义在等待期内重发提交触发器。管理员
账户必须用
`admin.username_env` / `admin.password_env` 环境变量形式：字面量 username 不生效，
没有管理员认证时 bootstrap 不建观测库（`needsStore=false`），窗口延期会静默降级为
进程内存，重启恢复证据丢失。

版本、digest、日志与资源采样保留在 `build/logs/gitlab-*`。

## SVN 复现

本机 PATH 需有 `svn`。在 Linux/WSL 中调用：

```bash
bash tests/services/with-svn.sh \
  pnpm exec vitest run packages/vcs/test/svn-context-live.test.ts \
    packages/server/test/svn-analysis-live.test.ts --maxWorkers=1
```

Windows Node 调用方式与 Gitea 相同，将脚本换成 `tests/services/with-svn.sh`，
用例换成上述两个文件。脚本传递 `AICR_SVN_TEST_URL`。
单容器只读 `svnserve` 提供两次合成提交；固定 revision/HEAD 导出、网络 diff、
失败目录与旧 alias 清理均走实际 VCS 代码；分析用例通过真实 orchestrator
执行取文件、上下文、确定性模型替身和输出发布断言，不调用付费 LLM。
既有本机 hook 测试继续用 `AICR_SVN_TEST_EXECUTABLE`，两种入口不混为同一证据。

镜像固定 digest，已存在时不重新拉取；`subversion=1.14.5-3` 在一次性容器内安装，
没有构建额外镜像或修改宿主软件。服务以 nobody 运行，仓库只在容器临时层中。
版本依据 [Debian 包目录](https://packages.debian.org/trixie/subversion)，
导出行为依据 [SVN export](https://svnbook.red-bean.com/en/1.7/svn.ref.svn.c.export.html)。
包版本从镜像源下架时须重新调研更新，不能自动切到未验收版本。

## WSL 部署认证与持久化

```bash
bash tests/services/with-deployment-services.sh
```

此入口在同一固定 Debian digest 容器中运行 PostgreSQL 17、Redis 与 Apache/SVN，
共享 1 CPU / 512 MiB、128 PID 限额。包候选由 Debian APT 元数据解析后按精确版本安装，
记录到 `build/logs/deployment-versions.log`；APT 包集合会随安全更新变化。
只发布随机回环端口。数据位于本轮命名卷，脚本按写入→停止→启动→读取检验持久化：

- PostgreSQL：SCRAM、校验证书的 TLS、拒绝明文和错误密码、只读角色拒绝写入。
- Redis：TLS-only、禁用默认用户、按命令和键前缀限制的 ACL、AOF 重启恢复。
- SVN：HTTPS Basic 认证、匿名拒绝、读者拒绝提交、写者提交触发真实 hook，
  核对 `www-data` 身份、显式 PATH 和重启后版本。

随机密码和一天有效期的自签证书仅供夹具；管理员用于建库与迁移权限测试，
不是生产角色模板。PostgreSQL 初始化密码文件按服务用户权限创建，初始化后删除；
不能让降权后的 `initdb` 重新打开 root 所有的 `/dev/stdin`。
依据：[PG TLS](https://www.postgresql.org/docs/17/ssl-tcp.html)、
[PG 认证](https://www.postgresql.org/docs/17/auth-pg-hba-conf.html)、
[Redis ACL](https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/)、
[Redis 持久化](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)、
[SVN HTTP 服务](https://svnbook.red-bean.com/en/1.8/svn.serverconfig.httpd.html)。

可追加测试命令。脚本设置 `AICR_PG_TEST_URL`、`AICR_REDIS_TEST_URL`、
`AICR_REDIS_OOM_TEST_URL` 和 `NODE_EXTRA_CA_CERTS`，只信任本轮 CA，不关闭证书验证。
OOM 使用独立 Redis 进程；主实例不受 CONFIG 故障注入影响。共享 PG 时串行运行：

```bash
bash tests/services/with-deployment-services.sh \
  pnpm exec vitest run --coverage --maxWorkers=1
```

Windows Node 同样可作为子命令；`WSLENV` 转换 CA 路径。运行账户需能读取 WSL 文件。
脚本清理自有容器、命名卷、目录及本轮新拉取镜像，错误返回非零。
不传命令时只做服务配置验收，不把它称为 AICR 全量 runtime 验收。

AICR 的 Redis 队列和自动批次存储保留完整连接 URL，由原生驱动解析 TLS、ACL 用户名
及编码凭据。依据锁文件中的 BullMQ 6.3.4 `RedisConnection.init` 和
[BullMQ 连接合同](https://docs.bullmq.io/guide/connections)、
[ioredis TLS/URI 说明](https://github.com/redis/ioredis#tls-options)。

## 真实账户验收

测试只读以下环境变量；整组未设时 skip，只设置部分或空值时 fail。
不要将真实环境变量放进常规全量测试进程，以免每次回归都通知群或消耗额度。

| 变量组 | 必需 | 可选 |
| --- | --- | --- |
| 飞书 | `AICR_FEISHU_TEST_APP_ID`、`AICR_FEISHU_TEST_APP_SECRET`、`AICR_FEISHU_TEST_RECEIVE_ID` | `AICR_FEISHU_TEST_DIRECTORY_CHAT_ID` 指定另一来源群；`AICR_FEISHU_TEST_MENTION_OPEN_ID` 指定获准通知的测试成员，未设则不 @ |
| 智谱 | `AICR_ZHIPU_TEST_BASE_URL`、`AICR_ZHIPU_TEST_API_KEY` | `AICR_ZHIPU_TEST_KIND` 为 `openai_compatible`（默认）或 `anthropic`；固定模型 glm-5.3-flash |
| Kimi | `AICR_KIMI_TEST_BASE_URL`、`AICR_KIMI_TEST_API_KEY` | `AICR_KIMI_TEST_KIND` 同上；固定模型 kimi-for-coding |

飞书调用真实 `FeishuAppClient` 和 dispatcher：检查群成员/资料权限，发送一条合成
JSON 2.0 卡片，并在 `afterAll` 撤回；目录只输出数量和字段可见性计数，不输出身份，
不送给 LLM。资料不可用会令对应测试失败，不用降级行为冒充权限通过。
API 成功不单独证明客户端显示；若另行验收真实 @ 投递，需指定测试成员核验。
本轮发送/撤回已由用户观察确认，跨群、重名与外部成员不纳入验收，见
[M31](ai/milestones/M31.md)。这些可选场景不阻塞当前验收关闭。
撤回依据[飞书官方接口](https://open.feishu.cn/document/server-docs/im-v1/message/delete)，
支持机器人撤回自己的消息。撤回失败令测试失败；进程强杀或发送结果未知时须核对测试群，
不能盲目重复发送。

LLM 调用实际 OpenAI/Anthropic 客户端；每个已启用供应商最多一次请求，60 秒取消，
最多 256 输出 token，关闭 thinking，无自动重试或模型回退。只发送合成代码，
保留供应商、协议、模型和 usage，不记录密钥、原始响应或错误正文。
测试检查非空回答及 usage；它不是质量 benchmark，也不证明 agent CLI 的接入或实际计费。
保持真实 `AICodeReviewer/acceptance` 客户端标识，不能冒充其他 CLI。
协议根路径依据 [Kimi 文档](https://www.kimi.com/code/docs/) 和
[智谱 Anthropic 文档](https://docs.bigmodel.cn/cn/guide/develop/claude/introduction)。

已有本地 secret YAML 时，在仓库根目录手动运行以下入口（需 Mike Farah yq v4）：

```bash
node tests/services/with-local-secrets.mjs feishu
node tests/services/with-local-secrets.mjs zhipu
node tests/services/with-local-secrets.mjs kimi
node tests/services/with-local-secrets.mjs zhipu anthropic
node tests/services/with-local-secrets.mjs kimi anthropic
```

helper 从 `development/secret/secret.yaml` 逐字段读取：飞书
`.channel.feishu_app.{app_id,app_secret,receive_id}`，智谱 `.llm.provider.zhipu.{baseURL,token}`，
Kimi `.llm.provider.kimi_coding_backup.{baseURL,token}`。值只传给子进程，不保存为 `.env`。
Anthropic 映射只接受代码中列出的两个官方 OpenAI 根地址；其他端点手动配置环境变量，
避免猜测协议路径。CI 也直接提供环境变量并运行对应 Vitest 文件，不读取本地 YAML。

无需真实账户的 CLI 参数/环境注入、套餐端点选择、额度错误分类、限流重试与恢复，
由 agents、provider-presets、gateway、rate-limiter、review-orchestrator 等单元测试覆盖。
环境变量门控的短请求用于可选连通性检查；实际供应商扣费归属无法由单元测试证明。

## 生命周期与清理

容器绑定 `127.0.0.1` 随机端口，无 restart policy。
脚本在成功、失败、INT/TERM/HUP 时移除自己的容器、命名卷及临时目录；仅当镜像原先不存在时
删除本轮拉取的镜像，不执行全局 prune，也不修改已有容器。
Podman `--timeout 900`（GitLab 为 7200）给每次容器启动设置独立于测试进程的运行上限；
Gitea/SVN 同时使用 `--rm`，需要重启的部署夹具由 trap 移除。
语义见[Podman 5.4.2 run](https://docs.podman.io/en/v5.4.2/markdown/podman-run.1.html)。
SIGKILL/主机断电无法执行 shell 清理，恢复后仍须核对该次目录；不要把超时停服务说成数据已清理。

版本、digest、日志和资源采样保留在调用目录 `build/logs/gitea-*`、`build/logs/svn-*`
与 `build/logs/deployment-*`，不保留 token。
清理失败返回非零；验收结束检查：

```bash
podman ps -a --filter label=aicr.acceptance=gitea
podman ps -a --filter label=aicr.acceptance=svn
podman ps -a --filter label=aicr.acceptance=gitlab
podman ps -a --filter label=aicr.acceptance=deployment
podman volume ls --filter name=aicr-deployment
find ~/workspace/github/atframework -maxdepth 1 -type d -name 'aicr-acceptance.*'
find ~/workspace/github/atframework -maxdepth 1 -type d -name 'aicr-deployment.*'
```

核对结果应无本轮容器/目录；若有其他验收并行运行，只处理日志中本轮的准确名称。
先检查失败日志，再重跑同一验收，不能将环境启动失败算作产品通过。
