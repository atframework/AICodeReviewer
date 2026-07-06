# AICodeReviewer 实施计划

> `Plan.md` 只承担**前瞻型路线图**职责：说明当前方向、活跃里程碑、
> 下一执行包、外部验收项和稳定合同入口。
>
> 已完成阶段的长篇总结在 `docs/ai/milestones/*.md`；稳定设计合同在
> `docs/ai/architecture.md`；长期决策在 `docs/ai/decisions.md`。不要把这些
> 历史正文再次复制回本文件。

## 1. 文档角色与当前目标

### 1.1 维护原则

- 本文件只回答“现在做什么、下一步做什么、哪些仍未完成”。
- 已完成内容只保留一行状态和归档链接；实现细节读 `docs/ai/index.md` 后按需跳转。
- 未完成内容分为两类：本地可闭环执行包和依赖外部系统的 Backlog。
- 已完成阶段中残留的未验收项必须移到 Backlog，不再和“已完成”正文交叉表述。
- 当代码、配置、输出合同、部署或公共 workflow 变化时，同步更新相关 `docs/`、
  `example/` 与本计划摘要；若无需更新，变更说明里写明原因。

### 1.2 当前焦点

- M0-M10 的主要实现已归档，当前没有新的运行时代码本地执行包。
- 当前活跃方向是 M11：可发布到 GitHub Pages 的用户文档站子工程。M11-P1（脚手架）、
  M11-P2（骨架 + 首批核心页）、M11-P3（全章节双语正文迁移）和 M11-P5（发布 workflow）已完成；
  下一步是 Pages 设置核验与 M11-P6 打磨（链接检查、配置字段覆盖校验）。
- 仍需真实外部系统验收的项目集中在 §8.4，避免散落在已完成里程碑描述中。

### 1.3 文档地图

- `docs/ai/index.md`：AI 文档总导航。
- `docs/ai/architecture.md`：稳定架构与实现合同。
- `docs/ai/decisions.md`：长期有效决策索引。
- `docs/ai/documentation-site-plan.md`：M11 文档站子工程建设计划。
- `docs/ai/milestones/*.md`：已完成阶段归档。
- `docs/site/`：M11 用户文档站子工程（Astro Starlight，中英双语），公开用户入口。
- `docs/prompt-research.md`：默认评审 prompt 调研依据。
- `docs/output-channels.md`：输出通道、模板与 MCP 输出工具合同。
- `docs/podman.md`：Podman 沙箱与部署专题说明。
- `example/README.md`：示例配置、运行与部署入口。

## 2. 技术方向与仓库组织

### 2.1 技术栈摘要

- 核心实现使用 TypeScript / Node，仓库使用 pnpm workspace。
- review 流程长期主路径是“服务编排 + AgentAdapter + Sandbox + Output Pipeline”。
- 单容器自托管是主部署路径，Podman 与 Docker 平等支持。
- 用户文档站计划采用 Node/pnpm 生态的静态站点生成方案，避免引入独立 Python/Ruby
  工具链作为主路径。

### 2.2 目录与 workspace 布局

- 运行时代码包继续放在 `packages/*`。
- runtime workspace 采用 `workspaces/<workspace_id>/` 扁平布局。
- 未来文档站子工程建议放在 `docs/site`，作为 `docs/` 下的“文档应用”接入 pnpm workspace；
  它不应被误加入根 `tsconfig.json` 的运行时代码 project references。
- 若新增 `docs/site`，必须同时规划精确 workspace 条目、根 scripts、CI、Docker build 过滤边界和发布 workflow，
  避免文档站依赖进入运行时镜像。

### 2.3 AI 资产组织原则

- `AGENTS.md` 是唯一常驻仓库级规则源。
- `.agents/skills/*/SKILL.md` 是 canonical workflow 技能源。
- 已完成阶段长文总结放到 `docs/ai/milestones/*.md`。
- prompt/skill 只保留稳定约束和入口索引，不复制历史大段正文。

## 3. 核心组件摘要

> 本节只保留路线图级摘要和稳定引用。详细合同见 `docs/ai/architecture.md`。

### 3.1 触发器与 ReviewEvent

