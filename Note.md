# AICR 操作备忘与任务提示

> 本文件是面向本仓库维护者的**任务与部署备忘**，不是仓库全局常驻指令。
> AI agent 开始工作时仍应优先遵守 `AGENTS.md`，并按任务类型读取相关 `.agents/skills/*/SKILL.md`。

## 1. 使用原则

- 先明确目标，再列约束，再执行验证；不要把历史背景、secret、部署步骤混进同一段自由文本。
- `Plan.md` 只作为当前路线图入口；需要稳定设计或历史阶段信息时，先读 `docs/ai/index.md`，再按需打开对应文档。
- 修改代码时优先补测试；修改配置、输出通道、部署行为或公开工作流时，同步更新 `Plan.md` 摘要、相关 `docs/`、`example/config.yaml` 与 `example/README.md`，或明确说明无需更新。
- 临时脚本、调试日志和一次性报告放在 `build/` 下，不放仓库根目录。
- 只验证本轮新增或修复的能力；生产签收仍以 Kilo Code 端到端验收为准。

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

- 永远不要打印 `.vscode/secret.json`、`.env` 或任何完整 secret 文件。
- 只用 `jq -r '<json-path>' .vscode/secret.json` 提取当前步骤需要的单个值，并直接赋给变量或环境变量。
- 不要把 token、签名密钥、API key 发送给 LLM、日志系统、issue、PR 评论或 IM 输出。
- 如果终端输出、debug log 或报告中可能包含 secret，只说明风险和清理/轮换建议，不复述 secret 原文。
- 命令示例必须使用占位变量；不要把真实值写进文档、脚本或 prompt。

示例模式：

```bash
LLM_BASE_URL="$(jq -r '.xiaomimimo_token_plan.baseURL' .vscode/secret.json)"
LLM_TOKEN="$(jq -r '.xiaomimimo_token_plan.token' .vscode/secret.json)"
```

## 4. Secret selector 速查

### LLM 默认 selector

| 用途    | selector                         |
| ------- | -------------------------------- |
| baseURL | `.xiaomimimo_token_plan.baseURL` |
| token   | `.xiaomimimo_token_plan.token`   |

### 生产模型优先级

| 顺序 | baseURL selector                    | token selector                    | 模型           |
| ---- | ----------------------------------- | --------------------------------- | -------------- |
| 1    | `.aliyun_coding_plan.baseURL`       | `.aliyun_coding_plan.token`       | `glm-5`        |
| 2    | `.tencentcloud_coding_plan.baseURL` | `.tencentcloud_coding_plan.token` | `glm-5`        |
| 3    | `.aliyun_coding_plan.baseURL`       | `.aliyun_coding_plan.token`       | `kimi-k2.5`    |
| 4    | `.tencentcloud_coding_plan.baseURL` | `.tencentcloud_coding_plan.token` | `kimi-k2.5`    |
| 5    | `.aliyun_coding_plan.baseURL`       | `.aliyun_coding_plan.token`       | `qwen3.6-plus` |

### VCS 与输出 selector

| 系统               | 字段               | selector                              |
| ------------------ | ------------------ | ------------------------------------- |
| Gitea              | token              | `.gitea.token`                        |
| Gitea              | webhook secret     | `.gitea.webhook_secret`               |
| Gitea              | watch path         | `.gitea.watch_path`                   |
| Gitea              | include files      | `.gitea.include_cr_file`              |
| Gitea              | exclude files      | `.gitea.exclude_cr_file`              |
| GitHub atframework | token              | `.github-atframework.token`           |
| GitHub atframework | webhook secret     | `.github-atframework.webhook_secret`  |
| GitHub atframework | watch path         | `.github-atframework.watch_path`      |
| GitHub atframework | include files      | `.github-atframework.include_cr_file` |
| GitHub atframework | exclude files      | `.github-atframework.exclude_cr_file` |
| GitHub owent       | token              | `.github-owent.token`                 |
| GitHub owent       | webhook secret     | `.github-owent.webhook_secret`        |
| GitHub owent       | watch path         | `.github-owent.watch_path`            |
| GitHub owent       | include files      | `.github-owent.include_cr_file`       |
| GitHub owent       | exclude files      | `.github-owent.exclude_cr_file`       |
| P4                 | username           | `.p4.username`                        |
| P4                 | password           | `.p4.password`                        |
| P4                 | depot path         | `.p4.depot_path`                      |
| P4                 | port               | `.p4.port`                            |
| P4                 | analysis workspace | `.p4.workspace`                       |
| P4                 | webhook secret     | `.p4.webhook_secret`                  |
| P4                 | watch path         | `.p4.watch_path`                      |
| P4                 | include files      | `.p4.include_cr_file`                 |
| P4                 | exclude files      | `.p4.exclude_cr_file`                 |
| Feishu robot       | webhook            | `.feishu_robot.webhook`               |
| Feishu robot       | token              | `.feishu_robot.token`                 |
| AICR server        | global API key     | `.aicr_server.api_key`                |

