---
title: 贡献指南
description: 仓库布局、开发环境搭建、测试与验证矩阵，以及如何新增 package、配置字段和输出通道。
---

本页是 AICodeReviewer 的公开贡献者指南，覆盖仓库布局、本地开发环境搭建、测试与验证矩阵，以及常见贡献工作流。仓库根目录的 `AGENTS.md` 持有常驻规则、护栏、环境说明，以及需要避免重新引入的已知代码陷阱列表——较大改动前请先阅读。

## 仓库布局

| 路径 | 用途 |
| --- | --- |
| `packages/*` | 运行时 TypeScript 包（CLI、core、server、agents、sandbox、outputs、mcp-output、llm、vcs、store、eval）。用 pnpm workspace 和 TypeScript project references 管理。 |
| `docs/site` | 本文档站点（Astro Starlight，English + 简体中文）。独立的 workspace 包，不属于运行时。 |
| `docs/`（其他） | 专题参考模块（如输出通道），编写本站页面时参考。 |
| `example/` | 部署样例：`config.yaml`、`.env.sample`、Compose 栈、trigger 脚本。 |
| `deploy/` | `Dockerfile`、`deploy.sh` 及相关部署资产。 |
| `eval/` | 永久 eval CLI 测试 fixture。 |
| `AGENTS.md` | 常驻贡献者指引、护栏和已知代码陷阱。 |
| `.agents/skills/` | 可复用的工作流技能（审计、部署、维护等）。 |

:::note[把文档站点排除在运行时之外]
`docs/site` 是独立的 workspace 包，必须排除在运行时镜像之外。它不出现在根 `tsconfig.json` 的 project references 中，根 `build`/`clean` 脚本也被过滤为 `--filter "./packages/*"`。运行时 `Dockerfile` 不 COPY `docs/site`。
:::

## 开发环境搭建

要求：

- Node.js `>= 20`（部署镜像使用 Node 22 userspace）。
- pnpm。

```bash
# 在仓库根目录
pnpm install
pnpm build
```

:::note[Windows PowerShell]
`pnpm`、`npx` 和 `.ps1` 脚本会被默认执行策略阻止。直接调用 Node 工具：

```powershell
node node_modules/vitest/vitest.mjs run
node node_modules/eslint/bin/eslint.js .
node node_modules/typescript/bin/tsc -b tsconfig.json --pretty false
```

PowerShell 5.1 的 `>` 重定向和 `Out-File` 默认 UTF-16 LE 编码；需要传输的文件请用 `Set-Content -Encoding utf8`（PS 7+）或 `Out-File -Encoding ascii`。反引号是转义/续行符，因此避免使用含模板字面量的内联 `node -e` 片段。
:::

## 测试与验证矩阵

提交变更前运行这些步骤。Linux/CI 上用 `pnpm` 脚本；Windows PowerShell 上按上面方式直接调用 Node 二进制。

| 步骤 | Linux/CI | Windows PowerShell |
| --- | --- | --- |
| ESLint | `pnpm lint` | `node node_modules/eslint/bin/eslint.js .` |
| 类型检查 | `pnpm typecheck` | `node node_modules/typescript/bin/tsc -b tsconfig.json --pretty false` |
| 单元测试 | `pnpm test` | `node node_modules/vitest/vitest.mjs run` |
| Markdown lint | `pnpm markdownlint` | `node node_modules/markdownlint-cli2/markdownlint-cli2.mjs "**/*.md" "!**/node_modules/**" "!**/dist/**" "!**/coverage/**"` |
| 构建 | `pnpm build` | `cmd /c "pnpm build"` |
| Eval fixture 校验 | `pnpm eval:validate`（构建后） | `node packages/cli/dist/index.js eval --validate-only` |
| 文档构建 | `pnpm docs:build` | `pnpm docs:build` |

`pnpm eval:validate` 运行 `aicr eval --validate-only`，只校验 `eval/*.json` 的结构和预期 problem 合同——不需要 LLM，不需要 config 密钥。完整 `aicr eval` 会加载 config 并调用 LLM，应作为单独的、按环境配置的 benchmark 任务。

