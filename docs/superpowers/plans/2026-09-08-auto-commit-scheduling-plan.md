# 自动提交调度实施计划

状态：待实施，2026-09-08 编写，2026-09-09 修订。本轮只编写文档；下列任务未执行。

设计依据与行为合同见[设计方案](../specs/2026-09-08-auto-commit-scheduling-design.md)，
逐项断言见[测试矩阵](2026-09-08-auto-commit-scheduling-tests.md)。
`Plan.md` 只保存这项工作的状态与入口，不复制本文任务详情。

## 1. 交付边界与前置决策

完成条件是 Git 服务 push、P4、SVN 自动提交真正经过同一套持久调度合同，三个已实现
queue backend 行为一致，并且执行证据证明没有漏掉成员、提前启动或重复并发。
只添加配置、接口或 queue 单元测试不能算交付。
跨通知合并属于必需行为：通知是接收单位，stream 是调度单位，sealed batch 才是执行
单位。不能把“接入延迟队列”实现成“每个 webhook 到期后独立分析”。

执行前复核以下推荐默认值，并将最终值同步到设计和测试：

- 首次事件接收后固定延迟 120 秒，每个成员独立到期，不做滑动防抖。
- 自动提交未配置并发时默认全局 1；workspace 执行固定串行。
- 有效时间段按多组 `days + windows` 周计划设置，各组取并集，可跨午夜/跨周；只约束
  新批次/新 attempt 启动，允许已有批次完成。
- workspace schedule 整体覆盖上层，`rules: []` 清除全周限制，默认时区 UTC；所选日
  全天使用 `00:00–24:00`，组内 days/windows 必须非空。
- 缺完整性证明时停止合并；变更可读取则独立分析，读取失败则明确失败。
- 使用“提交来源分组键”表达提交方及任务上下文：Git 原始 author name+email、
  P4 User+Client、SVN svn:author；均带来源命名空间。P4 必须同时匹配 User 和 Client，
  缺字段不合并；不能降级 User-only，不自动套用 Git mailmap 或跨来源归并账号。
- 来源排除使用 auto_commit.exclude_sources：规则内 AND、规则间 OR，支持 glob/RE2
  regex；缺省继承、显式数组整体替换、[] 清除。排除项仍保留为历史分隔点。
- 同一流内不同通知覆盖的连续、同来源、到期成员一起分组；成员唯一性独立于
  deliveryId/receiptId，补通知关联不创建新 run。B1 已有独立通知，不增加未通知提交补扫。

P4 至少按 User+Client 分组是用户明确要求，其余推荐参数需按计划验证；这些合同均未
获得运行验证。若用户调整延迟或串行语义，先改合同再写代码，不能让配置、实现和测试
各采用一种解释。

### 1.1 本次 Review 修正与强制验收

| 发现的计划缺口 | 修正要求 | 验收位置 |
| --- | --- | --- |
| 只有多 receipt 对一 batch 的描述，未规定跨通知展开先于 seal | 固定 assemblyCut，先归并同流通知覆盖及成员，再取最长合法前缀；不能因 N1/分页结束就封存 | P2/P3，N01/N04/N05 |
| delivery 去重无法阻止不同通知重复覆盖相同 commit | 原子 member 唯一归属 + receipt/member 多对多关系；终态成员只补关联 | P2/P5，N02/N03/N06/N09 |
| 后端有 batch/outbox，但自动入口仍可能按通知再 enqueue/timer | 仅封存批次创建执行 job；通知接收/展开/完成不调用分析；所有通道按 batch 运行 | P4，N01/N07/N08 |
| 示例缺少到期、封存和范围前提，容易扩大为未通知补扫 | 固定三条通知、相同流、全部到期/未封存及既有预算；P4/SVN 只合并实际被通知覆盖的成员 | P0/P3，N10/N11/N12 |