- 所有 webhook、trigger、手工和定时入口都归一到统一 `ReviewEvent`。
- async 入口以 `202 + runId` 作为非阻塞语义。
- PR review request、评论命令 re-review、push 全零 SHA 跳过、trigger 去重等稳定行为见
  `docs/ai/architecture.md` §3.1。

### 3.2 VCS adapter 与 scoped fetch

- VCS 访问保持统一三段式合同：列举变更、scoped fetch、额外上下文/归因。
- Git、P4、SVN、GitHub、GitLab、Gitea/Forgejo 差异留在适配层。
- `aicr.fetch_more_context` 与 `aicr.try_blame` 是只读上下文工具，详细边界见
  `docs/ai/architecture.md` §3.2、§3.9.2。

### 3.3 Compression 与上下文管理

- AICR 侧 diff 压缩和 agent 运行时 auto-compaction 是两层互补能力。
- 未显式配置时，压缩阈值从模型 context window 派生。
- Kilo 等 agent 需要可用的 `contextWindow` 元数据才能正确自动压缩。

### 3.4 Secrets Scrubber

- Scrubber 覆盖 prompt 前、日志/模板渲染和输出前边界。
- 脱敏是兜底，不替代最小暴露原则。

### 3.5 LLM Gateway、Fallback 与预算

- LLM 调用通过统一 gateway 进入 provider client。
- bounded retry、fallback chain、预算、速率限制与队列 retry 分层治理。
- 成本估算按非缓存输入、缓存命中、缓存写入、输出 token 类别计费。

### 3.6 Prompt Manager 与 AI 资产装配

- 保护性规则、用户公共层、工程层规则按稳定优先级合并。
- repo-local `AGENTS.md`、path instructions 与 skills 自动发现、去重和冲突检测。
- 每次 agent run 必须通过 runtime bundle 物化 instructions、skills、MCP 工具、env 与 manifest。

### 3.7 AgentAdapter 与模型翻译

- Kilo、Claude Code、OpenCode、Zoo、Copilot CLI 等 adapter 共用统一 runtime 合同。
- `ModelSpec` / `thinkingLevel` 在 adapter 内翻译到 provider 原生字段。
- 能力不支持时在 manifest 显式降级，而不是静默忽略。

### 3.8 SandboxBackend

- native、docker、podman 是当前主路径；`k8s_pod`、`firecracker` 仍为预留扩展。
- 容器后端必须执行 allowlist、只读源码挂载、隔离 cwd、env-file 外置和超时治理。
- 进程超时必须杀整棵进程树；外层容器必须用 `--init` 回收僵尸进程。

### 3.9 输出通道、模板与 MCP 工具

- 稳定工具集合为 `aicr.report_problem`、`aicr.publish_summary`、`aicr.skip`、
  `aicr.fetch_more_context`、`aicr.try_blame`。
- Agent CLI 自由文本 stdout 不作为正式问题报告。
- PR review summary 更新、managed problem issue 生命周期、IM Markdown 转换和
  `no_problems` 策略见 `docs/output-channels.md` 与 `docs/ai/architecture.md` §3.9。

### 3.10 配置体系

- 配置 schema 的代码真源是 `packages/core/src/config.ts`。
- `workspaces.cache` / `workspaces.defaults` / `workspaces.instances.<id>` 是稳定命名空间。
- 顶层 `storage` 统一承载 database/cache/object 配置。
- 配置变更必须同步 schema 测试、示例配置、专题文档和本计划摘要。

### 3.11 Run 状态与可观测性

- 持久化 schema 的代码真源是 `packages/store/src/schema.ts`。
- async trigger、失败报告、publisher 行为、dashboard 和 replay 统一落在可观测性合同里。
- Dashboard 已覆盖 Overview / Projects / Providers / Runs 及 today/thisWeek/thisMonth/all
  时间维度；日汇总分区按 UTC day。

### 3.12 Reflection 与 memory

- light mode、thorough mode 最小跨 run 聚合、repo 约定学习与 prompt 自动注入已交付。
- memory 按 workspace 隔离，稳定 fingerprint 幂等覆盖，跨 workspace 知识迁移明确不做。

### 3.13 模型元数据 Catalog

- M10 已基本交付：models.dev 元数据可补齐 context window、输出上限、价格和模型能力。
- SQLite、memory 与 Redis 结构化后端可用；Redis 复用 `storage.cache.redis`。
- 用户显式配置优先于 catalog；缺失字段不臆造。

