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

**已验证版本基线（2026-07 实测）**：Astro `7.0.6` / `@astrojs/starlight` `0.41.3`，本地 Node `24.16.0`。
锁定 `astro: ^7`、`@astrojs/starlight: ^0.41`；Astro 7 官方要求 Node `>=22.12.0`，docs CI 使用 Node 24。实测要点：
- `social` 配置在 Starlight v0.33+ 改为**数组**（不再是 `{ github: "..." }` 对象）。
- `template` frontmatter 只接受 `doc` 或 `splash`（无 `landing`）。
- sidebar slug 不含 `index` 段：`troubleshooting/index.md` 的 slug 是 `troubleshooting`。
- i18n UI 覆盖文件名为 BCP-47 lang tag：`src/content/i18n/zh-CN.json`。

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

发布 workflow 已采用显式 pnpm 步骤并发布到 `gh-pages` 分支：

- checkout
- setup pnpm / Node 24
- install
- `pnpm docs:build`
- 用 `DEPLOY_DOCUMENT_GH_PAGES_KEY` SSH deploy key 配置写权限
- 将 `docs/site/dist/` 作为 `.nojekyll` 静态快照强推到 `gh-pages`

真实上线前还需要仓库 Settings > Pages 选择 Deploy from a branch，发布源为 `gh-pages` / `/`。仓库级脚本保留 `pnpm docs:build` 作为本地和 CI 的共同入口。

### 3.4 i18n 路由决策（M11-P1 已落地）

公开文档站采用**全部带语言前缀**的对称路由结构：

- English → `/en/...`，内容源 `src/content/docs/en/`。
- 简体中文 → `/zh-cn/...`，内容源 `src/content/docs/zh-cn/`。
- `defaultLocale: "en"` 仅控制 UI 字符串 fallback 和语言检测，**不**让 English 成为
  无前缀的 root locale。

选择对称前缀而非"English root + 中文前缀"的理由：

- 结构对称，便于未来增加第三语言而不需要重构 URL。
- 中英两套内容同等可见，便于审阅者一眼确认双语覆盖。
- sidebar label 通过 `translations` map（BCP-47 lang tag，如 `"zh-CN"`）本地化；
  页面标题来自各语言版本自身的 frontmatter `title`。

i18n UI 覆盖：`src/content/i18n/zh-CN.json` 覆盖搜索、目录、上一页/下一页等 UI 字符串。
Starlight 自带 ~35 种语言（含中文）的 UI 翻译，覆盖文件只需补充或改写需要的 key。

中文内容**不是机翻**：按中文技术写作习惯重写，但所有配置块、命令、字段名、路径与英文版
完全一致，并回查代码真源。

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

- 安装依赖：pnpm、Node 版本（runtime `>=20`，docs/site `>=22.12.0`）、Windows PowerShell 注意事项。
- Runtime 构建：`pnpm build` 或 Windows 下等价命令。
- 类型检查、测试、markdownlint、eval fixture validation。
- 文档站构建：`pnpm docs:build`（先校验公开内容边界，再执行 Astro build）。
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
- 中英双语并行（见 §3.4）；中文按技术写作重写，配置/命令/路径与英文版一致。

## 6. 视觉与交互要求

- 使用 Starlight 默认文档体验作为基线：左侧导航、顶部搜索、明暗主题、移动端自适应。
- 首页要直接呈现 AICodeReviewer 的产品身份和主要入口，不做纯营销落地页。
- 保持工程工具气质：信息密度适中、导航清晰、示例可复制、少装饰。
- 用卡片或步骤组件承载入口和流程，但不要把每个段落都做成视觉卡片。
- 代码块必须有语言标记；命令示例区分 Linux/macOS 与 Windows PowerShell。

## 7. 质量门禁

M11-P1 后建议至少具备：

- `pnpm docs:check`: Astro/Starlight 类型与内容集合检查。
- `pnpm docs:build`: 校验公开内容边界并生成静态站点。
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
| M11-P1 ✅ | 创建文档站子工程 | `docs/site`（Astro v7 / Starlight v0.41）、根 scripts、CI docs job、GitHub Pages workflow 草案 | `pnpm docs:build` 公开内容校验 + 构建通过（51 页） |
| M11-P2 ✅ | 落地信息架构骨架 + 首批核心页 | 全章节双语占位页、导航、侧边栏；首页/快速上手/认证/输出通道四页中英双语正文 | 公开内容校验通过，站点可构建 |
| M11-P3 ✅ | 全章节双语正文迁移 | 配置各命名空间、CLI、MCP、VCS/agent 集成、Docker/Podman 部署、运维、参考、排障、贡献指南全部替换为中英双语正文；新增公开/内部内容边界校验 | markdownlint、公开内容校验、站点构建、字段/命令抽查通过 |
| M11-P4 | 配置/CLI 参考校验自动化 | 从 Zod schema 和 CLI help 建立可校验参考页流程 | 生成或校验脚本可重复运行 |
| M11-P5 ✅ | 发布链路 | main 文档变更自动构建并通过 SSH deploy key 发布到 `gh-pages`；保留 `site/base` 项目页配置和发布说明 | `pnpm docs:build` 可本地验证；线上需 Pages source 指向 `gh-pages` / `/` |
| M11-P6 | 打磨与维护机制 | SEO、链接检查、贡献规则 | CI 可阻止常见文档漂移 |

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 文档站依赖进入运行时镜像 | 镜像变大，部署构建变慢 | root build 过滤 runtime packages，Dockerfile 不复制 `docs/site` 到 runtime |
| `docs/*` 被误作为 workspace 包 | 普通 Markdown 目录被当成 package，install/build 失败 | `pnpm-workspace.yaml` 使用精确条目 `docs/site` |
| 配置参考和 Zod schema 漂移 | 用户照文档配置失败 | 建立 schema 字段覆盖检查或生成流程 |
| `base` 配置错误 | GitHub Pages 子路径资源 404 | 在 `astro.config.mjs` 中显式处理项目页 base，并在 preview checklist 验证 |
| 内部 AI 文档误发布 | 暴露无关维护细节，用户困惑 | 文档站只从用户内容目录发布，`docs/ai/*` 只作为内部来源 |
| 内容一次性迁移过大 | 难审查、易过期 | 按 quick start、examples、config、operations、reference 分批迁移 |