固定用户案例：N1 覆盖 A1–A3，N2 覆盖 A4–A5，N3 单独覆盖 B1；A 的来源 key
相同，B 不同。在 18:00 窗口前全部到期且尚未封存，必须依次得到
`[A1,A2,A3,A4,A5] [B1]`。N1/N2 指向同一个 batch/run，N3 指向另一个；正常成功
路径的审查 handler 调用数为 2，不能是 3，也不能先审 A3/A5 再审整个 A 范围。
每个成员恰好归属一个 batch，A 的 diff 为 A0→A5，B 的 diff 为 A5→B1。
准确接收时间和边界条件见设计 §5.2.1；不通过“再等一会儿”或放宽成员最短延迟实现。

## 2. 工作包与依赖

### P0：固定基线与验证外部能力

- [ ] 重新检查 staged/unstaged diff，保留用户既有 Dashboard/统计等修改。
- [ ] 复核 `server/index.ts` → bootstrap → CLI serve 的真实调用链，列全自动提交入口，
  PR/MR、manual、triage 的旁路，以及共用 workspace 路径的互斥点。
- [ ] 明确每个 VCS 通知实际覆盖范围：Git before/after、P4 单 CL、SVN 单 revision；
  有界展开已通知范围，不把仅有 head 的协议解释成主动补扫历史。
- [ ] 固定安装版 BullMQ、Redis、Git、P4、SVN 和 Node 的版本证据；官方文档链接已在设计中，
  实施时刷新会变化的 API，不把当前 `^6.3.4` 当作已安装版本。
- [ ] 用本地临时 Git/SVN 仓库验证有界历史、merge、copy/peg 和端点 diff 的命令语义；
  对 P4 验证 `changes/describe` 批量元数据、`diff2` 新增/删除/move/binary 输出。
- [ ] 验证 Git 原始作者与 mailmap 的区别；用真实 P4/SVN 输出核对记录作者、操作者、
  Client 和可变作者元数据，保存来源快照与冲突 fixture，不能用假设的全局用户 ID 代替。
- [ ] 验证 RE2 绑定的语法、Unicode、匹配预算及 Node 下限，优先评估 re2 原生绑定；
  比较 Windows/Linux/部署镜像架构的安装产物、pnpm 最小构建白名单和 WASM 方案。
  固定版本、依赖成本和证据后再实施；不退回无界 JavaScript RegExp。
- [ ] 用真实 Redis 验证手动 BullMQ delayed 提升、extendLock、stalled 恢复、确定 jobId 和
  重投递。不能用现有 fake Job 类替代这些验证。
- [ ] 验证时区转换库对 Node 下限、DST 重复/跳过小时的支持；记录最终选择及依赖成本。
  不手写分钟轮询搜索来规避时区转换问题。
- [ ] 确定结果发布回执与当前 publisher 的可重入边界，特别是非幂等 POST 响应丢失场景。

产物：实现前命令/版本证据、已确定的 API 形状、迁移草稿。临时脚本、日志和数据均放在
`build/tmp/auto-commit/`、`build/logs/auto-commit/`。如果缺真实 P4/Redis 环境，继续纯函数
与其他可独立任务，但这两个后端的相关验收保持未通过，不写“全 VCS 已支持”。

### P1：配置与纯策略函数

依赖 P0 的默认行为决策；不依赖外部 VCS 运行环境。

- [ ] 在 `packages/core/src/config.ts` 的 `review` schema 加入严格的 `auto_commit` 子对象，
  连同三个配置层的解析、schedule 整体替换和最终默认值解析函数；规则组使用
  `schedule.rules[].days/windows`，禁止旧草案的平铺 `schedule.windows` 被静默忽略。
- [ ] 独立实现 `nextAllowedInstant`、窗口成员判断、周内并集编译、按开始日归属的跨午夜/
  跨周归一化与时区验证；`24:00` 只允许作为 end，转换成次日边界；注入时钟。
- [ ] 定义自动来源分类、带版本 stream/member/batch identity 和 receipt 关联模型。
- [ ] 定义 assemblyCut（接收序号上界 + 选择时刻）、范围展开 cursor 和不可变批次边界；
  新通知不重置延迟，追加通知不使旧前缀无限 CAS 重试，receipt 不进入成员分区键。
