# IM 集成开发计划

状态：实施中。2026-09-28 完成计划并取得实施授权；按执行手册逐项推进。
真实平台验收（IM-21）仍需单独授权的测试账户，未验收前相关任务保持 pending_external。

设计与接口依据：

- [逐项执行手册](docs/design/im-implementation.md)：23 项任务、前置依赖、文件/符号、操作顺序、禁止捷径和交接提示词
- [实施规范](docs/design/im-implementation-spec.md)：配置/模块/存储原子操作、状态机、默认值和恢复边界
- [验收矩阵](docs/design/im-acceptance.md)：103 组断言、测试位置、故障注入、最终命令和真实平台证据
- [集成、回调与重新评审](docs/design/im-integrations.md)
- [外部成员目录格式与热加载](docs/design/member-directory.md)
- [配置与目录草案示例](example/im-integrations-design.md)，不能作为当前运行配置加载
- [官方接口核查记录](docs/ai/sources/im-integrations.md)

## 范围与前提

支持企业微信应用推送、文件成员目录、企业微信应用/API 模式机器人及飞书应用的消息和事件回调，
通过消息命令或按钮指定已授权仓库的 commit 发起新评审。传统 webhook 群机器人保留推送职责。

范围确认（2026-09-28）：企业微信机器人包含 API 模式（`wecom_aibot` 连接）已确认纳入；
`watch` 一词指 IM 回调事件监听（@机器人的命令与按钮事件），不含仓库订阅——
长期 `watch/unwatch` 通知订阅另列扩展，不隐含在单次重新评审中，且已确认不纳入本次交付。
实施环境结论：应用发送以成员通知（recipients）为主路径；测试应用与机器人已获通讯录
根权限，appchat 前提成立，IM-21 不验证权限受限负路径；飞书为境内版（Lark 仅入口域名
与账号体系不同、API 形态一致，`base_url` 已可配置，测试只测境内）；
公网回调 HTTPS 入口为 `https://aicr.x-ha.com/`，回调路由挂在其 `server.path_prefix` 前缀之后。
禁止用 webhook URL 推导会话 ID，禁止把通讯录当作操作权限表。
可执行 review 命令要求关系型 StoreDb 和已启用的持久 ConfigStore；file-only 模式仍可使用推送/文件目录。
IM-00–02 已完成；其余进度以任务清单和对应测试证据为准。实施已获授权，按任务依赖继续推进。

## 执行任务清单

