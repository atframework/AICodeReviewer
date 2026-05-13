# 代码评审默认提示词调研（M0.5 归档）

## 目标

本调研用于收敛 `AICodeReviewer` 的默认代码评审提示词设计，回答四个核心问题：

1. 默认 system prompt 应该如何组织，才能既稳定又不臃肿。
2. 被评审源码仓库拉取后，自带的 `AGENTS.md`、repository instructions、path-specific instructions、repo-local skills 应该如何加载。
3. 输出协议应该如何约束，才能降低误报、噪音和上下文浪费。
4. 哪些公开方案值得吸收，哪些不应直接照搬。

本文件的目标不是复刻某个现成产品的 prompt，而是为
`prompts/system/code-reviewer.system.md` 提供一份可审查、可追溯、可迭代的设计依据。

M0.5 的阶段摘要已迁移到 `docs/ai/milestones/M0.5.md`；`Plan.md` 现在只保留路线图级摘要，不再承载这份调研的完整历史正文。

## 证据等级

- **A 级**：官方文档、官方源码、官方公开配置。
- **B 级**：官方产品文档、公开配置示例、公开 prompt 片段。
- **C 级**：公开摘录、社区讨论、低稳定性资料，只做辅助，不作为主设计依据。

当前草案优先使用 A/B 级证据；对缺乏稳定公开来源的方案，只记录趋势，不把它们写成硬规则。

## 结论先行

### 应采纳的核心原则

1. **指令前置**：先给角色、成功标准、硬约束，再给上下文与任务数据。
2. **显式分层**：system 硬规则、operator/workspace 覆写、repo-local 指令、skill 摘要、任务上下文、输出协议必须分段。
3. **repo-local 指令由平台装配，不靠 agent 自行搜索**：源码仓库中的
   `AGENTS.md`、`.github/copilot-instructions.md`、
   `.github/instructions/**/*.instructions.md`、`.agents/skills/**/SKILL.md`
   必须在 Prompt Manager 里归一化加载。
4. **高置信问题优先**：只有当问题具体、可解释、具备现实触发场景时才输出；
   高影响但不完全确定的问题必须显式标注不确定性。
5. **输出协议化**：最终 review 结论必须经 `aicr.report_problem` /
   `aicr.publish_summary` / `aicr.skip` 输出，而不是任意自由文本。
6. **静默优先**：如果没有明确、可执行的问题，宁可 `skip`，也不要输出“看起来不错”式噪音。
7. **上下文最小化**：默认 prompt 只加载摘要和槽位；长篇 repo-local 文档与 skill 正文按需 recall。

### 不应照搬的做法

1. 把所有规则、示例、产品功能说明塞进一个超长 system prompt。
2. 把 repo 规则和当前任务上下文混在同一自然语言段落里。
3. 让 agent 自己去全仓搜索项目约束，再猜哪些 instructions 生效。
4. 把 PR 打分、标签、花哨摘要、营销式文案写成默认 prompt 的硬要求。
5. 默认产出大量 style nit、情绪化措辞或没有现实触发场景的猜测性问题。

## 五维对比摘要

