# 任务执行提示词

## CodeReview

请分析 Plan.md 和当前阶段的代码实现，分析并修复问题并尽可能补全单元测试。

## 验收

- 部署测试必须使用 **Kilo Code** 做至少一次完整端到端验证，确认真实 agent 路径可用，而不是只验证 direct LLM / `native-llm` 路径。
  - `example/config.yaml` 的默认验收路径应保持 `agent.default: kilo`。
  - Kilo CLI 可作为自动化烟测补充，但不能替代 Kilo Code 人工确认。
  - 验收至少覆盖：触发入口（Gitea webhook 或 P4 trigger）→ VCS 最小拉取 / diff → Kilo agent → AICR MCP 工具提交 problem/summary → 输出通道（PR/MR/Issue/飞书/企微）。
  - 在 Kilo `.kilo/mcp.json` 与外部 `aicr-output` stdio/HTTP MCP 服务补齐前，Kilo 验收只能算 agent/stdout tool-call 兼容路径通过，不能关闭外部 MCP 服务验收项。
  - 生产发布前若 Kilo Code 无法完成 MCP 工具调用或输出发布，视为部署未通过。
- LLM的baseURL请使用 `jq ".xiaomimimo_token_plan.baseURL" ".vscode/secret.json"` 提。
- LLM的token通过 `jq ".xiaomimimo_token_plan.token" ".vscode/secret.json"` 提取。
- gitea环境提取方式如下:
  - token使用 `jq ".gitea.token" ".vscode/secret.json"` 提取。
  - webhook签名密钥: `jq ".gitea.webhook_secret" ".vscode/secret.json"`
  - 关注的路径: `jq ".gitea.watch_path" ".vscode/secret.json"`
  - 要分析(包含)的代码: `jq ".gitea.include_cr_file" ".vscode/secret.json"`
  - 忽略(不包含)的代码: `jq ".gitea.exclude_cr_file" ".vscode/secret.json"`
- github环境(atframework下的仓库)提取方式如下:
  - token使用 `jq ".github-atframework.token" ".vscode/secret.json"` 提取。
  - webhook签名密钥: `jq ".github-atframework.webhook_secret" ".vscode/secret.json"`
  - 关注的路径: `jq ".github-atframework.watch_path" ".vscode/secret.json"`
  - 要分析(包含)的代码: `jq ".github-atframework.include_cr_file" ".vscode/secret.json"`
  - 忽略(不包含)的代码: `jq ".github-atframework.exclude_cr_file" ".vscode/secret.json"`
- p4环境提取方式如下:
  - 用户名: `jq ".p4.username" ".vscode/secret.json"`
  - 密码: `jq ".p4.password" ".vscode/secret.json"`
  - Depot(Stream类型): `jq ".p4.depot_path" ".vscode/secret.json"`
  - P4服务器地址: `jq ".p4.port" ".vscode/secret.json"`
  - 当前工具使用的P4 Workspace名: `jq ".p4.workspace" ".vscode/secret.json"`
  - P4 trigger签名密钥: `jq ".p4.webhook_secret" ".vscode/secret.json"` (预留，当前P4通过API Key保护)
  - 关注的路径: `jq ".p4.watch_path" ".vscode/secret.json"`
  - 要分析(包含)的代码: `jq ".p4.include_cr_file" ".vscode/secret.json"`
  - 忽略(不包含)的代码: `jq ".p4.exclude_cr_file" ".vscode/secret.json"`
  - 请确保p4拉取时仅仅拉取最小所需的代码，不要全仓库拉取。
- 飞书机器人
  - Webhook地址通过 `jq ".feishu_robot.webhook" ".vscode/secret.json"` 提取。
  - token通过 `jq ".feishu_robot.token" ".vscode/secret.json"` 提取。
