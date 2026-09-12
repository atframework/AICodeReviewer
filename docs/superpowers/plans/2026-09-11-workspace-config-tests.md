# Workspace 与动态配置测试计划

状态：P0–P3 已完成；P4–P8 跨层验收仍待实施。P2 证据(2026-09-12):F/C/B/U 系列、S01–S13 四后端 conformance、M01–M20 适用后端合同,映射与边界见 [M17](../../ai/milestones/M17.md);P3 证据(2026-09-12):R01–R07/R11/R12 + legacy parity(config-compiler.test.ts 21 例)、S02/S03/S06/H07/H13–H15/C02/C03/C11/C12(config-publish.test.ts 14 例,SQLite 真实后端)、R13 零副作用 preview 与 readiness 六态(config-preview.test.ts 13 例),见 [M18](../../ai/milestones/M18.md);P1 证据见下方验收索引。
合同见 [详细设计](../specs/2026-09-11-workspace-config-management.md)，阶段见
[执行计划](2026-09-11-workspace-config-implementation.md)。

## 1. 测试组织与证据

单元测试使用现有 Vitest，位置遵循 `packages/*/test/**/*.test.ts`。新增纯函数放在可纳入 coverage 的 source 模块，不只从 coverage 已排除的 `src/index.ts` 导出实现。真实服务测试和 browser 测试单独分组，但均列入交付适用 gate。

复用现有 config/bootstrap/webhook/orchestrator、auto-commit conformance、database/catalog/dashboard tests 的真实 fixture 和调用链。期望数据手工构造，不通过被测 resolver 生成 expected，不只对内部函数调用次数或整对象 snapshot 做断言。

| 层级 | 覆盖对象 | 必须记录 |
| --- | --- | --- |
| 纯单元 | matcher、变量、路径 AST、merge/provenance、schema、UI mapping、format converters | 明确输入/有效值/错误路径；边界和阴性用例 |
| 组件合同 | ConfigStore、MigrationRunner、runtime generation、API、scheduler | 并发屏障、提交点、故障注入、引用与资源状态 |
| 真实后端 | SQLite 文件、PostgreSQL、Redis；旧数据升级并重连 | 服务和 schema 版本、隔离 namespace、旧数据数、重启后的读取/执行证据 |
| 端到端 | UI 到数据库到下一次 review；多个来源、多个工程 | config revision、路径、实际 provider/model、bundle 内容、原始输出请求 |
| 平台 | Windows/Ubuntu；native/Docker/Podman | 路径大小写、长路径、junction/symlink、挂载与工作目录 |

临时 DB、fixture 仓库、截图、日志放 `build/tmp/`、`build/logs/`；永久输入 fixture 放对应包 `test/fixtures/`。PostgreSQL 用专用 schema/database，Redis 用随机前缀，仅清理当前测试资源，禁止 FLUSHDB 和清理未知实例。

### 当前证据边界