| 方案 | 任务结构 | 输出协议 | 静默策略 | 反注入/降噪 | 上下文获取 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| GitHub Copilot Prompt Engineering | 先 general 再 specific，复杂任务拆步 | 用示例约束格式 | 强调 relevant history | 避免歧义，只给相关代码 | 依赖 open files / relevant code | **采纳**：分步、示例、避免歧义 |
| GitHub Repository Instructions / AGENTS | repo-wide + path-specific + nearest AGENTS | 多源同时生效 | 不强调静默 | 明确避免冲突 instructions | 就近与 path 匹配 | **采纳**：加载优先级与路径过滤 |
| OpenAI Prompt Engineering | 指令前置，分隔上下文，具体格式 | 明确输出格式与 few-shot | 不直接谈静默 | 正向约束优先于纯否定 | 通过 delimiters 控制上下文 | **采纳**：前置指令、分隔块、少量示例 |
| Anthropic Prompt Engineering | role + XML-like tags + prompt chaining | 倾向结构化段落 | 不直接谈静默 | 强调 clarity 与结构分区 | 长上下文也要分段 | **采纳**：标签化分段；**不采纳**：把思维过程强制外显 |
| Google Code Review Standards | 以“提升代码健康”而非追求完美为准 | 评论应区分必须与可选 | 可用 `Nit` 标非阻断项 | 技术事实高于偏好 | 关注变更对代码健康的净影响 | **采纳**：高信号、反完美主义 |
| PR-Agent | system+user 模板，按 diff hunk 组织 | YAML schema，problem 数量受限 | 空 issue 列表可接受 | 聚焦新增行，要求高置信 | 基于 diff、票据、extra instructions | **采纳**：problem cap、结构化输出、高置信阈值 |
| CodeRabbit | 全量 + 增量 review，附 summary | 类型 + 严重级别 + 交互命令 | Chill / Assertive 控量 | 结合静态分析与 code graph | 增量 review、仓库级上下文、学习记忆 | **采纳**：增量 review、severity/profile；**不采纳**：把平台特性写死进核心 prompt |
| Aider conventions | 约定文件与任务分离，read-only 加载 | 无固定 review 输出协议 | 不强调静默 | 通过 conventions 文件约束生成 | 以外部 conventions 文件补充上下文 | **采纳**：把 repo 约束作为独立、只读输入 |
| Cursor / Claude Code 公开摘录 | 多强调角色、工具、分段 | 公开稳定资料不足 | 资料不足 | 资料不足 | 资料不足 | **暂不作为主依据** |
| Kilo / OpenCode 内置 skills | 与本项目目标接近 | 公开稳定资料不足 | 资料不足 | 资料不足 | 资料不足 | **留待实现期实测补强** |

## 逐项观察

### GitHub Copilot：提示词要从“目标”到“约束”逐步收口

GitHub 官方文档给出的共识非常稳定：

- 先描述整体目标，再给具体要求。
- 复杂任务要拆成更小的步骤。
- 示例能显著提高输出一致性。
- 歧义会直接降低结果质量。
- 只给相关代码与相关历史，不要让模型在无关上下文里游泳。

**对本项目的影响**：

- 默认 prompt 不应该是一大段“你要注意 A/B/C/D/E”的散文；
  应该先定义 mission，再给 hard rules，再给 repo-local 插槽和 task context。
- Prompt Manager 应该负责把“相关上下文”装配好，避免 agent 依赖大量探索式搜索。

### GitHub Repository Instructions / AGENTS：多类 instructions 可以并存，但必须防冲突

GitHub 官方文档明确支持：

- `.github/copilot-instructions.md` 作为 repository-wide instructions。
- `.github/instructions/**/*.instructions.md` 作为 path-specific instructions。
- `AGENTS.md` 作为 agent instructions。
- 多个 `AGENTS.md` 时，目录树中**更近**的文件优先。

官方同时强调：多个 instructions 可以同时生效，但**冲突时结果不稳定**。

**对本项目的影响**：

- AICR 不能把 repo-local instructions 原样并列塞进 prompt；
  必须先归一化、去重、按优先级决议。
- path-specific instructions 必须只在命中当前变更路径时激活。
- `nearest AGENTS.md` 规则很适合映射到 `source/` 仓库中的子目录约束加载。

### OpenAI / Anthropic：system prompt 最重要的是“顺序”和“边界”

OpenAI 官方建议强调：

- 指令应放在最前面。
- 用明显分隔符隔开 instructions 与 context。
- 输出格式最好通过示例显式说明。
- 用正向要求代替只有“不许做什么”的约束。

Anthropic 官方公开材料强调：

- 复杂 prompt 应拆成多个结构化区块。
- XML-like tags / role prompting / prompt chaining 有助于降低混淆。
- 对多组件 prompt，需要先定义成功标准，再分发上下文与子任务。

**对本项目的影响**：

