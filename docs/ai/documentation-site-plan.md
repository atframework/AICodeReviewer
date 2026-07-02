# AICodeReviewer 文档站建设计划

> 本文件是 M11 的执行计划，只规划文档站子工程、内容结构、工程集成和发布流程。
> 现阶段不生成用户文档正文，也不创建站点脚手架。

## 1. 目标与非目标

### 1.1 目标

- 建立一个美观、现代、可维护的用户文档站，后续可发布到 GitHub Pages。
- 文档站子工程、公开文档源文件、站点组件和静态资源都放在 `docs/` 目录下。
- 覆盖首页、快速上手、简单示例、详细配置、构建方法、发布方法、部署运维、集成、
  排障和参考文档。
- 将当前散落在 `example/README.md`、`docs/output-channels.md`、`docs/podman.md`、
  `docs/ai/architecture.md` 和代码 schema 中的用户可见知识梳理成对外手册。
- 保持内部 AI 维护文档、公开用户文档和公开开发者文档分层：`docs/ai/*` 继续服务
  roadmap、architecture 和 agent 维护；文档站只发布面向用户和贡献者的内容。
- 把文档构建纳入 pnpm/CI 校验，但不让文档站依赖进入运行时镜像。

### 1.2 非目标

- 本阶段不撰写最终用户文档正文。
- 本阶段不创建 `docs/site`、不安装依赖、不更新 lockfile。
- 文档站不是运行时代码包，不应加入根 `tsconfig.json` project references。
- 不把 `docs/ai/*` 全量发布到公开文档站。
- 不在文档站首版引入需要服务端运行时的动态功能。

## 2. 调研结论

### 2.1 选型结论

推荐使用 **Astro Starlight** 作为文档站方案。

原因：

- Starlight 是基于 Astro 的完整文档站方案，官方内置站点导航、搜索、i18n、SEO、代码高亮、
  明暗主题和可读排版，符合“现代、美观、文档优先”的目标。
- Starlight 项目结构清晰：`astro.config.mjs` 配置站点，`src/content.config.ts` 配置内容集合，
  `src/content/docs/` 是文档内容源目录。
- Starlight 支持 Markdown/MDX，适合从现有 Markdown 文档渐进迁移；子目录会自然映射为路由。
- Starlight sidebar 支持手工分组和按目录自动生成，适合 AICR 这种“任务入口 + 参考文档”混合结构。
- Astro 官方提供 GitHub Pages 部署指南和官方 action，支持静态导出、项目子路径 `base` 配置，
  适配后续 GitHub Pages 发布。
- 与当前 Node/pnpm/TypeScript 工作区一致，不需要新增 Python/Ruby 主工具链。
- 相比 Docusaurus，它更轻、更静态优先；相比 VitePress，它不引入 Vue 主栈；相比 Nextra，
  它不需要 Next.js 静态导出约束；相比 MkDocs，它更贴合当前 JS/TS monorepo。

### 2.2 候选方案对比

| 方案 | 官方能力摘要 | 适配性判断 |
| --- | --- | --- |
| Astro Starlight | 文档站完整方案，内置导航、搜索、i18n、SEO、代码高亮、暗色模式，支持 Markdown/MDX/Markdoc | 推荐。功能覆盖好，静态发布清晰，和 pnpm/TypeScript 仓库相容 |
| Docusaurus | 成熟文档站 SSG，内置 docs、版本化、i18n、搜索、React/MDX 能力，GitHub Pages 支持成熟 | 备选。版本化强，但 React SPA 和功能面偏重 |
| VitePress | 面向快速内容站的 SSG，默认主题适合技术文档，GitHub Pages workflow 示例完整 | 备选。轻量，但会引入 Vue 生态作为主扩展面 |
| Nextra | Next.js 上的文档主题，支持 MDX、静态渲染/导出、内置组件和搜索 | 不作为首选。Next.js app 约束对纯静态文档站略重 |
| MkDocs | Markdown 文档 SSG，简单、静态、GitHub Pages 友好 | 不作为首选。Python 工具链与当前 Node/pnpm 主栈不一致 |

