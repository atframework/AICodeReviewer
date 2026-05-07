# 任务执行提示词

## CodeReview

请分析 Plan.md 和当前阶段的代码实现，分析并修复问题并尽可能补全单元测试。

## Continue Plan

请分析Plan.md和当前实现的进度，继续执行计划。

请分析Plan.md和当前实现的进度，先跳过依赖外部VCS（gitea,github等）验收部分，本地有kili命令行工具，继续执行计划。

## 验收

- 仅剩真实 Gitea e2e 验收（本地 docker 起 Gitea → PR 触发 → 看到 line comment）。其余 M1 核心能力（webhook → VCS → prompt → LLM → output 全链路 + 配置驱动 + CLI serve/dry-run）已全部落地。
- 使用真实 Kilo CLI 做完整 agent review。
- 未用真实 Docker/Podman 容器跑恶意 PR sandbox escape 场景。
- 队列/并发/限流和多事件路由的压力型测试仍可继续加强。
- M0.5/M1/M2 验收留存项

- LLM的baseURL请使用 `jq ".xiaomimimo_token_plan.baseURL"  ".vscode/secret.json"` 提。
- LLM的token通过 `jq ".xiaomimimo_token_plan.token"  ".vscode/secret.json"` 提取。
- gitea的token使用 `jq ".gitea.token"  ".vscode/secret.json"` 提取。
- 当前测试和验证的执行流程禁止提交token到任何API，仅允许通过命令行工具提取。
- 注意所有的命令执行都要防止流程卡死（如果长时间无任何输出则要强制kill掉）。超时后需要先尝试清理之前卡住的进程。
- 远程部署时，请使用 `ssh -p 36000 -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o User=tools -i D:/workspace/keys/id_ed25519.it 10.64.8.2` 连接远程服务器，部署到 `/data/disk2/AICodeReviewer` 目录。
  - 使用podman构建和运行镜像
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
    - <https://git.m-oa.com:6023/ProjectY/server>
    - <https://git.m-oa.com:6023/ProjectY/pipeline>
    - <https://git.m-oa.com:6023/ProjectY/robot>
    - <https://git.m-oa.com:6023/ProjectX/server>
    - <https://git.m-oa.com:6023/ProjectX/Pipeline>