- `code-reviewer.system.md` 应采用结构化块，而不是自由散文。
- repo-local instructions、skills、memory、task context 应以独立槽位存在。
- 不应要求模型输出完整思维过程；只要给出可执行结论和必要的不确定性说明即可。

### Google：默认评审基线应该追求“持续改进”，不是“吹毛求疵”

Google 的 code review 标准提供了一个非常适合作为默认 reviewer persona 的原则：

> 只要变更明确改善了系统整体代码健康，就应倾向批准，而不是追求完美。

同时它强调：

- 技术事实高于个人偏好。
- 风格问题应服从 style guide 或现有代码一致性。
- 纯教育性评论应明显降级为 `Nit`，避免阻断主流程。

**对本项目的影响**：

- 默认 prompt 应优先找 correctness / security / API 契约 / 资源泄漏等高价值问题。
- style-only nit 不应成为默认 problem。
- “没有问题就跳过”是合理默认，而不是失败。

### PR-Agent：适合吸收“结构化输出 + 高置信阈值”

PR-Agent 的公开 prompt 与 review 文档显示几个明显特点：

- 以 diff hunk 为主要输入单位。
- 明确只关注本次 PR 引入的问题。
- 输出有严格 schema，并限制最大 problems 数量。
- 允许注入 `extra_instructions`，但要求具体、清晰、简洁。

**采纳项**：

- 默认 review 只看当前变更引入的问题。
- 默认只输出少量高价值 problems，而不是“能说的都说”。
- 输出结构要可程序化消费。

**不采纳项**：

- 把 effort score、ticket compliance、labels 等产品层输出做成核心 prompt 的硬要求。
- 过多绑定 GitHub PR 展示层语义。

### CodeRabbit：适合吸收“增量 review、严重级别、评论档位”

CodeRabbit 的官方文档/公开配置说明体现出：

- 新 PR 与新提交使用不同 review 模式。
- 反馈类型与严重级别明确分层。
- Review 量可以通过 Chill / Assertive 档位控制。
- 会结合静态分析、仓库图谱、增量上下文与学习反馈。

**采纳项**：

- AICR 应在架构上支持 full review 与 incremental review 的不同上下文策略。
- problem 需要 severity 概念。
- 默认基线应偏“高信号”，接近 Chill，而不是默认追求覆盖所有 nit。

**暂不采纳项**：

- 把 sequence diagram、auto title、request changes workflow、跨仓库分析等平台能力写进默认 system prompt。
- 让默认 prompt 直接承担“学习系统”职责；学习应由 memory 组件承担。

### Aider conventions：repo 规则最好是只读附件，不是 system prompt 正文

Aider 的 conventions 文档说明了一个很实用的模式：

- 把项目约定写到单独的 Markdown 文件中。
- 以只读方式注入到对话，而不是和任务文本混排。
- 约定文件既可以临时读入，也可以长期自动加载。

**对本项目的影响**：

- repo-local instructions 应被视为“单独的上下文层”，而不是 system prompt 的一部分正文。
- Prompt Manager 的职责是“加载哪些文件 + 给出摘要/槽位”，
  而不是把所有 repo 说明拼接成巨型系统提示词。

### 低置信来源与待补项

以下条目在当前阶段没有足够稳定的官方公开来源，不进入本轮主设计依据：

- Cursor 系统提示词公开摘录。
- Claude Code 系统提示词公开摘录。
- Kilo / OpenCode 内置 code review skills 的公开稳定规范。

处理原则：

- 这些资料可以作为实现期 sanity check。
- 若未来拿到稳定、可复核的官方资料，再补进本文件，不在当前阶段把它们写成硬规则。

## 采纳清单

### 采纳

1. **结构化 prompt 模板**：使用 `mission`、`hard_rules`、`repo_instructions`、
   `active_skills`、`task_context`、`output_contract`、`few_shot_examples`
   这些稳定区块。
2. **repo-local 指令分层加载**：按 `nearest AGENTS.md`、path-specific instructions、
   repo-wide instructions、skill summaries 的顺序装配。