### 2.3 官方调研来源

- Astro Starlight: <https://starlight.astro.build/>
- Starlight Getting Started: <https://starlight.astro.build/getting-started/>
- Starlight Project Structure: <https://starlight.astro.build/guides/project-structure/>
- Starlight Pages: <https://starlight.astro.build/guides/pages/>
- Starlight Sidebar Navigation: <https://starlight.astro.build/guides/sidebar/>
- Starlight Configuration Reference: <https://starlight.astro.build/reference/configuration/>
- Astro GitHub Pages deployment: <https://docs.astro.build/en/guides/deploy/github/>
- Docusaurus docs and deployment: <https://docusaurus.io/docs>、
  <https://docusaurus.io/docs/deployment>
- VitePress overview and deployment: <https://vitepress.dev/guide/what-is-vitepress>、
  <https://vitepress.dev/guide/deploy>
- Nextra docs: <https://nextra.site/docs>
- MkDocs docs and deployment: <https://www.mkdocs.org/>、
  <https://www.mkdocs.org/user-guide/deploying-your-docs/>

## 3. 工程方案

### 3.1 子工程位置与文档分层

推荐路径：

```text
docs/site/
```

推荐 package 名：

```json
{
  "name": "@aicr/docs-site",
  "private": true
}
```

原因：

- `packages/*` 继续表达运行时代码库，`docs/site` 表达可构建的文档应用。
- 文档站工程、发布内容源、静态资源和站点组件都位于 `docs/` 下，满足“文档子工程和文档文件
  本身都放在 `docs` 目录”的要求。
- 文档站是发布应用，不是 AICR runtime library；根 `tsconfig.json` 不引用该应用。
- `docs/ai/*` 继续作为内部 AI/roadmap/architecture 文档来源，不作为公开站点内容目录。

推荐目录组织：

```text
docs/
  site/
    package.json
    astro.config.mjs
    tsconfig.json
    src/
      content.config.ts
      content/
        docs/
          index.mdx
          start/
          examples/
          configuration/
          deployment/
          operations/
          integrations/
          reference/
          troubleshooting/
          development/
      components/
      styles/
    public/
  ai/
  output-channels.md
  podman.md
  prompt-research.md
```

目录边界：

- `docs/site/src/content/docs/` 是公开用户文档和公开开发者文档的唯一发布源。
- `docs/site/src/components/`、`docs/site/src/styles/`、`docs/site/public/` 保存文档站 UI 与静态资源。
- `docs/ai/` 保存内部 AI 维护、路线图、架构合同和里程碑归档。
- `docs/output-channels.md`、`docs/podman.md`、`docs/prompt-research.md` 暂作为专题源文档保留；
  迁移时按用户任务重写进 `docs/site/src/content/docs/`，不要直接把内部口吻整篇发布。
- 若后续需要非 AI 的内部工程笔记，可新增 `docs/internal/`；公开内容仍必须迁移或重写到
  `docs/site/src/content/docs/`。

### 3.2 工作区与构建边界

M11-P1 实施时必须同时处理：

- `pnpm-workspace.yaml`: 增加精确条目 `docs/site`，不要用 `docs/*` 误把普通文档目录当 workspace 包。
- root `package.json`: 增加 `docs:dev`、`docs:build`、`docs:preview`、`docs:check`。
- `docs/site/package.json`: 使用 Starlight/Astro 本地依赖和文档站脚本。
- `.github/workflows/ci.yml`: 增加文档构建/检查步骤，或拆分独立 docs job。
- `deploy/Dockerfile`: 明确排除文档站依赖和构建产物，避免运行时镜像膨胀。

建议脚本边界：