- [ ] 定义历史完整性标记、批次有序成员与固定端点；sourceKey 包含 VCS 来源与分组字段，
  sourceSnapshot 保存原始字段、逐字段可用性及版本；P4 的 User/Client 是最低分组条件。
- [ ] 定义 known/unavailable/conflicted 与封存规则；确认冲突独立、未知不合并、
  重投递不新增成员、重试不重算来源。禁止从展示名、共享邮箱或平台账号推断同一人。
- [ ] 定义严格 exclude_sources schema、分层覆盖、VCS 字段白名单和 id 唯一性；实现
  整串 glob/RE2 子串 regex、显式 ignore_case、AND/OR 三态判断，配置阶段编译一次。
- [ ] 定义排除匹配预算、exclusion_metadata_unavailable、excluded_source 和特殊范围
  exclusion_scope_conflict；匹配错误不能忽略，缺失字段不能变成空字符串再匹配。
- [ ] 明确 `availableAt`、`retryNotBefore`、attempt、等待原因，定义所有状态迁移。
- [ ] 覆盖配置层部分覆盖、规则空数组与组内空数组的差异、星期枚举、跨周、UTC/DST、
  重叠规则和不变量；把工作日双时段/周末全天的用户示例作为验收 fixture。

产物：可独立测试的策略函数及合同。这个阶段不启用新生产路由，也不在示例中宣称可用。

### P2：队列接收、调度头、租约与原子批次

依赖 P1。先写共享 conformance 场景，再依次接入 memory、SQLite、Redis。

- [ ] 扩展 ReviewQueue 首次延迟/延期合同，保持 legacy generic job 的立即可用行为。
- [ ] 实现自动提交 inbox 的原子去重写入、receipt 查询、有界成员页和 workspace/stream heads。
- [ ] 实现同流 receipt 覆盖索引与固定截点分页、receipt/member 双向唯一关联；跨通知
  重叠成员保留最早覆盖通知的时间/delay，后台展开顺序不影响到期时间；较早通知尚未
  到期也不能被忽略后以较晚通知的短 delay 提前执行成员。
- [ ] 成员 upsert 已存在时保留 batched/终态，只补幂等关联；原子 seal 只接收尚未归属
  的成员并写唯一 outbox，任一成员已归属时不能封存第二个覆盖批次。
- [ ] 三后端实现按页原子写入来源排除状态、证据/规则版本与游标推进；保留历史分隔点，
  不为 excluded 成员创建 run/job/outbox，不依赖观测数据库才能防重复。
- [ ] memory 使用 Map、到期堆、ready FIFO；测试失效堆项有界回收。
- [ ] SQLite 增加独立 queue migration 版本、索引、短事务、lease CAS；迁移保留所有旧任务。
- [ ] Redis 用 AICR 自有 keys 和有界 Lua 实现 inbox/head/seal，不操作 BullMQ 私有 keys。
- [ ] 实现批次封存与 outbox 同事务写入、确定 jobId 投递及终态去重；结果投影不依赖
  queue 数据库和 observability 数据库之间的分布式事务。
- [ ] receipt/member 关系分页持久化，seal 不遍历全部重复通知；批次查询通过成员关系
  找 receipt，避免批次 JSON/一次 Lua 随重投递数无限增长。
- [ ] 用共享租约控制全局配额、workspace 互斥与 stream 顺序；完成/失败都校验所有权。
- [ ] 续租、失联回收、停止/close 的生命周期与 delayed/stalled checker 完整接线。
- [ ] 对每个后端运行同一套状态合同；SQLite 真文件重开、Redis 真服务验证分别保留证据。

产物：后端合同通过。仍不切生产自动入口，避免出现接收成功但没有可运行 handler 的窗口。

### P3：VCS 元数据页、连续性与净 diff

依赖 P1、P0 的 VCS 命令验证，可在 P2 后端开发期间独立推进，但本轮不要求并行 agent。