3. **输出工具协议化**：所有结论统一走 MCP 工具。
4. **problem 控量**：默认只输出最关键、最高置信的一小组问题。
5. **静默优先**：无可执行问题则 `skip`。
6. **不确定性显式化**：高影响但上下文不足的问题可以报，但必须说明不确定点。
7. **默认高信号档位**：默认不展开大量 nit 与风格评论。

### 拒绝

1. 把 PR 打分、评审努力度、标签生成等产品层衍生能力强塞进核心 prompt。
2. 把 style nit、文风喜好、人格化语气设成默认要求。
3. 把 repo-local 文档全文直接拼进 system prompt。
4. 把“是否需要更多上下文”的判断完全交给 agent 自发探索。
5. 用单一长提示词同时承载安全、repo 约束、技能说明、任务数据、示例。

## 默认提示词分层模板

建议固定采用以下优先级（高 → 低）：

1. **平台不可覆盖规则**：安全、输出协议、secret 处理、工具边界。
2. **operator / workspace 覆写**：部署侧显式追加规则。
3. **repo-local agent instructions**：最近 `AGENTS.md` 优先。
4. **repo-local path-specific instructions**：仅命中当前变更路径时加载。
5. **repo-wide repository instructions**：根级 `AGENTS.md`、
   `.github/copilot-instructions.md` 等。
6. **active skill summaries**：只放摘要，不放大段正文。
7. **memory hints**：路径/主题命中的短提示。
8. **task context**：当前 review 目标、diff 摘要、附加上下文。
9. **few-shot examples**：只保留 1–2 个锁定输出协议的短例子。

## repo-local AI 资产加载优先级矩阵

| 来源 | 是否自动发现 | 是否路径过滤 | 优先级 | 注入方式 |
| --- | --- | --- | --- | --- |
| 平台安全规则 / 输出协议 | 是 | 否 | 最高 | 直接进入 system |
| workspace 追加 prompt / AGENTS | 是 | 可选 | 高 | 直接进入 system |
| 最近 `AGENTS.md` | 是 | 是（按变更路径向上查找） | 高 | 摘要 + 引用 |
| `.github/instructions/**/*.instructions.md` | 是 | 是（按 `applyTo`） | 中高 | 摘要 + 引用 |
| 根 `AGENTS.md` | 是 | 否 | 中 | 摘要 + 引用 |
| `.github/copilot-instructions.md` | 是 | 否 | 中低 | 摘要 + 引用 |
| repo-local `.agents/skills/**/SKILL.md` | 是 | 是（按适用范围） | 中低 | 只注入 summary |
| 兼容别名文件（如 `CLAUDE.md`） | 是 | 否 | 更低 | 归一化后摘要 |

## 冲突处理规则

1. **平台硬规则永不被 repo-local 指令覆盖**。
2. 更近的 `AGENTS.md` 优先于更远的 `AGENTS.md`。
3. 命中当前路径的 instructions 优先于全局 instructions。
4. 具体规则优先于抽象规则。
5. 如果两条规则重复，只保留更具体的那条。
6. 如果冲突不可自动消解，保留高优先级规则，并把冲突写入 run trace。

## 上下文预算策略

### 默认预算原则

- **system prompt 保持短而硬**：跨仓库稳定规则不应无限膨胀。
- **repo-local 内容默认摘要化**：长文档/长技能只保留短摘要。
- **任务数据后置**：只有当 system 与 repo-local 装配完成后，才拼接当前 diff 与额外上下文。
- **按需 recall**：当某个 problem 需要更长背景时，再调 `aicr.fetch_more_context` 或
  `aicr.recall_skill`。

### 建议切片

1. **固定层**：system hard rules + output contract。
2. **可变层**：workspace 覆写 + repo-local 摘要 + active skill summaries。
3. **任务层**：变更文件清单、diff 摘要、必要票据/PR 描述。
4. **延迟层**：大文件上下文、skill 正文、长 repo 文档、历史 memory 明细。

## Prompt Manager 组装契约（建议）