```json
{
  "scripts": {
    "docs:dev": "pnpm --filter @aicr/docs-site dev",
    "docs:build": "pnpm --filter @aicr/docs-site build",
    "docs:preview": "pnpm --filter @aicr/docs-site preview",
    "docs:check": "pnpm --filter @aicr/docs-site check"
  }
}
```

根 `build` 脚本应保持运行时代码构建语义。若未来把 `docs/site` 纳入 workspace，必须选择
其中一种安全策略：

- 推荐：把根 `build` 改为只过滤 `packages/*`，文档站只由 `docs:build` 构建。
- 或者：保留根 `build` 递归全 workspace，但同步修改 Docker build 阶段和 runtime copy 策略，
  防止文档站依赖被带入服务镜像。

Docker 构建边界：

- runtime 镜像不复制 `docs/site/dist/`。
- runtime install/build 阶段必须只面向服务包，或显式复制文档站 manifest 但不构建文档站。
- 如果 pnpm workspace lockfile 因新增 `docs/site` 影响 Docker install，上线前必须复核
  `deploy/Dockerfile` 的 workspace manifest copy 与 filter 逻辑，避免破坏现有远程部署。

### 3.3 发布配置

GitHub Pages 发布需要在 `docs/site/astro.config.mjs` 中规划：

- `site`: 发布后的根 URL。
- `base`: 项目页通常为 `/AICodeReviewer/`，用户或组织页可为 `/`。
- 静态输出目录：Astro 默认 `dist/`。
- 公开环境变量只用于站点构建，不读取 AICR runtime secret。

发布 workflow 建议使用 Astro 官方 action 或等价的显式步骤：

- checkout
- setup pnpm / Node
- install
- `pnpm docs:build`
- upload Pages artifact
- deploy Pages

真实上线前还需要仓库 Settings > Pages 选择 GitHub Actions 作为 source。

建议 workflow 使用 Astro 官方 action 的 `path: docs/site`，或使用显式 pnpm 步骤后上传
`docs/site/dist/`。仓库级脚本应保留 `pnpm docs:build` 作为本地和 CI 的共同入口。

## 4. 信息架构

### 4.0 文档类型组织

公开站点内容按“用户任务优先，参考文档兜底”的方式组织：

- 用户文档：`start/`、`examples/`、`configuration/`、`deployment/`、`operations/`、
  `integrations/`、`troubleshooting/`、`reference/`。
- 公开开发者文档：`development/`，只放贡献、构建、测试、文档维护、配置参考生成等对外可读内容。
- 内部 AI/路线图文档：继续保留在 `docs/ai/`，只作为维护输入，不进入公开 sidebar。
- 迁移来源文档：`docs/output-channels.md`、`docs/podman.md`、`docs/prompt-research.md` 可作为原始材料；
  若内容对用户有价值，应转写进公开目录并标明代码真源。

### 4.1 首页

目标：让新用户在首屏确认 AICodeReviewer 是什么、适合什么场景、如何开始。

建议模块：

- 简短产品定位：自托管 AI code review 编排服务。
- 三个入口：快速上手、配置参考、部署到生产。
- 支持面概览：GitHub/Gitea/GitLab/P4/SVN、Kilo/Claude Code/opencode/Zoo/Copilot CLI、
  Feishu/WeCom/PR review/managed issue。
- 当前推荐路径：Docker/Podman 单容器部署 + GitHub/Gitea webhook。

### 4.2 快速上手

目标：用户能用最少步骤跑通一个本地或 Docker Compose 示例。

页面：

- 本地 Node.js quick start
- Docker Compose quick start
- 第一个 webhook review
- 第一次 dry-run review
- 如何查看 dashboard 和日志

### 4.3 简单示例

目标：按常见场景提供可复制但不过度冗长的示例。

页面：

- GitHub PR review
- Gitea/Forgejo PR review
- GitHub push review 路由到 issue 或 IM
- P4 changelist review
- SVN revision review
- Feishu / WeCom summary notification
- Managed problem issue lifecycle
- Local eval fixture validation

