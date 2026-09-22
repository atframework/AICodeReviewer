# 本地临时服务验收

WSL2 Debian 可运行 rootless Podman 服务，并让 Windows 测试进程访问回环映射端口。
2026-09-22 实测 Debian 13.6、Podman 5.4.2、cgroup v2/systemd；
主机当前能力仍需用 `wsl --list --verbose`、`podman info`、`podman ps -a` 核对。
Podman fixture 只使用合成账户和仓库。真实飞书/LLM 验收单独通过环境变量启用，
普通测试不读取本地凭据文件。

## 按依赖选择服务

| 依赖 | 本地可验证 | 资源与剩余限制 |
| --- | --- | --- |
| Gitea | 真实 commit 作者关联、issue 发布及最终 assignees、权限失败 | 单容器 + SQLite，1 CPU / 512 MiB；关闭 SSH/Actions/邮件/注册。固定 1.25.4，不能替代其他版本/Forgejo/GitHub |
| Redis | 配置/队列/catalog、故障恢复与持久化 | 可复用本机镜像；普通和 OOM 独立容器，按测试实际峰值限额，只删自有前缀，禁止 FLUSHDB |
| PostgreSQL | 配置/业务存储、迁移与角色权限 | 独立 cluster；角色需 CREATE ROLE。共享迁移套件串行或独立数据库，不混用生产连接 |
| SVN | hook、diff、辅助仓库物化与本地身份合同 | svnserve 单容器，1 CPU / 256 MiB；Debian digest 与 Subversion 1.14.5-3 固定，本机复用 SVN 客户端；HTTP(S)/ACL 另验 |
| GitLab | 本地真仓库/token/webhook、push/MR 入队与发布 | 可自建，但官方受限单节点至少 8 GB 内存；本轮不启动。单独串行安排，关闭非必要组件，固定镜像后再制定版本对应配置 |
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

## SVN 复现

本机 PATH 需有 `svn`。在 Linux/WSL 中调用：

```bash
bash tests/services/with-svn.sh \
  pnpm exec vitest run packages/vcs/test/svn-context-live.test.ts --maxWorkers=1
```

Windows Node 调用方式与 Gitea 相同，将脚本换成 `tests/services/with-svn.sh`，
用例换成 `packages/vcs/test/svn-context-live.test.ts`。脚本传递 `AICR_SVN_TEST_URL`。
单容器只读 `svnserve` 提供两次合成提交；固定 revision/HEAD 导出、网络 diff、
失败目录与旧 alias 清理均走实际 VCS 代码。agent 的容器只读挂载仍需独立验收。
既有本机 hook 测试继续用 `AICR_SVN_TEST_EXECUTABLE`，两种入口不混为同一证据。

镜像固定 digest，已存在时不重新拉取；`subversion=1.14.5-3` 在一次性容器内安装，
没有构建额外镜像或修改宿主软件。服务以 nobody 运行，仓库只在容器临时层中。
版本依据 [Debian 包目录](https://packages.debian.org/trixie/subversion)，
导出行为依据 [SVN export](https://svnbook.red-bean.com/en/1.7/svn.ref.svn.c.export.html)。
包版本从镜像源下架时须重新调研更新，不能自动切到未验收版本。

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
发送只证明 API 接受；真实 @ 投递和客户端显示仍需指定测试成员后核验。
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

## 生命周期与清理

容器绑定 `127.0.0.1` 随机端口，无 restart policy。
脚本在成功、失败、INT/TERM/HUP 时移除自己的容器及临时目录；仅当镜像原先不存在时
删除本轮拉取的镜像，不执行全局 prune，也不修改已有容器。
Podman `--rm --timeout 900` 给服务设置独立于测试进程的运行上限；
语义见[Podman 5.4.2 run](https://docs.podman.io/en/v5.4.2/markdown/podman-run.1.html)。
SIGKILL/主机断电无法执行 shell 清理，恢复后仍须核对该次目录；不要把超时停服务说成数据已清理。

版本、digest、日志和资源采样保留在调用目录 `build/logs/gitea-*` / `build/logs/svn-*`，不保留 token。
清理失败返回非零；验收结束检查：

```bash
podman ps -a --filter label=aicr.acceptance=gitea
podman ps -a --filter label=aicr.acceptance=svn
find ~/workspace/github/atframework -maxdepth 1 -type d -name 'aicr-acceptance.*'
```

核对结果应无本轮容器/目录；若有其他验收并行运行，只处理日志中本轮的准确名称。
先检查失败日志，再重跑同一验收，不能将环境启动失败算作产品通过。