为了避免提示词实现阶段重新发散，建议把 Prompt Manager 的最小职责固定为：

1. **发现**：识别 workspace 覆写、repo-local instructions、repo-local skills、memory hints 与当前任务上下文；
2. **归一化**：把不同来源统一映射为少数稳定槽位，而不是保留原始文件类型差异；
3. **决优先级**：在进入模型前完成去重与冲突裁决；
4. **裁剪**：按 token 预算只注入摘要与必要槽位；
5. **可追踪**：把命中来源、丢弃来源、冲突决议和最终注入结果记入 run trace。

建议实现时以如下抽象为边界：

```ts
interface PromptAssemblyInput {
  platformRules: string[];
  workspaceOverrides: string[];
  repoInstructionCandidates: RepoInstructionCandidate[];
  activeSkillCandidates: SkillCandidate[];
  memoryHints: MemoryHint[];
  taskContext: TaskContext;
  tokenBudget: PromptBudget;
}

interface PromptAssemblyOutput {
  systemPrompt: string;
  loadedInstructionRefs: LoadedRef[];
  droppedInstructionRefs: DroppedRef[];
  activatedSkillRefs: LoadedRef[];
  conflicts: PromptConflict[];
  tokenEstimate: number;
}
```

### 发现与归一化流水线

建议固定采用以下流水线：

1. 读取 workspace 覆写与平台硬规则；
2. 扫描 `source/` 中可能生效的 `AGENTS.md`、repository instructions、path-specific instructions 与 skills；
3. 把候选项统一转换为：
   - `hard_rules`
   - `repo_instruction_summaries`
   - `active_skill_summaries`
   - `memory_hints`
   - `task_context`
4. 进行去重与冲突决议；
5. 对长文档生成短摘要，记录“摘要自何文件”；
6. 计算 token 预算，必要时裁剪低优先级摘要；
7. 渲染 `code-reviewer.system.md` 槽位，生成最终 system prompt。

### 必须落 trace 的元数据

为保证可回放与可调参，建议每次组装都记录：

- 命中的 repo-local 文件清单；
- 因 `applyTo` 未命中而被排除的文件；
- 因优先级较低而被覆盖的规则；
- 因预算裁剪而被丢弃的摘要；
- 最终注入的 skill 摘要列表；
- 组装前后的 token 估算。

## 默认 problem 严重级别与发布阈值

当前代码尚未把 severity enum 固化到实现中，但 M0.5 建议先收敛一套**推荐语义**，供 M1/M4 落地时映射到具体接口：

| 推荐级别 | 适用场景 | 默认动作 |
| --- | --- | --- |
| `critical` | 明确的安全漏洞、权限绕过、数据破坏、常见路径崩溃 | 必须优先保留并尽早发布 |
| `high` | 高概率 correctness bug、API/Schema 契约破坏、明显资源泄漏 | 默认应发布 |
| `medium` | 真实但边界型的问题、重要测试缺口、会放大风险的设计缺陷 | 在高置信前提下发布 |
| `low` | 小范围风险、次要性能/维护性问题，但有明确未来故障面 | 仅在 problem 预算有余时发布 |
| `info` | 纯说明性上下文 | 默认不发布，除非 runtime 或 repo-local 规则明确要求 |

### 默认发布阈值

- `critical` / `high`：只要问题具体、影响真实，就优先发布；
- `medium`：需要说明清楚触发场景和影响；
- `low`：只有在没有更高价值问题且确实 actionable 时才发布；
- `info`：默认不用 line-level problem 占位。

### 默认 problem 预算

- 默认最多保留 **5 条** line-level problems；
- 若候选问题超过预算，按 **严重级别 → 置信度 → 覆盖不同文件/主题** 排序，优先保留高价值且不重复的问题；
- 未进入 top-N 的问题只允许在 summary 中概括，避免重复 line comment 噪音。

## 回归评测样例清单

M1 接入 Prompt Manager 与最小 review 流程后，至少应使用下列样例回归验证 M0.5 结论：