- AICR服务端全局API Key: `jq ".aicr_server.api_key" ".vscode/secret.json"` 提取。
  - 仅保护 /triggers/* 端点（P4 等），通过 X-API-Key 头或 Authorization: Bearer 头。
  - /webhooks/* 端点（Gitea、GitHub、GitLab）使用 HMAC 签名验证，不经过 API Key。
- 当前测试和验证的执行流程禁止提交token到任何API，仅允许通过命令行工具提取。
- 注意所有的命令执行都要防止流程卡死（如果长时间无任何输出则要强制kill掉）。超时后需要先尝试清理之前卡住的进程。
- 远程部署时，请使用 `ssh -p 36000 -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o User=tools -i D:/workspace/keys/id_ed25519.it 10.64.8.2` 连接远程服务器，部署到 `/data/disk2/AICodeReviewer` 目录。
  - 使用podman构建和运行镜像
  - 部署的测试环境的公共系统提示词里请增加“使用简体中文回答最终分析报告”
  - 我不仅仅需要支持MR/PR，也需要有新的commit时自动执行分析
    - 对于gitea输出，支持分析代码并在分析到有问题时自动创建issue。
    - 自动创建的issue和PR/MR，请通过标题前缀或者tag、标签来标识是否是当前工具创建的。需要可配置。
    - 后续有新的提交时，如果之前的issue的代码已经修复、代码位置无效、或者过期。需要能够自动删除。
  - 反向代理地址: <https://aicr.m-oa.com:6023> -> <http://10.64.8.2:8090>
  - LLM模型列表和使用优先级如下:
    - baseURL: `".aliyun_coding_plan.baseURL" ".vscode/secret.json"` 提取, token: `".aliyun_coding_plan.token" ".vscode/secret.json"` 提取, 模型: glm-5
    - baseURL: `".tencentcloud_coding_plan.baseURL" ".vscode/secret.json"` 提取, token: `".tencentcloud_coding_plan.token" ".vscode/secret.json"` 提取, 模型: glm-5
    - baseURL: `".aliyun_coding_plan.baseURL" ".vscode/secret.json"` 提取, token: `".aliyun_coding_plan.token" ".vscode/secret.json"` 提取, 模型: kimi-k2.5
    - baseURL: `".tencentcloud_coding_plan.baseURL" ".vscode/secret.json"` 提取, token: `".tencentcloud_coding_plan.token" ".vscode/secret.json"` 提取, 模型: kimi-k2.5
    - baseURL: `".aliyun_coding_plan.baseURL" ".vscode/secret.json"` 提取, token: `".aliyun_coding_plan.token" ".vscode/secret.json"` 提取, 模型: qwen3.6-plus
  - 已经设置CodeReview的仓库如下:
    - gitea: <https://git.m-oa.com:6023/ProjectY/server>
    - gitea: <https://git.m-oa.com:6023/ProjectY/pipeline>
    - gitea: <https://git.m-oa.com:6023/ProjectY/robot>
    - gitea: <https://git.m-oa.com:6023/ProjectX/server>
    - gitea: <https://git.m-oa.com:6023/ProjectX/Pipeline>
    - p4: <ssl:p4.m-oa.com:8666>
    - github: <https://github.com/atframework/atsf4g-co>
  - P4 trigger脚本: `example/p4-trigger.sh`
    - 环境变量: `AICR_URL=https://aicr.m-oa.com:6023`, `AICR_API_KEY`
    - `AICR_DEPOT_PATH` 可省略，默认使用 AICR 服务端 `config.yaml` 中 P4 trigger 的 `depot_path`；仅在脚本需要覆盖服务端配置时设置。

## 部署验证

远程服务地址: `https://aicr.m-oa.com:6023` (反向代理 → `http://10.64.8.2:8090`)

### 验证 healthz (无需认证)

```bash
curl -sf https://aicr.m-oa.com:6023/healthz
# 预期输出: ok
```

### 验证新功能

不需要每次都全部重新验证，重点验证本轮任务新增的功能和修复的功能即可。