## 10. 首次实现检查清单

M11-P1 + M11-P2 + M11-P3 已完成项（2026-07）：

- ✅ 创建 `docs/site` Starlight 工程（Astro v7.0.6 / Starlight v0.41.3）。
- ✅ `pnpm-workspace.yaml` 增加精确条目 `docs/site`（并加 `sharp` 到 `onlyBuiltDependencies`）。
- ✅ 增加 root `docs:dev` / `docs:build` / `docs:preview` / `docs:check` scripts。
- ✅ root `build` / `clean` 收紧为 `--filter "./packages/*"`，确保不触发文档站构建。
- ✅ 复核 Dockerfile：`pnpm install --frozen-lockfile` 会静默跳过目录缺失的 workspace
  importer（实测验证），runtime 镜像不会安装 Astro/Starlight。
- ✅ Starlight `site` / `base` 配置 GitHub Pages 项目页
  （`https://owent.github.io/AICodeReviewer/`）。
- ✅ 全章节双语导航骨架（Getting Started / Configuration / Deployment /
  Integrations / Reference / Troubleshooting / Development）。
- ✅ 首批 4 个核心页中英双语正文（首页、快速上手、认证与密钥、输出通道）。
- ✅ CI 新增独立 `docs` job（`pnpm docs:build`，含公开内容边界校验）。
- ✅ GitHub Pages workflow（`.github/workflows/docs.yml`）：main 文档变更构建 `docs/site` 并用 `DEPLOY_DOCUMENT_GH_PAGES_KEY` 发布到 `gh-pages`。
- ✅ i18n 路由：全部带前缀 `/en/` + `/zh-cn/`（见 §3.4）。
- ✅ 全部占位页替换为中英双语完整正文（M11-P3）：配置各命名空间、CLI、MCP、VCS/agent
  集成、Docker/Podman 部署、运维、参考、排障、贡献指南。
- ✅ 新增 `docs/site/scripts/validate-public-content.mjs`，在 `astro build` 前校验公开页面
  不引用内部 AI/路线图文档、不残留迁移来源维护元数据（`AGENTS.md` 和 `.agents/skills/`
  允许引用，因为贡献者指南需要）。
- ✅ 内容审查并修正错误：移除臆造的 `native-llm` agent kind（代码真值只有 kilo/opencode/
  zoo/copilot-cli/claude-code）；`admin.session_ttl_seconds` 默认值修正为代码真值 86400
  （24 小时）；`DOCKER_DOWNLOAD_MIRROR` 默认值修正并归类为 `deploy.sh` 变量而非 Dockerfile ARG。
- ✅ 同步 `Plan.md`、`docs/ai/index.md`、`example/README.md`、`AGENTS.md`。

M11-P3 后续打磨（查缺补漏，2026-07）：

- ✅ 三维度审查（代码真源一致性 / 链接与 IA 完整性 / 内容缺漏）覆盖全部 53 页。
- ✅ 修正事实错误：`aicr.report_problem` 的 `message` 字段标为可选（代码为必填）；
  `aicr.fetch_more_context` / `aicr.try_blame` 的 `range` 字段名 `startLine`/`endLine`
  改为代码真值 `start_line`/`end_line`；`target_kind` 和模板变量 `target.kind` 移除不存在的
  `merge_request`/`changeset`/`revision`，补回 `issue`（与 `review-event.ts` enum 一致）。
- ✅ 新增 `integrations/im-bots.md`（中英双语）：完整迁移飞书 + 企业微信 bot 配置（创建步骤、
  环境变量、channel 配置、路由、飞书签名校验算法与 2.0 schema 渲染、企业微信 Markdown 限制），
  并加入 sidebar。
- ✅ 清除 `integrations/output-channels.md` 三处 `(planned)`/`（规划中）` 占位残留（目标页
  均已存在）。
- ✅ 充实 `output-channels.md`：补全 channel mapping 表（含 buffer-and-flush 行为、
  403/422 fallback、GitHub `resolved_action` 限制）和托管 problem issue 生命周期内部机制
  （fingerprint 稳定性、文件范围解决守卫、最近 issue 上限）。
- ✅ 补充 `vcs-providers.md`：P4 trigger 脚本的 9 个环境变量表（`AICR_P4_COLLECT_FILES` 等）
  和手动测试示例；SVN trigger 的 `jq`/`svnlook`/`chmod` 说明和手动测试示例。
- ✅ 充实 `agent-adapters.md`：新增"Which agent should I use?"选型对比表和决策指引。
- ✅ `troubleshooting/index.md` 补充两条常见问题：dashboard admin 未配置、GitHub issue 写回
  403/404（token 权限与 App 重装）。

待后续阶段（P6）：引入链接检查、配置字段覆盖校验脚本、SEO 与贡献规则自动化；线上发布还需在 GitHub Pages 设置中确认 `gh-pages` / `/` 发布源。