2026-09-13 P2/P3 复审新增 74 项测试，覆盖快照跨 namespace、重试输入变更、
预览准入、缺失 revision、restore、非连续迁移账本、双命名空间 CLI/verify、
Redis WRONGTYPE/OOM/代际精度及 PostgreSQL 并发去重/汇总。代码与环境映射见
[M18 复审记录](../../ai/milestones/M18.md#2026-09-13-p2p3-复审)。OOM 使用
`AICR_REDIS_OOM_TEST_URL` 的独立实例，仅换逻辑 DB 不构成隔离。

| 实现与测试 | 已覆盖 | 尚待验收 |
| --- | --- | --- |
| `config-source.test.ts`、`config-review.test.ts` | 来源合并/文件锁、shadowed 视图、实体 CRUD、数组模型组、写前原型键校验、转换无副作用、raw YAML 边界 | F01/F02 的数据库初始化、F09 的重启流程、F11/C02/C03/C09 的原子引用与发布、C10–C13 的服务端实施 |
| `config-format.test.ts` | revision/namespace/generation、matcher 形状与 UTF-8 大小、路径转义、稳定哈希、实例身份、B05 snapshot 分类 | P1 的 matcher 编译、路径 AST、P2/P4 的存储和任务接线 |
| `config-components.test.ts` | U24 声明字段、默认值、workspace 实体所有权及 schema-only 标记的一致性 | P6 UI registry/映射函数和四项覆盖率 |
| `config-capabilities.test.ts` | passthrough 类型化 DTO、kind×字段能力矩阵、9 种 channel kind、`resolved_action` 逐 kind 取值、changeset 接入、catalog 键 parity | 文件配置侧能力提示(P5/UI)、P6 UI registry/映射函数和四项覆盖率 |
| `config-examples.test.ts`、`config.test.ts`、静态 YAML fixtures | 当前示例加载、旧格式转换及现有配置兼容；fixture b01–b05 为输入编号 | B02 compatibility graph、B04 CLI 无额外数据库、B06–B10 跨层行为 |
| `config-matcher.test.ts`、`config-path-template.test.ts`、`config-workspace.test.ts` | RE2/glob/exact matcher、模板 AST 白名单与渲染校验、match 互斥/trigger 引用/歧义、instance identity、legacy/isolated_v2 布局纯层 | matcher 在存储/API 层的复用、L13/L14 平台样例 |
| `config-resolution.test.ts` | 描述符字段目录、legacy 优先、规则 OR/字段 AND、多定义歧义、provider 变量范围与 W01/W02/W07/W10 纯层 | P4/P5 动态配置发布；scheduled 缺引擎，按合同不可用 |
| `source-descriptors.test.ts`（server） | V01 github push/PR/issue、V03 gitlab 多级 namespace/MR/note、V04 gitea、V05 tag push branch=null | 完整目录、VCS 与重启矩阵见下方 P1 验收索引 |
| `workspace-runtime.test.ts`（server） | legacy 布局与 `buildSourceRootResolver` 字节对等、isolated_v2 实例隔离、workspaces.root 覆盖、接受/执行渲染一致（W01/W10/L13 子集） | 全阶段矩阵见下方 P1 验收索引 |
| `webhook-match-resolution.test.ts`（server） | 四类 Git 真实签名 payload：hit/miss/ambiguous、repository/namespace、legacy、多 profile secret、鉴权先行与持久 binding | H 系列配置热更新 |

| `routing-admission.test.ts`、auto-commit conformance | P4 多范围/depot、SVN 显式根、路径不完整阻断、冻结事件离线重放、持久重试/wake 与幂等转交 | P2–P8 动态配置与多副本故障矩阵 |
| `review-orchestrator.test.ts` | 并发目录、模型回退中的源码、直连成功/失败/空变更清理、非法 runId、未知 owner 保留 | P4 workspace 级 agent/sandbox 配置覆盖 |

2026-09-12 审查新增的首批 35 项边界测试在修复前 31 项失败，修复后全部通过。
另补 4 项空映射覆盖边界，修复前均失败。此次累计新增 117 项测试。

2026-09-12 最终验证环境为 Windows、PowerShell 7、Node 24.21.0、Vitest 5.0.0：

| 门禁 | 结果 |
| --- | --- |
| ESLint、TypeScript、正式 build | 全部通过，build 覆盖 11 个 runtime packages |
| 完整 Vitest coverage | 发现 115 个文件，109 通过、6 跳过；2641 项通过、6 项跳过，无失败 |
| 新基础层覆盖率 | `config-source.ts` 行 98.30%、分支 90.82%；`config-format.ts` 行 94.63%、分支 90.81%；`config-components.ts` 行 95.48%、分支 94.94%；三者函数均 100% |
| Markdown | 发现 122 个文件，无问题 |
| eval validate | 6 个离线 fixtures 通过，未调用真实 LLM |
| docs:check / docs:build | 通过；Astro 0 errors、0 warnings、11 hints；构建 54 页 |

2026-09-12 第二批（P1 git 系 webhook 接线）最终验证，同环境：

| 门禁 | 结果 |
| --- | --- |
| ESLint、TypeScript、正式 build | 全部通过 |
| 完整 Vitest coverage | 117 个文件通过、6 个跳过；2819 项通过、6 项跳过，无失败（server 743 项，含 27 项新准入/布局/描述符用例） |
| Markdown | 122 个文件，无问题 |
| eval validate / docs:check / docs:build | 通过；构建 54 页 |

日志位于 `build/logs/workspace-config-review-final-*.log`。6 个环境选择用例因未配置
`AICR_REDIS_TEST_URL`、`AICR_SVN_TEST_EXECUTABLE`、`AICR_P4D_TEST_EXECUTABLE`
而跳过；本次未执行 Redis/SVN/P4 实服务用例，也未实现或验收新的配置后端、迁移、UI。

本轮 P1 审查先以新增回归确认失败，再修复实现；迭代记录在 `build/logs/p1-review-red.log`、`p1-review-routing-red.log`，最终全门禁记录在 `build/logs/p1-review-final-*.log`。最终统计以该组日志为准，上表历史数字不代表当前树。

## P1 完成验收索引（2026-09-12）

| 验收项 | 当前证据 |
| --- | --- |
| W01–W11 | core config-matcher/config-path-template/config-workspace/config-resolution；server webhook-match-resolution/workspace-runtime；W11 为 source_repo/match 互斥 |
| W12 | workspace-source-contracts 的静态停用、HTTP 拒绝、删除配置后快照读取；SQLite 关闭重开；动态 CRUD/发布 API 仍属 P5 |
| W13 | webhook-match-resolution 与 bootstrap 的多 profile secret/token、目标仓库凭据测试 |
| W14–W15 | routing-admission 与三个 store conformance；workspace-routing-live 使用真实 P4/SVN 双工程提交、独立 instance、幂等重放 |
| V01–V05/V11–V13 | source-descriptors 与 workspace-source-contracts：全登记目录有效/缺省 fixture、十进制 ID、fork/多级 namespace、已删除 ref、provider 范围、scheduled unavailable |
| V06–V10 | VCS source-descriptors：P4 recorded stream/classic/缺字段/冲突，SVN XML/UUID/root/去凭据；真实 VCS 和显式 project roots |
| V14 | full variables/provenance 随事件与收据固定；sqlite-auto-commit-store 关闭重开与三后端 conformance；routing-admission 冻结后不再查询 VCS |
| L01–L08 | config-path-template/config-workspace 与 review-orchestrator 的参数、预算、设备名、链接包含性及执行前重检 |
| L09–L12 | 并发 HOME 文件写入、独立 sandbox factory、源码/context/MCP 目录；P4 主机/运行根 client 哈希；run 生命周期与陈旧 owner 保留 |
| L13 | workspace-policy 的模板/AGENTS/skills 只读回退与优先级；bootstrap/CLI/直接 publisher 显式目录接线；SQLite reflection 按 instance 隔离 |
| L14 | workspace-host-filesystem 及同源 probe：Windows 主机与 WSL Debian tmpfs；Unicode、超过 260 字符路径、大小写、junction/symlink、两工程相同渲染路径 |

真实服务工具解压在 build/tmp/p1-tools/：SlikSVN 1.14.5、P4D 2025.2、Debian Redis 8.0.2；服务只绑定
loopback，数据位于 build。Linux probe 使用 Node 24.21.0，tmpfs 类型值 16914836；
Windows 实测不区分大小写，Linux tmpfs 区分大小写。两者均通过同一组文件读写断言。

完整门禁依序执行 ESLint、TypeScript、覆盖率、Markdown、build、eval fixture、docs:check、
docs:build，日志为 build/logs/p1-completion-final-*.log。真实 VCS 和 Redis 的 opt-in 在本轮门禁中
全部启用。Redis 实测发现并修复 routing receipt 空数组经 Lua/cjson 变成空对象的问题；
三后端共同测试固定空解析结果的重复接收、重试、完成和不可覆盖回放。Linux 文件系统
probe 不代表 Linux 全量测试或容器部署验收。

## 2. 配置与来源合并

建议位置：`packages/core/test/config-source.test.ts`、`config-format.test.ts`、现有 `config.test.ts`。

| ID | 场景 | 关键断言 |
| --- | --- | --- |
| F01 | file-only / DB disabled | 现有示例有效值不变，不连接数据库 |
| F02 | DB enabled 但无 admin/catalog/reflection | 仍加载配置存储，业务字段生效 |
| F03 | 同字段 file/DB/default 冲突 | file 显式值赢；provenance 和被覆盖值准确 |
| F04 | file 未声明但 Zod 有 default | DB 值赢；default 不会提前锁住字段 |
| F05 | `false`、`0`、`[]`、空 object、missing | 各类继承/覆盖语义分别断言，数值非法时仍由 schema 拒绝 |
| F06 | provider/trigger/channel/group/workspace 同 ID | 文件实体整体只读；新 DB 冲突写失败，不偷偷合并数组位置 |
| F07 | 全局嵌套字段合并 | 文件锁定 max_files 不阻止 DB 设置未定义 output_language；来源路径可定位 |
| F08 | 删除 DB override | 恢复下层值，删除与 JSON null 不混淆 |
| F09 | 文件新增同 ID、重启后 shadowed | DB 原记录可见，不能改文件；删除 shadowed DB 不影响 file effective value |
| F10 | 文件 source locations/顺序/别名 | YAML parsing 使用结构化节点；兼容转换后保留来源映射，文件字节不变 |
| F11 | 复制文件对象为 DB 新 ID | secret 只复制引用；依赖修改在同 changeset 中校验 |
| F12 | 解析默认值只执行一次 | 局部 defaults 不盖住更具体层；array 整体替换与原 helper 一致 |
| C01 | 重复名称、空模型组、空 ID | 字段错误和实际 entity/path/code 准确 |
| C02 | 删除被引用 provider/model group | 原子拒绝；同 changeset 改引用后可删除 |
| C03 | 删除被引用 trigger/channel/workspace | 不静默丢输出或自动使用第一项 |
| C04 | 非法 credential env、缺少 endpoint | 按 component kind 验证，不泄漏环境值 |
| C05 | 禁止 DB 修改 bootstrap/server/admin/storage/root | API 和直接 service 调用都拒绝 |
| C06 | 未识别 passthrough 扩展 | 旧记录无损保留，新编辑不伪造支持；最新废弃键仍拒绝 |
| C07 | chain/provider/catalog 参数优先级 | 最终 ModelSpec 的参数、价格、能力、role 顺序准确 |
| C08 | URL/template/matcher/view 条件非法 | 在 prepare 前拒绝，错误映射到具体字段 |
| C09 | batch create provider+group+route | 一次 revision、所有引用有效；其中一项错全部不写 |
| C10 | 直接绕过 UI 改 file entity | `file_owned`，文件和 DB head 均不变 |
| C11 | namespace/fileDigest 不同 | 不混读或接受错误来源配置 |
| C12 | 旧版本 restore 与当前 file 冲突 | restore 重新校验，返回冲突而非绕过锁 |
| C13 | schema-only/reserved capability | UI/API 一致拒绝激活，不接受后静默忽略 |
| C14 | format converter 重复运行 | 已到目标版本为 no-op，不双重包装 model groups |
| C15 | malformed YAML/JSON、超大文档、原型键 | 拒绝且无污染、无半 revision、无日志明文 |

## 3. Workspace 匹配、变量与目录

建议位置：core `workspace-rules.test.ts`、`workspace-template.test.ts`，server `source-descriptor.test.ts`，既有各 webhook tests 与 VCS tests。

| ID | 场景 | 关键断言 |
| --- | --- | --- |
| W01 | 同 rule 匹配两个 repo | 同 definition、不同 instanceId、路径、记忆和统计工程 |
| W02 | 多条 match OR / 单条条件 AND | 非命中 repo 不进 fallback workspace |
| W03 | exact/glob/regex | `*`/`?`、斜线、Unicode、regex anchors 语义与文档一致 |
| W04 | regex lookaround/backreference | RE2 拒绝，无 JS regex fallback |
| W05 | case-sensitive/ignore_case | 匹配可忽略大小写，持久 identity 原样保留 |
| W06 | pattern/field/rule count 上下界 | 限值刚好通过、超 1 拒绝，字节与 code point 分别断言 |
| W07 | 同优先级多个 definition | 返回歧义及冲突 ID，不按字典顺序选 |
| W08 | 显式 route 选择一个候选 | 最终 workspace 在来源允许范围内 |
| W09 | route 扩大 trigger 范围 | 拒绝，签名有效也不代表任意仓库授权 |
| W10 | legacy source_repo/repos.match | 原精确/后缀/大小写/顺序完全保留，不把星号改为新 glob |
| W11 | source_repo 与 match 同时配置 | schema 报互斥错误 |
| W12 | repo/trigger 停用或删除 | 新任务不接受；既有任务仍能查 snapshot |
| W13 | 多 profile 不同 secret/token | 鉴权前不解析工程，选中 profile 的出站凭据正确 |
| W14 | P4/SVN 待解析 routing receipt | 先持久再 202；失败 503；后台转换重复执行只生成一份正式 receipt |
| W15 | P4 单 changelist 跨两个 scope | 分区独立，父 delivery 可追踪，同 scope 不重复 |
| V01 | GitHub push/PR/issue/comment | owner/repo/ref/branch/number 可用性正确；issue 分支为 null |
| V02 | fork PR | target 仓库决定身份，head 仓库字段单独提供，不跨工程取 token |
| V03 | GitLab 多级 namespace/MR | `group/sub/project` 不截成两段，source/target/iid/id 不混 |
| V04 | Gitea/Forgejo 独立来源 | 仅匹配的 provider namespace 可用，无 installation 伪值 |
| V05 | Git tag、deleted ref、detached commit | branch null，ref 真实；SHA 不当分支名 |
| V06 | P4 user/client/服务账户 | changelist User+Client 用于提交者字段；service_client 独立 |
| V07 | P4 stream/classic/missing client | 有证据时给 stream，无证据时 null；不得由 depot 前两段或当前 client 状态推定历史 stream |
| V08 | P4 describe/client 网络失败或冲突 | 持久 retry/unknown；不伪造 client/stream，不丢通知 |
| V09 | SVN info XML/UUID/root/URL | parser 正确，缺字段可空；URL 不含凭据，不从 payload 接受任意地址 |
| V10 | SVN 无约定 branch 布局 | branch null；有显式 roots 时准确得到 project/branch |
| V11 | manual/scheduled | 仅受信字段可用，缺 engine 的 scheduled 标 unavailable |
| V12 | 未知变量/错误来源命名空间 | AST 校验失败，UI 同目录拒绝补全 |
| V13 | 全量 variableDescriptors | 每个登记变量至少一个有效 fixture 和一个缺省/事件边界 fixture，无无人提取变量 |
| V14 | 身份元数据持久化/重放 | 重启后变量、project key 不因 payload 缺失或新配置重新解释而变化 |
| L01 | 普通模板和 helpers | 目录预览与实际路径完全一致，包括固定 instance 后缀 |
| L02 | null/default、0/false、空值 | strict + 显式 null 可正确 default；未处理 null 不创建目录 |
| L03 | 两个非法字符字符串 slug 相同 | 编码/hash 分离，完整身份和 binding 唯一性检查兜底 |
| L04 | `../`、绝对路径、盘符、UNC、反斜线 | 拒绝，不能逃逸 workspaces.root |
| L05 | NUL、控制字符、Windows CON/AUX、尾点/空格 | 编码或拒绝行为与 segment 合同一致 |
| L06 | `constructor/__proto__/prototype`、lookup、partial、block | AST 拒绝；无原型访问、无 helper 注入 |
| L07 | AST 深度/节点数/template 长度/结果长度 | 各自限值 ±1；不发生耗时无界解析 |
| L08 | symlink/junction 指向根外、同前缀 sibling | realpath/relative 拒绝；检查后目录变化在执行前再次发现 |
| L09 | 同工程并行 runs | source、agent、tmp、MCP state、HOME/XDG/context repos 无相互覆盖 |
| L10 | 两工程同 branch/repo 名不同 host/owner | instance identity 不碰撞，source root 和凭据不同 |
| L11 | P4 service client 并发 | 唯一 client 或租约串行，不能改另一个运行中的 client root |
| L12 | work_path 更新时旧 run 活跃 | 旧路径持续有效，新 run 用新路径，GC 不删除有引用目录 |
| L13 | legacy layout 的模板/skills | 旧查找路径仍可用，新 layout 显式对象准确传到所有消费者 |
| L14 | Windows/Linux Unicode、长路径和大小写 | 分别跑主机测试，不能拿 path.posix 模拟结果宣称 Windows filesystem 通过 |

## 4. 路由与运行时更新

建议位置：server `routing.test.ts`、`runtime-config-manager.test.ts`，现有 `bootstrap.test.ts`、`review-orchestrator.test.ts`、`auto-commit-*.test.ts`、CLI tests。

| ID | 场景 | 关键断言 |
| --- | --- | --- |
| R01 | trigger/target/source 组合 | 条件 AND、列表 OR，明确 priority 顺序 |
| R02 | 同优先级冲突 | 返回 ambiguous_route，不执行分析 |
| R03 | route 指向不存在/停用 workspace | 发布失败；有效来源范围仍校验 |
| R04 | model/main/triage/summary 层次 | global/defaults/workspace/route 的最终模型逐项正确 |
| R05 | outputs missing 与 `[]` | missing 继承、空数组关闭；legacy 空数组仍按旧图回退 |
| R06 | 无匹配 rule | 无首 workspace/首 inline channel 意外 fallback |
| R07 | PR/MR 与 push/P4/SVN 目标兼容 | inline 需要编号，managed issue/chat 能接对应汇总 |
| R08 | 两种输出同时选中同 channel | 原始请求数准确，summary flush/reconcile 无重复 |
| R09 | no_problems 各层与混合 channel | suppress/publish/publish_if_summary 逐 channel，错误报告不被抑制 |
| R10 | 生命周期 reconciliation | 配置改变不关闭未确认问题，不重发未知远端 POST |
| R11 | 一事件多 route 候选 | 只执行一次分析；无隐式 fan-out |
| R12 | 新旧 routing 混用 | 同 trigger 受两套声明控制时报明确冲突 |
| R13 | preview 与真实执行 | 对同一归一事件和 revision 得到相同 workspace/model/path/channels |
| H01 | 更新 provider endpoint/params | 下一任务真实 client 参数更新；旧 client 不被原地修改 |
| H02 | 模型组排序/entry override/catalog override | direct、agent fallback、summary、triage、resolution 同版本且实际模型准确 |
| H03 | workspace agent/search 切换 | 实际 command/config/env/manifest 改变，非仅 AppConfig 变 |
| H04 | sandbox 变更/不可用 | 下一 run 的 backend 和 mounts 正确；明确容器要求失败不转 native |
| H05 | Review 全字段 | 对每个可管理字段断言消费结果：过滤文件、限制、prompt 语言、标签、fetch budget、reflection 等 |
| H06 | 新增/删除/变更 trigger | 下一请求新鉴权/registry 生效，无重复 Hono 路由、无旧 secret 混用 |
| H07 | run 中途更新 channel/route | 旧 run 保持原目标；新 run 用新目标，统计写实际 revision |
| H08 | 已排队 receipt/job 更新配置后执行 | 使用首次接收 snapshot，不在执行时换模型或重置 delay |
| H09 | snapshot 变化边界组批 | 两版本成员不在一批；后到 receipt 覆盖已有 member 时沿用首归属，成员不丢、不重复，stream active batch 仍有序 |
| H10 | 同 delivery 更新前后重投 | 一次接收，版本变化不改变 delivery dedup key |
| H11 | snapshot/pin 写成、receipt 写失败或关联前崩溃 | 孤立 pin 可对账回收；receipt 后端不可达不 GC；可重试且不虚假 202 |
| H12 | 历史 receipt 缺 snapshot | 升级时统一绑定 legacy_import；重试/restart 不随最新配置漂移 |
| H13 | 并发两次保存 | 一个 CAS 成功；另一个冲突，不能覆盖已写 revision |
| H14 | commit 后本机 prepare/install/响应失败 | 查询 operation 得到持久状态；阻止新 admission，重建而非谎报回滚 |
| H15 | 两副本 notify 丢失/断连 | durable head 屏障使新任务看到新版本或 503，不接收旧版 |
| H16 | generation drain/close | 最后旧 run 结束才关闭资源；新 generation 不被旧 close 影响 |
| H17 | concurrency/rate/budget 修改 | 新 claim 更新限制，不取消已运行任务、不清空计费和限流计数 |
| H18 | fileDigest 不同、DB 不可达、schema 较新 | readiness/诊断正确；已有 pin run 可继续，新任务暂停 |

H05 为参数化合同，必须穷举 P0 字段清单，不能只测 max_files 代表整个 Review。H02/H03 覆盖全部已实现 adapter 的能力差异，不要求不支持的 adapter 假装支持搜索。

## 5. ConfigStore 与 migration

建议位置：`packages/store/test/config-store-conformance.ts` 及各 adapter 测试，core 既有 auto-commit store conformance，CLI migrate tests。

| ID | 场景 | 关键断言 |
| --- | --- | --- |
| S01 | 初次读写/无 head | 空 DB 创建唯一初始 revision；读取不可变副本 |
| S02 | 同版本两个 changeset | 一个成功一个冲突，audit 与 head 对应 |
| S03 | operationId 重试/响应丢失 | 相同内容返回同 revision；相同 ID 不同内容拒绝 |
| S04 | 批量实体变更失败 | head 和可见文档不变，无半成功引用 |
| S05 | snapshot pin/unpin/reopen | 持久读取完整有效配置；GC 不删除 pending/running 引用 |
| S06 | audit/redacted diff | actor/时间/实体准确，无凭据值 |
| S07 | revision restore | 新 parent/new revision，当前 file 锁与引用重新校验 |
| S08 | instance binding 冲突 | 同完整身份幂等，路径冲突不共用其他项目 |
| S09 | namespace 隔离 | A 的读写/cleanup 不影响 B 或 queue/catalog |
| S10 | 服务重启/客户端新连接 | 配置和 operation 历史仍可见；memory 明确不持久 |
| S11 | 整数/Unicode/JSON/time 跨后端 | safe integer 外的 revision 不丢精度，null/missing 语义一致 |
| S12 | session hash/过期/撤销 | token 不持久明文，登出在另一个副本生效 |
| S13 | close、超时、连接失败 | 有界错误，无连接泄漏或静默 file fallback |
| M01 | 全新 SQLite/PostgreSQL/Redis | 自动初始化最新格式，第二次启动无重复 DDL |
| M02 | SQLite store 001–006 各版本 | 用真实历史 DDL fixture，保留业务数据，不拿当前 schema 打旧版本标签 |
| M03 | SQLite auto-commit v1/v2/v3/v4 | 保留 receipt/member/checkpoint/cursor，最新版本与数据都正确 |
| M04 | 锁内重读已应用 migration | 两个进程并发启动只有一次 ALTER/版本写入 |
| M05 | SQL DDL/data 中途失败 | 同事务 rollback，版本不前进，重开可重试 |
| M06 | SQLite busy/读事务存在/磁盘错误 | immediate 有界等待，不能半升级或无限循环 |
| M07 | PostgreSQL advisory lock 和 client | 事务结束释放，错误 rollback；不能混用 pool.query |
| M08 | PostgreSQL 权限不足/timeout | 健康诊断明确，未提交表/配置不可见 |
| M09 | Redis partial generation 构建崩溃 | old head 可读，重启从 checkpoint 恢复；只有完成 manifest 可激活 |
| M10 | Redis lease 过期后旧 writer 返回 | fencing 拒绝旧 writer，不能覆盖新 head |
| M11 | Redis WRONGTYPE/OOM/Lua 失败 | 先验证且 head 最后提交；不依据 Lua 自动回滚假设通过 |
| M12 | Redis Pub/Sub 丢失与重新连接 | version polling/admission head 检查恢复，不依赖补投通知 |
| M13 | Redis 数据迁移 TTL/计数/键范围 | app-owned 键和 job payload 保留合同，不改 BullMQ 私有键，不全库扫描清空 |
| M14 | 历史模型组数组/alias/triage | 保留顺序和覆盖参数，名字冲突有诊断，转换幂等 |
| M15 | 新旧字段冲突、损坏 JSON、版本缺口 | 不启动 worker、不覆盖原文、错误字段可定位 |
| M16 | checksum 修改/未知较高 schema | 阻止旧程序启动写入，原数据不改 |
| M17 | 首次升级 drain 与旧 writer | 禁止迁移时旧进程继续不兼容写入；未排空给明确状态 |
| M18 | reader/writer 兼容窗口 | 新旧程序各自可读写范围明确，超范围拒绝，不用单版本 mock 代替 |
| M19 | --status/--check/--apply、auto/verify | 前两项只读；apply 与启动同 runner；退出码与状态一致 |
| M20 | 降级/restore/备份恢复 | restore 只恢复业务配置，schema 不回退；旧程序不能误读新格式 |

PostgreSQL 必须额外运行已有 stats、project retention、reflection、catalog、recordReviewRun/usage 合同；SQLite 的成功结果不能证明 PostgreSQL 已支持。Redis 以独立配置源运行，不要求承担 SQL dashboard 统计。

## 6. API、UI 范式和交互

建议位置：`packages/server/test/config-api.test.ts`、`config-ui-spec.test.ts`、`config-form-mapping.test.ts`、`dashboard-config.test.ts`，以及正式 browser suite。

| ID | 场景 | 关键断言 |
| --- | --- | --- |
| A01 | 未登录/过期/登出 | GET/POST 均按合同拒绝；无配置元数据泄漏 |
| A02 | workspace key/webhook token 冒用 | 不能进入管理员写 API |
| A03 | 文件实体/字段修改与删除 | API/service 两层均拒绝，文件字节不变 |
| A04 | admin 不启用/配置 store 不可用 | 可用性状态明确，不依赖统计页才能解释 |
| A05 | 所有 GET 脱敏 | provider URL/header/secret env/错误/审计无原始 secret |
| A06 | secret ref allowlist 与用途 | 未允许 env 名拒绝，不可借配置转发任意进程 secret |
| A07 | path_prefix 和多副本 session | API URL、登录、刷新、登出都正常 |
| A08 | request 大小、类型、分页边界 | 有界响应和稳定 status/error code |
| A09 | validate/preview | 不写数据库、不创建目录、不调用 LLM/远端 POST |
| A10 | operationId/ETag 或 baseRevision | 重复提交幂等，并发冲突 409，草稿可保留 |
| A11 | revision restore | 审计产生新版本，原 revision 只读 |
| A12 | committed_activating | 不显示为 active 成功；重查恢复正确状态 |
| A13 | 原型污染/path token 越权 | 不能写未登记或 bootstrap path |
| A14 | malicious config/repo text | UI 文本渲染，无 HTML/script 执行，模板预览不注入 |
| A15 | 来源校验/日志异常 | 跨源写入被拒绝，日志无 token 和敏感原文 |
| U01 | ConfigUiSpec 重复 ID、缺 section/label | registry validation 拒绝，并定位条目 |
| U02 | path 指向未知字段/原型键 | spec 和 changes 双层拒绝 |
| U03 | control/type 不兼容 | 不能给 enum 用任意数字或给 boolean 写字符串 |
| U04 | required/optional/default | 缺省展示与写入分开，不把 default 当用户 override |
| U05 | inherit/override 切换 | 删除 override 的动作准确，false/0/[] 不被清除 |
| U06 | number 输入 | 空、负值、小数、NaN、上下界、单位分别测；不靠 Number 空串变 0 |
| U07 | toggle/select/multiselect | false、未知 enum、去重、空列表、动态选项消失有明确结果 |
| U08 | ordered-list 插入/删除/重排 | stable row ID 和参数跟随行，不按旧 index 写错模型 |
| U09 | map key 编辑/重复/转义 | model/provider 含 `/`、`.`、`~` 时 path token 不歧义，原型 key 拒绝 |
| U10 | secret-ref | 只传引用，空值/继承/已配置状态不把 mask 写成凭据 |
| U11 | matcher 专用控件 | exact/glob/regex 互斥、ignore_case 和错误提示与 matcher 一致 |
| U12 | path-template 控件 | 变量补全、可空提示、完整路径/错误预览使用同 registry |
| U13 | visibleWhen | true/false/missing/unknown ref 及依赖环路分别验证 |
| U14 | kind variant 切换 | 旧字段不提交到新 kind，回切保留草稿，显式显示删除影响 |
| U15 | capability changes | adapter 更换后不可用字段禁用，不能静默丢掉已保存值 |
| U16 | read-only provenance | file/default/DB/shadowed 状态准确，不提供非法修改命令 |
| U17 | unknown passthrough fields | draft roundtrip 保留，无法编辑的字段不丢失 |
| U18 | decodeDraft/encodeChanges roundtrip | 每个组件全字段输入往返与原语义一致，不依赖同函数生成期望 |
| U19 | resolveOptions 失效引用/加载失败 | 不默认选第一项，展示引用错误或重试状态 |
| U20 | API 字段错误映射 | entity/path 指向正确行和控件，动态数组重排仍对应正确记录 |
| U21 | 保存失败/冲突/响应丢失 | 草稿不丢；operation 查询不重复提交；无法误报已生效 |
| U22 | 原子 changeset 多页编辑 | provider/group/route 一次保存，取消不写，删除影响准确 |
| U23 | 所有页面空/加载/禁用/错误状态 | 可访问性标签/焦点/按钮状态，移动窄屏不遮挡 |
| U24 | 描述与实现覆盖完整性 | 每个组件字段都有 schema、consumer、控件或不可用理由、正反测试；新字段遗漏使 gate 失败 |

范式四项覆盖率要求只针对新增通用描述/映射/renderer 状态模块设置严格阈值，不降低全仓门禁，不通过 exclude 抹去难测分支。UI 专用业务控件必须覆盖本矩阵，浏览器测试不能替代 mapping 的单元证据。

## 7. 兼容与端到端验收

| ID | 场景 | 关键断言 |
| --- | --- | --- |
| B01 | 当前 example/config.yaml | file-only 加载与现有有效值一致，planned 注释不进入 config 对象 |
| B02 | 历史 `source_repo`/repos/output route | 原图和 compatibility graph 对固定输入输出一致 |
| B03 | 废弃 llm alias | 只在 versioned converter 转换，最新 schema 仍拒绝 |
| B04 | 无数据库源旧 CLI | 不发生额外 DB 创建/连接，原退出码/dry-run 行为一致 |
| B05 | 旧 run snapshot | 可读取和展示为 legacy，不伪造新 revision |
| B06 | CLI source-root | 显式路径仍有效，sandbox layout 不从目录名误推 |
| B07 | review/eval/dry-run/serve 同配置 | 解析 provider/group/workspace 一致；dry-run 不产生外部输出 |
| B08 | 现有模型 fallback/triage/resolution | 无跨 workspace shared state 污染，输出 lifecycle 保护仍在 |
| B09 | 动态 workspace project retention | 通配工程不被软删除，移除规则不删除活动 run/历史数据 |
| B10 | 老目录与 cache GC | 有引用路径保留，清理仅限受管理根和无活动引用实例 |
| E01 | UI 新建 provider→group→route→workspace | 数据库正确，下一次审查实际使用新 group，原始输出指向正确 channel |
| E02 | UI 更新运行中的配置 | 老 run 固定旧 revision；下一 run 全链新 revision，无混合参数 |
| E03 | UI 展示文件与 DB | 文件 CRUD 禁止；复制新 ID 成功，provenance 可见 |
| E04 | GitHub 两 repo 同 rule | 不同目录/bindings，正确模型与 PR/commit 输出目标 |
| E05 | GitLab subgroup/fork | 源/目标 branch 和 project 不混，路径/凭据归属正确 |
| E06 | P4 多 stream/classic client | 用真实命令 fixture/本地服务验证 scope、client、User、stream 缺省 |
| E07 | SVN 多 project | 真正 post-commit→HTTP→存储→后台 metadata→review，目录与 branch roots 一致 |
| E08 | 三种配置后端旧数据升级 | 重开后配置仍在，业务数据计数不变，再处理新事件使用新 schema |
| E09 | 双副本发布/断连/崩溃 | 新 admission 看新 head或明确不可用；无重复 revision/receipt/外部请求 |
| E10 | 管理页面桌面/窄屏 | CRUD、选择/排序、preview、继承/冲突、只读、状态查询完整可操作 |

输出验收同时检查原始请求数量与解析后的目标/body/模型/版本，不能只看“published”状态。配置更新不纳入“未知远端发布结果自动恢复”，不得为本测试擅自重发已可能成功的 POST。

## 8. 最终门禁与完成标准

实施后的最终修改完成后，Windows 按仓库规定依次运行：

```text
node node_modules/eslint/bin/eslint.js . --max-warnings=0
node node_modules/typescript/bin/tsc -b tsconfig.json --pretty false
node node_modules/vitest/vitest.mjs run --coverage
node node_modules/markdownlint-cli2/markdownlint-cli2-bin.mjs
cmd /c "pnpm build"
node packages/cli/dist/index.js eval --validate-only
```

Linux 使用 `pnpm ci`。修改 docs/site 时另跑 `pnpm docs:check`、`pnpm docs:build`。新增正式 browser suite 和真实 PostgreSQL/Redis acceptance 在 CI/文档中有独立可复现命令，命令确定后再写进已支持 CLI 文档。

当前改动包含 core 运行代码、schema、单元测试及双语文档，适用上述完整序列和文档站校验。数据库迁移、真实配置后端及浏览器场景尚未实现，不能用这轮纯层测试代替。

完成证据按后端/平台逐行记录：版本、运行命令、测试文件和用例数、失败/跳过数、真实服务或 mock、残留风险。缺环境被 skip 的测试是未执行；PostgreSQL/Redis 全被跳过时不能写“支持所有数据库已验收”。任何范式分支缺测、只测试注册而未调用、源配置可通过 API 修改，均阻止交付完成。