默认按 IM-00–22 顺序。每项详细输入、改动、验收及停止条件见[对应任务卡](docs/design/im-implementation.md#4-任务卡)。
checkbox 仅在实现接线、断言和适用门禁均通过后勾选；implemented、blocked、pending_external 仍不勾选。

- [x] IM-00：基线、协议常量、XML 依赖精确版本和 fixture 来源核查。
  基线与常量矩阵见 `build/tmp/im/protocol-matrix.md`；长期结论并入
  [来源记录](docs/ai/sources/im-integrations.md)（W11–W14、XML pin 5.11.1/≥5.10.1）。
- [x] IM-01：共享类型、严格 schema 和 ReviewEvent 来源。
  新增 core `im-config.ts`/`im-contracts.ts`（C01–C03 覆盖于
  `packages/core/test/im-config.test.ts`、`im-contracts.test.ts`）；`ReviewEvent.requestOrigin`
  已贯通 strict schema；新字段在字段 inventory 中登记为未接线只读行。
- [x] IM-02：配置来源/实体/引用、凭据、snapshot 兼容。
  `im_connection`/`im_command_binding` 实体注册进全部配置链（collection 映射、DB 文档 schema、
  引用收集/删除改名保护、发布 available 集、preview 枚举）；IM 凭据进入密封注册与 corp/app
  目的地授权（C04–C07 core 侧覆盖；管理 UI 表单留 IM-03）。
- [x] IM-03：配置管理 API、字段 inventory 和表单闭环。
  新增 im-connections/im-bindings 实体页（kind 分组、引用候选、密文控件、合成名称字段）；
  有真实消费者的字段（引用完整性/密封/目的地授权链）翻 wired 并标注消费者，其余保持
  只读到对应任务接线（C08 闭环于 config-api 与浏览器用例：创建→编辑→暂存→发布→恢复、
  引用删除与协议切换原子拒绝）。
- [x] IM-04：企业微信应用 client、token 和业务错误。
  新增 outputs `wecom-app.ts`（token single-flight/过期/凭据隔离、message/send 与
  appchat/send、判别 delivered/partial/rejected/unknown、固定 40014/42001 单次刷新）
  与 server `im/connections.ts`（凭据解析/按凭据身份缓存）；O01–O04 覆盖于
  `packages/outputs/test/wecom-app.test.ts`、`packages/server/test/im-connections.test.ts`。
- [x] IM-05：应用发布、模板、分片和真实 bootstrap 接线。
  新增 `wecom-app-dispatcher`（UTF-8 安全 2048 字节分片、固定 part 序号、逐片回执）
  与 bootstrap wecom_app 分支（连接注册表、recipients/appchat 目标、混合路由）；
  修复 webhook 手机号字段（有界 text 提醒）与业务 errcode 检查；发布日志扩展
  wecom_app provider（凭据无关操作身份、分片 identity、errcode 记 rejected）；
  O05–O08 覆盖于 `packages/server/test/wecom-app-publishing.test.ts`。
- [x] IM-06：严格 YAML/JSON 成员目录解析。
  新增 core `member-directory.ts`（严格 JSON 解析器含重复键/非有限数拒绝、YAML
  uniqueKeys/禁别名/禁自定义 tag、上限与注入防护、按 scope 的 mention 类型校验、
  不可变输出 + digest）；D01–D04 覆盖于 `packages/core/test/member-directory.test.ts`。
- [x] IM-07：父目录 watch、poll、原子 reload 和资源生命周期。
  新增 server `im/member-directory-service.ts`（父目录 watch + 300ms/2s debounce 上限、
  周期内容摘要 poll、single-flight+排队跟随读、watcher 失败有界退避重挂、按路径共享
  读取器/按 scope 隔离视图/引用计数释放、dirty 不用旧身份、错误态不供 last-good、
  allowed_root 真实路径边界）；D05–D10 覆盖于
  `packages/server/test/member-directory-service.test.ts`（14 例，含真实临时文件
  原子替换/删除重建/同 mtime 用例）。
- [x] IM-08：身份映射、原生 @和同报告目录快照。
  channel-identity 能力改为按配置来源判定；新增 memberDirectoryChannelUsers/
  renderMemberDirectoryMention（opaque member key、scoped vcs_accounts 精确匹配层、
  按平台类型渲染）；bootstrap 三种 IM 频道接入文件目录（guess 默认关闭、author_mappings、
  手机号走有界 text 补充提醒、每份报告固定一个快照）；能力门禁与字段 inventory 翻绿。
  D11–D16 覆盖于 `packages/server/test/member-directory-publishing.test.ts` 与
  `packages/outputs/test/channel-identity.test.ts`。
- [x] IM-09：SQLite/PG IM store、原子操作和迁移。
  双后端 011_im_tables 迁移（7 张表：inbox/requests/active-targets/actions/
  conversations/reply-outbox/rate-limits，唯一键与索引齐备）+ im-store/im-store.pg
  五组原子操作（acceptDelivery 含 action 消费/限额/active-target 同事务、claimRequest
  CAS fence、prepareDispatch 序号、finishRequest 终态+释放+通知 outbox 同事务）+
  retention 与 listImActiveConfigSnapshotIds；R01–R06 覆盖于 im-store-conformance
  （SQLite + 真实 PG 一次性实例均通过；迁移锁竞争下 PG 套件按指南串行跑）。
- [ ] IM-10：三种回调协议、验签、解密和固定向量。
- [ ] IM-11：固定命令、会话发现、精确授权和持久接收。
- [ ] IM-12：HTTP callback 路由、时限与持久确认。
- [ ] IM-13：Git/P4/SVN 固定修订、范围与可信元数据。
- [ ] IM-14：请求 worker、队列交接、checkpoint 和重启恢复。
- [ ] IM-15：卡片动作发行、来源绑定和原子消费。
- [ ] IM-16：回复 outbox、临时凭证和结果状态。
- [ ] IM-17：配置切换、撤权、轮换、排空和 GC。
- [ ] IM-18：受控管理查询、页面和指标。
- [ ] IM-19：组合回归、真实本地后端与 crash 矩阵。
- [ ] IM-20：双语功能文档/示例/AI 同步和全部适用最终门禁。
- [ ] IM-21：真实平台受控验收；无账户时保留 pending_external。
- [ ] IM-22：归并稳定约定、归档证据，仅退役已完成计划。

## 待办与验收条件

以下是任务清单的阶段验收，不是第二套开发顺序；具体依赖以执行手册为准。
P0 对应 IM-00–03，P1 对应 04–05，P2 对应 06–08，P3/P4 对应 09–16，P5 对应 17–20，P6 对应 21–22。

- [ ] P0 配置与外部协议定稿。
  固定连接、输出目标、回调和命令授权模型，保留现有飞书配置；按已核查的官方样例建立加解密协议测试向量。
  明确普通应用单聊、应用群聊、API 模式机器人会话的能力边界。
  验收：schema、文件/数据库来源合并、凭据密封、管理表单和 generation 变更清单可逐项追踪。
- [ ] P1 企业微信应用发送。
  实现 token 缓存、应用收件人与 appchat 目标、文本/Markdown/可交互模板卡片、错误与部分送达分类。
  验收：真实 HTTP 请求形状、字节上限、限速、失效 token、部分收件人失败及远端结果未知均有测试；
  不以 HTTP 200 代替平台成功，不以内容去重承诺 exactly-once。
- [ ] P2 外部成员目录。
  按目录设计实现 YAML/JSON schema、平台身份隔离、明确映射、文件 watch 与定时校验、原子快照替换。
  验收：企业微信/飞书 webhook 实际 publisher 使用目录生成原生 @；错误目录不触发猜测或 @all；
  覆盖原地写入、原子替换、删除重建、漏事件、并发 reload、停机和新旧 generation。
- [ ] P3 回调接收、会话发现与安全边界。
  三类连接完成验证地址、验签解密、消息/事件归一化、持久收件箱和会话查询。
  验收：平台时限内确认，伪造/错租户/重放被拒绝；去重、重启、存储故障和多实例竞争有恢复测试；
  会话发现不自动授权仓库或修改输出路由。
- [ ] P4 指定 commit 的重新评审。
  实现固定命令语法、服务器生成的按钮动作、权限交集、仓库/修订解析、持久任务和状态反馈。
  验收：新请求可重新评审已完成 commit，同一投递/按钮动作只建一个请求；Git/P4/SVN 定义明确；
  不复用死批次 re-arm 作为新评审，不修改自动评审游标，不覆盖提交作者为点击者。
- [ ] P5 组合回归与文档同步。
  覆盖撤权、凭据轮换、配置切换、目录变化、请求恢复、发送回执丢失和临时回复过期。
  同步双语输出/触发/运维/字段说明、可运行示例、按需更新身份解析提示词与输出 skill。
  验收：完整运行时门禁、文档站门禁、适用的管理页面浏览器门禁以及新增存储迁移真实后端测试通过。
- [ ] P6 真实平台验收。
  使用单独授权的测试应用、测试群及合成提交，验证收件人、群内 @、会话 ID、消息/按钮重新评审和权限拒绝。
  验收记录分清平台/租户、权限、账户版本、调用量和清理结果；无凭据时明确未验收。
  完成后将稳定约定并入主题文档，证据归档里程碑，再精简本计划。

## 本轮文档验收

只运行仓库 Markdown 门禁、AI 入口/元数据/本地引用检查和 `git diff --check`。
功能测试、平台接入、安装依赖、启动服务、创建应用或发送消息均不属于本轮。
现有无关工作区修改保持原样。