### 3.14 用户文档站

- M11 目标是创建独立、可维护、可静态导出的用户文档站。
- M11-P1（脚手架）、M11-P2（骨架 + 首批核心页）和 M11-P3（全章节双语正文）已完成：
  基于 Astro v7 / Starlight v0.41 的 `docs/site` 子工程接入 pnpm workspace，CI 含
  独立 docs job（`pnpm docs:build`，含公开/内部内容边界校验），GitHub Pages workflow 已切到 `gh-pages` 分支发布链路（使用 `DEPLOY_DOCUMENT_GH_PAGES_KEY` SSH deploy key），中英双语并行（全部带前缀 `/en/` + `/zh-cn/`），全部章节双语正文已落地。
- 选型、内容结构、工程集成、GitHub Pages 发布与验收计划见
  `docs/ai/documentation-site-plan.md`。
- 边界：`docs/site` 不进根 `tsconfig.json` references；root `build` 已收紧为
  `--filter "./packages/*"`；runtime Dockerfile 不复制 `docs/site`，Astro/Starlight
  不进入运行时镜像。

## 4. 默认评审 Prompt 原则

- 默认 system prompt 只保留稳定硬规则、输出协议与安全边界。
- 调研依据与样例保留在 `docs/prompt-research.md`。
- repo-local AI 资产按路径与优先级按需装配，不整仓注入。
- 工具合同由实现与注册表定义，不靠 prompt 发明字段。

## 5. 用户入口与专题文档

- 当前用户入口仍以 `example/README.md`、`docs/output-channels.md`、`docs/podman.md`
  和代码示例为主。
- M11 完成后，GitHub Pages 文档站将成为对外用户入口；仓库内 `docs/ai/*` 继续承担
  内部架构、路线图和 agent 维护上下文。
- 文档站不应直接发布全部 `docs/ai/*` 内容，避免把内部路线图、agent 规则和运维细节混入
  用户手册。

## 6. 安全与运营基线

- 先鉴权，后入队。
- secret scrubber 覆盖 prompt、日志和输出边界。
- attribution、作者信息和用户可见 target 必须可验证。
- sandbox 执行最小权限、最小挂载、最小命令能力原则。
- 远程部署和调试流程不得打印 `.env` 或 secret 文件原文。

## 7. 测试与验证基线

- 默认验证顺序：
  1. `node node_modules/eslint/bin/eslint.js .`
  2. `node node_modules/typescript/bin/tsc -b tsconfig.json --pretty false`
  3. `node node_modules/vitest/vitest.mjs run`
  4. `node node_modules/markdownlint-cli2/markdownlint-cli2.mjs "**/*.md" "!**/node_modules/**" "!**/dist/**" "!**/coverage/**"`
  5. 构建步骤
- 在 Linux/CI 等 `pnpm` 可直接执行的环境中，可使用等价的
  `pnpm lint/typecheck/test/markdownlint/build`。
- `Plan.md` 与 `docs/**/*.md` 共同接受 markdownlint 校验。
- M11 已新增 `docs:build`、`docs:preview`、`docs:check`、`docs:dev` 脚本，CI 在
  `.github/workflows/ci.yml` 的独立 `docs` job 中运行 `pnpm docs:build` 验证公开内容边界与静态站点构建。

## 8. 里程碑与执行顺序

### 8.1 当前状态

| 里程碑 | 状态 | 主要落点 | 下一步 |
| --- | --- | --- | --- |
| M0 | 已完成 | `docs/ai/milestones/M0.md` | 保持基线稳定 |
| M0.5 | 已完成 | `docs/ai/milestones/M0.5.md`、`docs/prompt-research.md` | 继续为 prompt/runtime 变更提供依据 |
| M1 | 已完成 | `docs/ai/milestones/M1.md` | 作为最小 review 闭环基线 |
| M2 | 已完成 | `docs/ai/milestones/M2.md` | 作为 agent/sandbox 基线 |
| M3 | 已完成 | `docs/ai/milestones/M3.md` | 继续复用压缩、预算、队列与 scrubber 能力 |
| M4 | 已完成 | `docs/ai/milestones/M4.md` | 继续扩展模板、路由与 attribution |
| M5 | 已完成 | `docs/ai/milestones/M5.md` | 保持 runtime bundle 与 MCP transport 合同稳定 |
| M6 | 部分完成 | `docs/ai/milestones/M6.md` | GitLab/SVN 真实仓库 e2e 留在 Backlog |
| M7 | 已完成 | `docs/ai/milestones/M7.md` | 跨 workspace 知识迁移明确不做 |
| M8 | 基本完成 | `docs/ai/milestones/M8.md` | 真实 LLM benchmark 留在 Backlog |
| M9 | 基本完成 | `docs/ai/milestones/M9.md` | 不进入版本 bump / git tag |
| M10 | 基本完成 | `docs/ai/milestones/M10.md` | 真实外部 Redis smoke/e2e 按需放入 Backlog |
| M11 | 进行中 | `docs/ai/documentation-site-plan.md` | Pages 设置核验；M11-P6 打磨 |