- [ ] 在 `packages/vcs/src/contracts.ts` 定义有界历史读取接口，保持既有 `listChanges` 文件
  范围合同清晰；为 `ChangeRange`/批次范围添加必要的 P4 file endpoint 信息。
- [ ] Git 批量读取原始 author/committer 字段，author 用于分组，committer 可显式用于排除；
  核验直接 parent、ref 和历史世代，处理截断 push、来源拆分、merge、force push、浅仓库。
- [ ] P4 批量读取 submitted change 元数据；User+Client 共同分组，搬迁 handler
  中逐请求 enrich；同 User 跨 Client 必须分批，源 view 改变仍隔离；使用实际 file
  revision 生成批次净 diff，不只读取最后一个 CL。
- [ ] SVN 解析 XML author/revision/path/copyfrom；固定 peg 和 cursor，处理全局 revision 空洞、
  author 缺失及 revprop 修改，不能以服务账户补全身份。
- [ ] 将读取结果及来源快照写入有界元数据页，恢复后不再次逐 commit 查询；处理后续
  实际观察到的字段冲突，不增加周期性身份查询或全量用户目录拉取。
- [ ] 先归并 assemblyCut 内相关通知覆盖，按最早覆盖通知的持久接收顺序确定成员到期时间，
  再按真实 VCS 历史选择已到期连续前缀；N1 到 A3 的边界不能阻止吸收已到期的 A4/A5。
  分页仅暂停/恢复准备，不自动拆批。
- [ ] 未展开通知仍可能影响当前前缀时持久保存进度，不先提交较短执行批次；超过现有
  batch/字节预算才按明确边界拆分，期间复用已读页并让出调度机会。
- [ ] 来源核验后、完整代码准备前执行排除；缺字段时按三态规则处理，适用排除判定不明
  则有界重试/待处理，不误分析，也不伪造 excluded。
- [ ] 实现连续前缀组批，纳入前逐成员校验到期；其他来源、被排除成员、缺口和特殊历史阻断。
- [ ] Git 混合 push 逐成员决定，合并 diff 不跨 excluded；merge/force-push 范围不能按
  head 作者直接过滤，无法表达符合排除条件的范围时明确待处理。
- [ ] 超条数/文件/patch 限制时保留未消费尾部；净空变更有明确 skipped 原因。
- [ ] 所有命令仍遵守 scoped fetch、路径过滤、字符转义、凭据脱敏和 P4 传输重试合同。

产物：单一 VCS 的真实 fixture 与跨 VCS 公共分组断言。命令解析 fixture 必须来自可解释
的真实输出或现有协议，不为通过测试编造不存在的接口。

### P4：自动入口与消费者接线

依赖 P2、P3。

- [ ] 提取可 await 的单次 `runTriggerProcessing` 执行职责，复用现有 prepare/orchestrator，
  不复制第二套 review pipeline。
- [ ] 自动提交在鉴权、匹配 workspace 后 await 持久接收，再返回 202；失败返回 503。
  每个 Git provider 与 P4/SVN 都验证真实 HTTP 路径；不因 payload 的 bot/User/Client
  提示提前丢弃事件，不在接收阶段查全量账号。
- [ ] 自动路径绕开 latest-pending deduplicator，保留所有成员；PR/MR 等仍走既有目标去重。
- [ ] 禁止原始通知同时进入 legacy enqueue/timer；后台执行 handler 只接收已封存批次。
  N1/N2 的接收、展开完成、重复唤醒和补关联均不能各触发分析；N01 校验精确调用次数。
- [ ] bootstrap 组装默认 handler、scheduler、队列与 workspace 锁；CLI serve 启动 consumer，
  关闭时停止领取、等待/释放租约、flush outbox 并关闭 Redis/SQLite。
- [ ] 新 scheduler 基于 nextWakeAt 与唤醒信号，维护公平 ready heads；关闭时段不开始 VCS/LLM。
  多组周计划复用同一编译日历和调度头，不按组建立轮询器。