### 4.4 详细配置文档

目标：按配置命名空间组织完整说明，和 `packages/core/src/config.ts` 保持同步。

页面：

- `server`
- `admin`
- `triggers`
- `workspaces`
- `llm`
- `agent`
- `sandbox`
- `outputs`
- `storage`
- `review`
- `queue`
- `compression`
- `model_catalog`
- 环境变量与 secret 约定

维护要求：

- 配置参考必须以 Zod schema 为真源。
- 后续优先建立脚本或测试，校验文档列出的字段没有遗漏核心 schema 字段。
- 示例配置来自 `example/config.yaml`，不要在文档站维护第二份互相漂移的大样例。

### 4.5 构建方法

目标：说明开发者如何构建 AICR runtime 和文档站。

页面：

- 安装依赖：pnpm、Node 版本、Windows PowerShell 注意事项。
- Runtime 构建：`pnpm build` 或 Windows 下等价命令。
- 类型检查、测试、markdownlint、eval fixture validation。
- 文档站构建：`pnpm docs:build`。
- 文档站本地预览：`pnpm docs:preview`。

### 4.6 发布方法

目标：区分 AICR 服务发布和文档站发布。

页面：

- AICR 服务 Docker/Podman 发布。
- 远程部署与配置重启。
- GitHub Pages 文档站发布。
- 自定义域名和 `base` 配置。
- 发布前 checklist。

### 4.7 运维与安全

页面：

- Dashboard 和 `/metrics`
- 日志、run snapshot、问题追踪
- Secret 管理与 scrubber
- Sandbox 安全边界
- Podman/Docker socket 风险
- 备份和数据目录
- 升级与回滚

### 4.8 集成参考

页面：

- VCS providers
- Agent adapters
- Output channels
- MCP tools
- Webhook / trigger endpoints
- Template variables
- Model catalog

### 4.9 开发者文档

目标：公开贡献者能理解如何安全地修改、验证和维护 AICR，而不暴露内部 agent 历史噪声。

页面：

- Repository layout
- Development setup
- Test and validation matrix
- Adding a package
- Adding or changing config fields
- Adding an output channel
- Adding an agent adapter
- Maintaining docs and examples

### 4.10 排障与 FAQ

页面：

- Webhook 鉴权失败
- 输出通道未发布
- agent structured output 修复失败
- context overflow
- Kilo MCP state 未写入
- Git/P4/SVN 额外上下文获取失败
- Podman rootless / nested container
- Feishu/WeCom Markdown 渲染差异
- GitHub Pages `base` 路径错误

## 5. 内容来源与迁移策略

### 5.1 内容来源优先级

1. 代码真源：schema、CLI、输出工具注册表和实现测试。
2. 用户示例：`example/config.yaml`、`example/README.md`、trigger scripts。
3. 专题文档：`docs/output-channels.md`、`docs/podman.md`、`docs/prompt-research.md`。
4. 稳定架构：`docs/ai/architecture.md`。
5. 历史归档：`docs/ai/milestones/*.md`，仅用于背景，不直接搬运大段正文。

### 5.2 迁移规则

- 面向用户的正文要重写成任务导向，不直接复制内部 roadmap 口吻。
- 配置字段、命令、endpoint、环境变量必须回查代码或示例，不能凭记忆补。
- 代码块优先引用或同步自 `example/`，避免同一配置样例维护两份。
- 内部 pitfall 只在用户会遇到时转化成排障条目，不暴露 agent 维护细节。
- 默认首版用户文档建议 English-first，以匹配 `example/README.md` 和 GitHub Pages 公开访问；
  中文文档可作为 Starlight i18n 后续阶段。

## 6. 视觉与交互要求