### 8.2 当前执行包

M11-P1（脚手架）、M11-P2（骨架 + 首批核心页）和 M11-P3（全章节双语正文迁移）已完成：
`docs/site` Starlight 工程、pnpm workspace 接入、CI docs job、GitHub Pages workflow
草案，全部章节中英双语正文（首页、快速上手、认证、配置各命名空间、VCS/agent/MCP
集成、Docker/Podman 部署、运维、CLI/配置字段/模板变量参考、排障、贡献指南）。
本地 `pnpm docs:build`（公开内容边界校验 + Astro build）通过（51 页），markdownlint
通过。已修正内容审查发现的错误（移除臆造的 `native-llm` agent kind、session_ttl 默认值
86400、`DOCKER_DOWNLOAD_MIRROR` 默认值与分类）。

M11-P4 打磨（根路由首页修复 + 首页丰富 + 全宽布局 + README）：对称 i18n 路由下 Starlight 不生成 `/`
路径页面，已新增 `src/pages/index.astro` 执行浏览器语言检测跳转（中文 → `/zh-cn/`，其他 → `/en/`），
无 JS 时回退到 meta refresh + 语言选择链接。中英文首页大幅丰富（新增工作流程、扩展核心特性、设计原则），
`custom.css` 用 `clamp()` 实现流式内容宽度适应 4K 分辨率。仓库根目录新增 `README.md`
（CI/license/docs badge、项目介绍、关键特性、架构流程图、quick start、包列表、贡献入口）
和 `LICENSE`（MIT）。

规则自动化。M11-P5 发布 workflow 已落地；线上生效仍需仓库 Settings > Pages 选择 `gh-pages` / `/` 作为发布源。

M11-P6 打磨（首页组件修复 + 4K 全宽 + README/logo）：修复首页在 `.md` 中误用
`<CardGrid>`/`<Card>` JSX 组件（Astro 按纯 Markdown 处理，输出为字面原始标签，卡片、图标、
title 全部失效）的渲染 bug——改为 `.mdx`（Starlight 内置 MDX，`@astrojs/mdx` 为传递依赖，
无需新增依赖），首页改用 splash `hero`（内联 SVG logo）+ `<Steps>` + `<CardGrid>` +
`<LinkCard>` + 新增“评审输出规范”章节，并修正失效锚点。`custom.css` 采用全出血布局
（`--sl-content-width: 100%`，移除 max-width 上限，与 Starlight 打印样式一致；regular 填满
sidebar/TOC 之间、splash 填满视口），渐进 padding + ≥176/224/300rem 按比例放大 root 字号
保障高分辨率可读，prose 经 `--aicr-prose-measure`（默认 `none`）可选恢复阅读宽度。
新增 `docs/site/public/favicon.svg`（logo/favicon）。
README 增强 logo、扩展 badge、导航链接行、Review output standards / Security 章节。同步更新
`validate-public-content.mjs`（扫描 `.md`+`.mdx`）、`AGENTS.md` #59、中英 `development/index.md`、
`docs/site/README.md`。下一本地执行包建议：链接检查、配置字段覆盖校验脚本、SEO 与贡献规则自动化。

### 8.3 本地优先执行队列