- [ ] 废除自动路径旧 timer 重试，接入统一瞬时错误分类和当前窗口；补齐 rate limiter
  的实际 provider/trigger key 语义验证，不能直接假定现有 triggerName 就是 LLM provider id。
- [ ] receipt 查询和 queue 状态使用当前认证/作用域权限；未配置/已删除 workspace 明确
  阻塞或失败，不错误路由到 default workspace。
- [ ] 确认旧的 PR/MR 评论命令、triage、manual/replay 不新增自动来源排除、120 秒等待或时段限制。

产物：从真实 server request 到 fake 审查依赖的端到端测试，以及一个受控 provider 的
实际分析 smoke。配置字段只有这个阶段接线完成后才可写成有效功能。

### P5：输出、恢复与可观测性

依赖 P4。

- [ ] prompt/task context、run snapshot、store schema 表达批次成员和范围，旧单提交 run 可读。
- [ ] 对所有输出通道处理多提交标题、链接、记录作者和提及；P4 同批 User+Client 一致，
  不从组批 key 推断责任人/IM 账号，不制造 compare URL。
- [ ] receipt 展示全排除/部分排除及规则 id；excluded 不调用发布器、标 reviewed、计费
  或触发 reconciliation。配置改变不复活历史 skipped；已封存批次保持排除版本。
- [ ] batchId/runId 计费只记一次；receipt 关联不增加执行数；等待耗时与执行耗时分离。
- [ ] 正常成功路径断言 N1/N2/N3 共两次分析和两份结果；重复/重叠通知后计数不变。
  已封存成员遇新通知只补关联；失败重试沿用原 batch/runId，不对原范围另建 review。
- [ ] 持久结果与按目标发布回执支持重入，非幂等响应不明标记待处理；失败报告保留
  `skipReconcile`，不得把调度状态投影成“无问题审查”。
- [ ] 逐条核验 Gitea/GitHub PR/MR summary 与 managed issue close/mark_resolved；完整性
  缺失时 fail closed，仍需 `ProblemResolutionAnalyzer` 明确批准。
- [ ] dashboard/API 显示 receipt/batch 关系、waiting reason、nextWakeAt、真实 backend 和
  durability；新增低基数指标与结构化日志，保持现有统计修改。
- [ ] 做接收后、封存后、投递后、输出后、ack 前等崩溃点演练，验证重启后数据和状态。

产物：用户能解释“为何未启动、合并了哪些提交、失败后如何继续”，且恢复不复制计费或
误关闭旧问题。若外部通道无法确认幂等，限制必须记录为待处理状态，不能声称 exactly-once。

### P6：文档同步、性能验收与切换

依赖 P5 以及所有已实现 backend/VCS 验收。

- [ ] 按下一节更新真实生效配置、示例和中英用户文档，标明旧默认到新默认的迁移。
- [ ] 按测试矩阵验证 100k pending / 1k workspace 的索引与调用次数，报告实测而非估算吞吐。
- [ ] 在相同规模加入最大规则预算、长字段/复杂 regex、全页 excluded 和混合任务 Client，
  验证匹配耗时、事件循环响应、一次编译复用、按页跳过写入及公平性。
- [ ] 加入大量不同 deliveryId 的重叠范围与持续追加通知，验证跨通知覆盖/关联按页
  读取、旧前缀持续前进、VCS 页复用和成功路径分析次数，不只测 enqueue 吞吐。
- [ ] 运行最后一次编辑后的全部适用仓库门禁；保存测试发现数量与日志。
- [ ] 只读观察→单 workspace 受控运行→逐步扩大；切换前排空旧自动 timer，备份队列。
- [ ] 演练新版未完成批次排空/导出与回滚，不让旧 consumer 读取新版 schema/key。
- [ ] 仅在已授权部署时部署；本轮没有部署、发消息或触发真实审查的任务。
- [ ] 稳定合同迁入 architecture/output/docs 和相应 skill 后，从当前路线图标为交付，
  删除已完成的这组 specs/plans；外部验收缺失的项目继续保留未完成状态。