影响配置 shape、agent 适配器、MCP 工具合同、输出渲染、部署行为或公开工作流的变更，必须在同一次变更中更新对应文档、`example/config.yaml` 和 `example/README.md`。

## 新增 package

1. 在 `packages/<name>/` 下创建包目录，包含自己的 `package.json`、`tsconfig.json`、`src/` 和 `test/`。
2. 把包加入 `pnpm-workspace.yaml`（workspace 已 glob `packages/*`，通常自动包含）。
3. 从根 `tsconfig.json` 和任何消费它的包加 TypeScript project reference；并从新包的 `tsconfig.json` 反向引用其依赖。
4. 至少加一个 `test/index.test.ts`，让包有测试面，即使只导出一个常量。
5. 如果包引入了原生模块，把新的 `onlyBuiltDependencies` 条目加入 `pnpm-workspace.yaml`（pnpm 10 用 `onlyBuiltDependencies` 门控原生构建）。

## 新增或修改配置字段

`packages/core/src/config.ts` 中的 Zod schema 是真源。

1. 更新 schema（以及任何 `superRefine` 跨字段校验）。
2. 在 `packages/core/test/config.test.ts` 加或更新测试。
3. 在 `example/config.yaml` 加带注释的示例。
4. 更新 `docs/site/src/content/docs/.../configuration/` 下相关叙述页，以及[配置字段参考](/zh-cn/reference/config-fields/)中的字段表。
5. 如果字段改变运行时行为，更新 `example/README.md` 和对应专题文档。

workspace 配置文件不能写系统级字段；遵守 `cache` / `defaults` / `instances` 三段式 shape 和 global → workspace-default → workspace-instance 的覆盖顺序。

## 新增输出通道

1. 在 `packages/outputs/src/` 实现 dispatcher，并在输出注册表中注册。channel `kind` 是受注册表约束的自由字符串（不是封闭枚举）。
2. 在模板引擎下为 problem 和 summary 变体加内置 Handlebars 模板。
3. 加测试；如果 channel 是 IM bot，还要加 IM-markdown 转换器测试（表格正则不能在 `.test()` 上用 `g` flag）。
4. 在[输出通道](/zh-cn/integrations/output-channels/)文档化该 channel，并把字段加进[配置字段参考](/zh-cn/reference/config-fields/)。
5. 在 `example/config.yaml` 加带注释的示例。

每个 channel 必须遵守的 problem schema、summary schema、channel 映射和 no-problems 策略，参见[输出通道](/zh-cn/integrations/output-channels/)。

## 维护文档站点

文档站点是双语的（English 在 `.../en/`，简体中文 在 `.../zh-cn/`）。每个面向用户的页面都同时存在于两个 locale；请保持配置键、命令、路径、字段名和枚举值在不同 locale 间完全一致。

- 用 `pnpm docs:build` 本地构建并校验。构建会强制公开/内部边界：`src/content/docs/` 下的页面不得引用内部 AI/路线图文档树，也不得保留仅供维护者参考的迁移占记。
- sidebar slug 省略 `index` 段（如 `troubleshooting/index.md` 的 slug 是 `troubleshooting`）。frontmatter `template` 只接受 `doc` 或 `splash`；Starlight `social` 是链接项数组。
- 内容文件只用 `.md`（暂无 MDX）。
- 交叉链接使用带 locale 前缀的路径（`/en/...`、`/zh-cn/...`）。

当你改变配置 shape、输出合同或运行时行为时，请在同一次变更中更新两个 locale 的相关页面。

## 工作流规则

- 保持编辑最小且外科手术式；不要为了通过而削弱 lint、类型检查、测试或 markdown 门控。
- 所有临时任务产物（草稿脚本、调试日志、一次性报告、benchmark 输出）都放在 `build/` 下，绝不放在仓库根目录、`eval/` 或任何包目录。
- 公共/共享模块（`packages/cli/src`、`ReviewEvent`、模板上下文）必须保持平台中立——从 `@aicr/core` 导入规范 schema/常量，把 provider/channel 专属名称限制在配置合同、文档、测试和平台专属适配器内。

完整、常驻的贡献者规则——包括需要避免重新引入的已知代码陷阱编号列表——请阅读仓库根目录的 `AGENTS.md`。