| 项 | 说明 | 本地验收 |
| --- | --- | --- |
| M11-P1 文档站脚手架 ✅ | Astro Starlight 创建 `docs/site`，接入 workspace、CI、Pages workflow 草案 | `pnpm docs:build` 公开内容校验 + 构建通过（51 页） |
| M11-P2 信息架构骨架 + 首批核心页 ✅ | 全章节双语占位页 + 首页/快速上手/认证/输出通道四页中英双语正文 | 公开内容校验、站点构建和 markdownlint 通过 |
| M11-P3 全章节正文迁移 ✅ | 配置各命名空间、CLI、MCP、VCS/agent 集成、Docker/Podman 部署、运维、参考、排障、贡献指南占位页全部替换为中英双语正文 | markdownlint、公开内容校验、站点构建、字段/命令抽查通过 |
| M11-P4 配置/CLI 参考校验自动化 | 从 `packages/core/src/config.ts` 和 CLI help 建立可校验参考页流程 | 生成或校验脚本可重复运行 |
| M11-P5 发布链路 ✅ | main 文档变更触发 docs 构建并通过 `DEPLOY_DOCUMENT_GH_PAGES_KEY` 发布到 `gh-pages`；保留 `aicr.atframe.work` 自定义域名和发布说明 | `pnpm docs:build` 可本地验证；线上生效需仓库 Pages source 指向 `gh-pages` / `/` 并绑定自定义域名 |

### 8.4 Backlog（依赖外部系统或延后扩展）

| 项 | 来源里程碑 | 说明 |
| --- | --- | --- |
| GitLab 真实仓库 e2e | M6 | 代码已实现，待真实 GitLab 环境 |
| SVN 真实仓库 e2e | M6 | 基础 VCS adapter 与 trigger 合同层已实现；仍需真实 SVN 仓库和 hook 部署验证 |
| 专用多源上下文聚合 | M6/M7 | 当前 `fetch_more_context` 部分覆盖；无外部仓库选择器需求时先不扩大范围 |
| `k8s_pod` sandbox 实现 | M9 | 需要 Kubernetes 集群和 `@kubernetes/client-node` |
| `firecracker` sandbox 实现 | M9 | 需要 Firecracker 二进制和 API socket |
| CI 真实 LLM eval benchmark | M8 | root CI 已运行 `aicr eval --validate-only`；真实 LLM benchmark 需要 CI secrets |
| 文档站 Pages 设置核验 | M11 | workflow 已发布到 `gh-pages`；仍需 GitHub Settings > Pages 选择 `gh-pages` / `/` 后核验线上地址 |

明确不做或暂不进入计划：跨 workspace 知识迁移；版本 bump / git tag；在 M11-P1 前生成
用户文档正文。

### 8.5 已完成阶段归档

- `docs/ai/milestones/M0.md`
- `docs/ai/milestones/M0.5.md`
- `docs/ai/milestones/M1.md`
- `docs/ai/milestones/M2.md`
- `docs/ai/milestones/M3.md`
- `docs/ai/milestones/M4.md`
- `docs/ai/milestones/M5.md`
- `docs/ai/milestones/M6.md`
- `docs/ai/milestones/M7.md`
- `docs/ai/milestones/M8.md`
- `docs/ai/milestones/M9.md`
- `docs/ai/milestones/M10.md`
- `docs/ai/milestones/local-priority-queue.md`

## 9. 稳定决策索引

- 长期有效的 D1-D31 决策已迁移到 `docs/ai/decisions.md`。
- 使用方式：
  - 先看本计划确认“现在做什么”
  - 再看 `docs/ai/decisions.md` 理解“为什么这样做”
  - 最后看 `docs/ai/architecture.md` 或代码确认“现在是怎么做的”

## 10. 扩展点

- Context Provider 插件：见 `docs/ai/architecture.md` §10.1。
- Output Pipeline 中间件 / 审批流扩展：见 `docs/ai/architecture.md` §10.2。
- 扩展点目标是保留接口与边界，不是提前把未实现能力包装成已完成能力。

## 11. 部署与发布摘要

- 首选单容器自托管，HTTP 入站由反向代理处理 TLS。
- 持久化保留 `config.yaml`、`.env`、workspace 数据、数据库和日志目录。
- Podman / Docker 使用同一构建与运行合同，差异由 engine 选择吸收。
- 健康检查统一使用 `/healthz`。
- 部署与验收入口：`example/README.md`、`docs/podman.md` 与相关 skill。
- M11 文档站发布走静态站点构建与 `gh-pages` 分支 workflow，不改变 AICR 服务运行时镜像。