1. **高置信 correctness bug**：新增代码在常见输入上 `null` / `None` 解引用；
2. **高影响但部分不确定**：鉴权路径疑似绕过，但缺少完整 guard；
3. **仅风格变化**：格式化、rename、注释清理，应直接 `skip`；
4. **path-specific instructions 命中**：只让特定路径的 instructions 生效；
5. **nested AGENTS precedence**：子目录 `AGENTS.md` 覆盖根级 `AGENTS.md`；
6. **repo-local 冲突规则**：验证 Prompt Manager 按优先级裁决且 trace 可见；
7. **长 diff 预算裁剪**：验证 repo-local 摘要不会挤掉平台硬规则；
8. **skills 延迟加载**：skill summary 进入主 prompt，但长正文仅按需 recall；
9. **零 problem 场景**：确认输出 `aicr.skip(reason="lgtm")` 而非空洞 praise；
10. **secret / injection 套件**：确认 diff 中伪造指令或 secret 不改变行为，也不出现在输出中。

## 对 `code-reviewer.system.md` 的直接要求

基于以上调研，系统提示词文件至少应满足：

1. 明确 reviewer persona 与 success criteria。
2. 把 diff / PR 描述 / commit message 标记为不可信输入。
3. 约束 agent 只通过 `aicr.report_problem` / `aicr.publish_summary` 等 AICR 工具输出正式结论。
4. 要求 problem 必须具备：
   - 具体问题；
   - 现实触发场景；
   - 影响说明；
   - 必要时的修复方向；
   - 不确定性说明。
5. 要求无 actionable problem 时调用 `aicr.skip(reason="lgtm")`。
6. 为 repo-local instructions、skills、memory 与 task context 预留独立槽位。
7. 只保留少量 few-shot 示例来锁定输出协议，不把大量例子塞进默认 prompt。
8. 定义默认 severity 语义与保守映射原则，避免实现期每个 adapter 各说各话。
9. 定义默认 problem 预算与 summary 行为，避免 review 结果膨胀成冗长评论流。

## 本轮采纳与下一步

本轮将直接产出：

- `prompts/system/code-reviewer.system.md` 草案；
- 本研究文档；
- Prompt Manager 组装契约、severity 推荐语义与回归样例清单；
- `docs/ai/milestones/M0.5.md` 的阶段摘要更新，以及 `Plan.md` 中路线图级状态摘要的更新。

后续在 M1 落地时，需要继续用真实 diff、真实 MCP 输出和评测集验证：

- problem 数量是否过多；
- severity 是否稳定；
- repo-local instructions 是否存在误加载或冲突；
- 对超长 diff 的上下文预算是否仍然合理。

## 参考来源

### A 级 / B 级

- GitHub Copilot Prompt Engineering
  - <https://docs.github.com/en/copilot/concepts/prompting/prompt-engineering>
- GitHub Repository Custom Instructions / AGENTS
  - <https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions>
- OpenAI Prompt Engineering Best Practices
  - <https://help.openai.com/en/articles/6654000-best-practices-for-prompt-engineering-with-the-openai-api>
- Google Engineering Practices: The Standard of Code Review
  - <https://google.github.io/eng-practices/review/reviewer/standard.html>
  - <https://google.github.io/eng-practices/review/reviewer/>
- PR-Agent review documentation
  - <https://github.com/The-PR-Agent/pr-agent/blob/main/docs/docs/tools/review.md>
- PR-Agent reviewer prompt template
  - <https://github.com/The-PR-Agent/pr-agent/blob/main/pr_agent/settings/pr_reviewer_prompts.toml>
- Aider conventions documentation
  - <https://aider.chat/docs/usage/conventions.html>
- CodeRabbit official docs snippets
  - <https://docs.coderabbit.ai/guides/code-review-overview>
  - <https://docs.coderabbit.ai/changelog>

### 辅助来源

- Anthropic prompt engineering 官方公开摘要（当前环境未能直接抓取完整正文，
  仅将“结构分段、角色设定、prompt chaining”作为辅助共识，不把细节写成硬规则）。