- 使用 Starlight 默认文档体验作为基线：左侧导航、顶部搜索、明暗主题、移动端自适应。
- 首页要直接呈现 AICodeReviewer 的产品身份和主要入口，不做纯营销落地页。
- 保持工程工具气质：信息密度适中、导航清晰、示例可复制、少装饰。
- 用卡片或步骤组件承载入口和流程，但不要把每个段落都做成视觉卡片。
- 代码块必须有语言标记；命令示例区分 Linux/macOS 与 Windows PowerShell。

## 7. 质量门禁

M11-P1 后建议至少具备：

- `pnpm docs:check`: Astro/Starlight 类型与内容集合检查。
- `pnpm docs:build`: 生成静态站点。
- `pnpm markdownlint`: 校验仓库 Markdown。
- `pnpm format:check`: 校验格式。
- 可选链接检查：后续引入 lychee 或等价工具，先从内部链接开始。

文档站内容迁移阶段还需要：

- 配置参考字段覆盖检查。
- CLI help 和文档命令示例一致性检查。
- `example/config.yaml` 关键片段和文档示例一致性检查。

## 8. 分阶段执行计划

| 阶段 | 目标 | 产物 | 验收 |
| --- | --- | --- | --- |
| M11-P0 | 整理路线图并保存文档站计划 | `Plan.md`、本文件、`docs/ai/index.md` 入口 | markdownlint |
| M11-P1 | 创建文档站子工程 | `docs/site`、根 scripts、CI 构建检查、GitHub Pages workflow 草案 | docs build/check 通过 |
| M11-P2 | 落地信息架构骨架 | 首页和各章节占位页、导航、侧边栏 | 无断链，站点可预览 |
| M11-P3 | 迁移 quick start 与示例 | 快速上手、基础示例、部署路径正文 | 用户可按文档跑通本地/Compose |
| M11-P4 | 迁移配置与参考 | 配置、CLI、MCP、输出通道参考 | 字段/命令与代码真源一致 |
| M11-P5 | 发布链路 | GitHub Pages workflow、`site/base`、发布说明 | 本地构建通过；线上需仓库权限 |
| M11-P6 | 打磨与维护机制 | 搜索、SEO、链接检查、贡献规则 | CI 可阻止常见文档漂移 |

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 文档站依赖进入运行时镜像 | 镜像变大，部署构建变慢 | root build 过滤 runtime packages，Dockerfile 不复制 `docs/site` 到 runtime |
| `docs/*` 被误作为 workspace 包 | 普通 Markdown 目录被当成 package，install/build 失败 | `pnpm-workspace.yaml` 使用精确条目 `docs/site` |
| 配置参考和 Zod schema 漂移 | 用户照文档配置失败 | 建立 schema 字段覆盖检查或生成流程 |
| `base` 配置错误 | GitHub Pages 子路径资源 404 | 在 `astro.config.mjs` 中显式处理项目页 base，并在 preview checklist 验证 |
| 内部 AI 文档误发布 | 暴露无关维护细节，用户困惑 | 文档站只从用户内容目录发布，`docs/ai/*` 只作为内部来源 |
| 内容一次性迁移过大 | 难审查、易过期 | 按 quick start、examples、config、operations、reference 分批迁移 |
| 多语言过早引入 | 维护成本翻倍 | 首版 English-first，中文 i18n 作为后续阶段 |

## 10. 首次实现检查清单

- 创建 `docs/site` Starlight 工程。
- 增加 `pnpm-workspace.yaml` 的精确条目 `docs/site`。
- 增加 root `docs:*` scripts。
- 明确 root `build` 与 Dockerfile 的运行时构建边界。
- 增加 Starlight `site/base` 配置占位。
- 建立首页、快速上手、示例、配置、部署、运维、开发者文档、参考、排障导航骨架。
- 增加 CI 文档构建检查。
- 增加 GitHub Pages workflow 草案，先不要求真实发布。
- 复核 `Plan.md`、`docs/ai/index.md`、`example/README.md` 是否需要同步入口。