## 3. 文档、AI 资产与 example 同步矩阵

| 表面 | 本轮文档任务 | 实施时必须同步 |
| --- | --- | --- |
| `Plan.md` | 加入活跃设计与执行包入口 | 按真实完成阶段更新状态，不仅勾选接口任务 |
| `docs/ai/index.md` | 加入设计/计划/测试导航 | 最终指向长期合同，删除失效 task 文档链接 |
| `docs/ai/architecture.md` | 补充自动入口现状与来源分组/排除设计入口 | §3.1/3.2/3.10/3.11 的调度、配置、批次和状态合同 |
| `docs/output-channels.md` | 暂不改，输出合同尚未实施 | 批次链接、来源快照/操作者/P4 Client 展示、来源排除无 review 输出及 reconciliation 边界 |
| `example/config.yaml`、`example/README.md` | 暂不加入未生效字段；周计划/机器人排除/跨通知案例放在设计草案 | 延迟、多组周计划与边界；exclude_sources 覆盖/语法、P4 User+Client；三通知两批次、重复通知不新建 run、到期/封存边界、202/receipt 与升级 |
| `example/p4-trigger.sh`、`example/svn-trigger.sh` | 暂不改脚本 | 仅在最终信封字段有变化时同步；事件操作者不代替 VCS 记录作者，P4 Client 保持准确，503 重投递和重复投递语义一致 |
| `docs/site/.../en` 与 `zh-cn` | 暂不修改已发布功能说明 | configuration/queue、overview、reference/config-fields、各 VCS 入口和 dashboard；同步来源分组、排除语法、字段缺失及重试/版本行为 |
| `prompts/system/code-reviewer.system.md` | 不把未来批次协议提前注入 agent | 批次与来源快照优先放每次 task context；禁止模型猜任务分组或机器人；excluded 成员不发起 agent review |
| runtime bundle/MCP | 不新增尚不存在的字段/工具 | 固定 batch head 的 context/blame 合同；如 schema 变化，同步 registry、adapter 与 prompt |
| `.agents/skills/agent-runtime-integration`、`output-channel-contracts` | 本轮不改稳定 workflow | 合并已实现的来源分组/版本边界、来源排除不发布/不关闭问题和输出恢复检查；不复制整个设计 |
| core manifest、lockfile、pnpm 构建白名单、部署镜像 | 仅记录 RE2 选型与验证任务，不改运行依赖 | 固定验证过的绑定版本、最小构建许可和各平台产物；补构建/打包验证，不放宽仓库门禁 |
| `AGENTS.md` / `AGENTS.known-pitfalls.md` | 根规则已能路由本任务，无需扩写 | 只记录实际修复的可复现易回归合同；不把本轮静态风险写成已修复事故 |

实现 schema 时，双语字段参考需覆盖三个配置层的数组元素路径；如引入 enum，按当前
config reference validator 的顺序要求更新。所有字段行为从代码重新核验，不能直接
把本设计的拟议文字粘贴成当前用户说明。

## 4. 验证与交付证据

本轮仅 Markdown，适用门禁为完整 markdownlint、链接/引用核对和 diff 范围检查；不以
未修改产品代码为由声称运行过新的调度测试，也不替用户验证其既有代码修改。

后续实施在最终编辑后依序执行 AGENTS.md 的 runtime 门禁：ESLint、`tsc -b`、全量
Vitest coverage、markdownlint、build、build 后 eval fixture validation；用户站内容变化
再执行 docs:check/docs:build。Windows 按根文档使用 Node 直接入口，Linux 以 `pnpm ci`
作为最终等价门禁。

每个 P0–P6 工作包需留下：变更文件、覆盖的测试矩阵编号、实际测试数量、通过/失败/
未执行项、外部 CLI/service 版本和证据路径。不得用 discovery、fake Redis 或静态代码
阅读冒充真实后端/端到端执行结果。