### GitHub repo → selector / trigger / workspace 映射

| GitHub 仓库                | 本地 selector 组       | 远端 trigger          | 远端 workspace       | 说明                           |
| -------------------------- | ---------------------- | --------------------- | -------------------- | ------------------------------ |
| `atframework/atsf4g-co`    | `github-atframework`   | `github-atframework`  | `github-atsf4g-co`   | 保持现有仓库，继续独立配置     |
| `owent/libatapp`           | `github-owent`         | `github-owent`        | `github-libatapp`    | 新增仓库，独立 token/secret/filter |

- `/webhooks/github` 现在允许挂多个 GitHub trigger profile；服务端会先按 webhook secret 校验，再按 `repository.full_name` 选择最终 trigger。
- 不同 GitHub 仓库若使用不同 token、webhook secret、`watch_path`、`include_cr_file`、`exclude_cr_file`，不要继续复用同一个 trigger。
- 远端 `.env` 需要同时保留 `GITHUB_ATFRAMEWORK_*` 与 `GITHUB_OWENT_*` 两组变量名；值仍从对应 selector 单独提取，禁止互相复用或打印原文。

## 5. P4 操作边界

- P4 拉取必须保持最小范围，只拉取本次 review 必需文件，不做全仓库拉取。
- P4 trigger 当前通过 AICR API Key 保护；`p4.webhook_secret` 为预留项。
- P4 trigger 脚本：`example/p4-trigger.sh`。
- 运行 trigger 时使用环境变量：
  - `AICR_URL=https://aicr.m-oa.com:6023`
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
- 文档-only 变更至少运行 markdownlint；若会影响镜像或部署包，仍需验证服务健康检查。
- 代码或配置变更按 `AGENTS.md` 默认验证顺序执行。

### Health check

远程服务地址：`https://aicr.m-oa.com:6023`（反向代理到 `http://10.64.8.2:8090`）。

```bash
curl -sf https://aicr.m-oa.com:6023/healthz
# 预期输出: ok
```

## 7. 远程部署备忘

- 远程服务器：`10.64.8.2`
- SSH 用户：`tools`
- SSH 端口：`36000`
- SSH key：`D:/workspace/keys/id_ed25519.it`
- 部署目录：`/data/disk2/AICodeReviewer`
- 容器引擎：Podman
- 反向代理：`https://aicr.m-oa.com:6023` → `http://10.64.8.2:8090`

远程部署时优先读取 `.agents/skills/remote-deployment/SKILL.md`，并遵守以下约束：

- 使用 `tar + scp + ssh` 同步文件，不依赖 Windows 上不可用的 `rsync`。
- 不打印远程 `.env` 或本地 `.vscode/secret.json`。
- 修改远程 `config.yaml` 时使用定点文本替换，不通过 YAML parser round-trip，避免破坏 anchors/aliases。
- 使用远端 `deploy.sh` 构建和重启服务。
- 部署后验证远端本机 `/healthz` 与反向代理 `/healthz`。

标准 SSH 选项：

```bash
ssh -p 36000 -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no \
  -o User=tools -i D:/workspace/keys/id_ed25519.it 10.64.8.2
```

## 8. 生产配置目标

- 测试环境公共系统提示词应包含“使用简体中文回答最终分析报告”。
- AICR 需要支持 PR/MR，也需要支持新 commit 自动触发分析。
- 对于 Gitea 输出：
  - 有问题时支持自动创建 issue。
  - 自动创建的 issue / PR / MR 需通过可配置标题前缀、tag 或标签标识来源。
  - 后续提交修复问题、代码位置无效或问题过期时，应支持自动关闭或删除旧 issue。

## 9. 已配置 review 目标

- Gitea：`https://git.m-oa.com:6023/ProjectY/server`
- Gitea：`https://git.m-oa.com:6023/ProjectY/pipeline`
- Gitea：`https://git.m-oa.com:6023/ProjectY/robot`
- Gitea：`https://git.m-oa.com:6023/ProjectX/server`
- Gitea：`https://git.m-oa.com:6023/ProjectX/Pipeline`
- P4：`ssl:p4.m-oa.com:8666`
- GitHub：`https://github.com/atframework/atsf4g-co`
- GitHub：`https://github.com/owent/libatapp`

## 10. 命令执行守则

- 命令必须设置合理超时，避免流程卡死。
- 如果命令长时间无输出或超时，先尝试清理卡住进程，再重试或换方案。
- 交互式命令需要逐个 prompt 处理，不要一次性发送多段输入。
- 运行验证命令时遵守 `AGENTS.md` 的 Windows PowerShell workaround：优先用 `node` 直接调用 CLI，避免 `.ps1` 执行策略问题。
