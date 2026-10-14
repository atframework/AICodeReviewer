# Slack、Discord、Telegram 执行步骤

状态：本地实现及适用门禁已通过，真实平台验收按 Plan 跟踪。保留原逐项步骤以约束剩余验收，
不以此文件单独授权平台注册或真实消息发送。
接口和默认值以[接入规范](slack-discord-telegram.md)为准，断言以[验收矩阵](slack-discord-telegram-acceptance.md)为准。
进度只在 [Plan.md](../../Plan.md)维护，避免多份完成清单失去同步。

## 执行方法

1. 每次只领取一个 SDC 任务；先读该任务指向的源码、现有测试、规范章节及官方来源编号。
   在开始前记录 HEAD、dirty tree 和前置任务证据；保留其他人修改。
2. 列出本次改动文件及要满足的验收 ID；先补能观察到缺口的测试，再实现。
   新接口名是实施目标，发现源码已变更时先记录差异，再用现有接口承接相同责任。
3. 运行该任务定向测试，检查真实发现的文件/用例数。用 raw HTTP 调用数、数据库状态和恢复后行为验收，
   不只测试 helper 返回值或复制实现逻辑。
4. 同步被本次行为改变的文档/示例；尚未支持的功能不得写入公开用户文档。
   每次交付运行[基线](../ai/AGENTS.repository-baseline.md)适用完整门禁；定向测试不替代最终门禁。
5. 更新 Plan 对应行的证据和剩余问题。失败、未跑、环境跳过必须分别记录；日志放 `build/logs/`，
   临时数据放 `build/tmp/`。不得以本地 HTTP 替身结果标记真实平台验收完成。

出现下列情况停止依赖该事实的实现，提交具体冲突和替代方案：官方协议与规范不符、不能证明目的地/操作人身份、
已有未完成 IM 前置条件仍失败、需要改动范围外的调度语义、门禁只发现零测试。普通私有函数命名无需再次确认。

## 依赖顺序

```text
SDC-00 基线与原 IM 缺口
  ├─ SDC-01 类型与配置
  │    └─ SDC-02 发布及 outbox 恢复
  │         ├─ SDC-03 Slack 输出
  │         ├─ SDC-04 Discord 输出
  │         └─ SDC-05 Telegram 输出
  └─ 原 IM-11/14/17 的相关验收通过
       └─ SDC-06 HTTP 接收与命令
            └─ SDC-07 配置管理和运行时联调
                 └─ SDC-08 故障与后端验收
                      └─ SDC-09 使用文档和运行样例
                           └─ SDC-10 完整门禁与真实平台验收
```

SDC-06 同时依赖 SDC-01–05；分支表示逻辑独立，不要求并行 Agent。
SDC-00 完成基线记录后即可开展 SDC-01–05；其中共享 IM 缺口的修复验收是 SDC-06 的启用门禁。
未完成前置任务时可继续独立的纯输出工作；不得提前对外启用 review 命令。

## SDC-00：建立可追溯基线与前置验收

输入：Plan 原 IM 未完成项；规范 §2；旧 `im-acceptance.md` 的 A08、R10–R13、X01、X03。

步骤：

1. 核对 `packages/server/src/im/command-service.ts`、`manual-review-service.ts`、`review-execution.ts`、
   `packages/server/src/bootstrap.ts` 中 snapshot、当前授权及 dispatch 的真实行为。
2. 用现有 `im-command-service.test.ts`、`im-review-runtime.test.ts`、`im-review-execution.test.ts` 和
   `im-store-conformance.ts` 重现 file-only 接收、撤权后的新 VCS/LLM/POST、重复 handoff、公平性问题。
3. 按原 IM 任务修复对应缺口；先完成 readiness/当前授权和同次 dispatchSeq 恢复，再运行新平台命令。
   不把旧 IM-13/19 的全量 VCS 验收合并成已完成；新增平台只复用已有可信 revision resolver。
4. 记录本次任务哪些依赖已通过，哪些仍阻止 SDC-06。保留已有飞书/企微用户确认的真实验收记录。

出口：C01、A04、R05；原任务有具体测试证据。本任务不得通过修改 Plan 文案代替修复。

## SDC-01：类型、schema 和能力注册

修改位置：

- core `im-contracts.ts`、`im-config.ts`、`config.ts`、`config-capabilities.ts`。
- core `config-components.ts`、`config-source.ts`、`config-publish.ts`、`config-preview.ts`、`config-compiler.ts`
  中对应连接引用、输出引用及归一化逻辑，按实际消费者选择修改，不全文件重构。
- core `config-secret-sealing.ts`、`config-secret-policy.ts`、`secret-scrubber.ts`。

步骤：

1. 增加三种 connection/output、三种 typed actor 和 channel conversation；保持旧 identity 序列化完全相同。
2. 按规范 §3 校验跨 kind 引用、ID、必填凭据、callback、输出目的地及四个命令。
   新平台允许精确 actor 或仅限已列群/频道的 conversation_users；拒绝目录 scope/any/wildcard 仓库授权、线程及旧 webhook 专属字段。
   作者提醒独立支持平台用户 ID 映射、匹配平台的 API 或文件目录，拒绝 all 兜底和跨平台身份范围。
3. 新 literal secret 进入 seal/mask/purpose policy；destination 绑定平台身份和目标。
   bot URL 路径和 interaction token 进入错误脱敏测试；public_key 不要误密封。
4. 扩展现有 config entity 双向映射和 rename/delete 引用检查；复用已有 collection，不新增 parallel config store。
   没有新增 optional 节点的旧配置 canonical hash 不变；有意改变 canonical 规则才走既有 resolver 迁移机制。
5. 为 capability 保存 disabled 草案、上线 readiness 留明确接口；禁止 bootstrap 私读 raw object 绕过 compiler。

测试位置：core `im-config.test.ts`、`im-contracts.test.ts`、`config-capabilities.test.ts`、
`config-compiler.test.ts`、`config-secret-policy.test.ts` 及同目录现有 sealing/scrubber 测试。
保留 `slack_bot` 未实现类型的拒绝测试；新增 `slack_app` 正向用例。
出口：C01–C05；读取/发布/导出/恢复均能解析新实体，旧配置 round-trip 不变。

## SDC-02：发送语义、journal 与通知持久化

修改位置：outputs `publication-journal.ts`、`index.ts` 中 FetchLike/结果出口；
store `im-store.ts`、`im-store.pg.ts`、`schema.ts`、`schema.pg.ts`、两种 migrations；
server `im/reply-service.ts` 和 review checkpoint/receipt 对接位置。

步骤：

1. 定义 delivered/rejected/unknown 的结果联合与平台 compact receipt；让发送层先校验业务响应，再确认 journal。
   对 Slack `ok:false`、Telegram `ok:false`、2xx 缺 message ID 建立回归测试。
2. 扩展三个 journal provider 的 unqueryable 发送与响应重建；确认恢复包含 dispatcher 所需字段。
   先写前日志，后 POST，后 receipt；落库失败立即停止后续远端写入。
3. outbox 增加版本化 payload_json，复用现有 lease/fence、nextAttemptAt、expiry 与 compactReceipt；
   明确 payload/receipt 不混用。追加 SQLite/PG migration，旧记录走已有 reader，不删除未发送通知。
4. 增加 claim→delivering→sending 的 fenced 操作及 unknown 终态；恢复时将到期 sending 保守标未知。
   新平台禁止 boolean 失败自动重发；既有平台旧记录行为回归覆盖，不能假定所有旧 boolean 错误可分类。
5. 扩展 acceptImDelivery 的可选通知输入，将 Telegram 接收/命令结果/通知原子写入；
   operation ID 由连接域+delivery kind/key+reply ordinal 的稳定摘要生成，终态通知用 requestId+terminal kind。
6. 发送前核查当前授权和持久目的地；落库 16 KiB 上限、24 小时期限、明确限流最多 5 次；通知失败不重跑审查。
7. status 返回请求阶段或终态；通知投递状态独立保存在 outbox。新终态文本只显示 ID/状态/查询命令，避免直接沿用 repoRef/revision 输出。

测试位置：outputs `publication-journal.test.ts`；store `im-store-conformance.ts`、`im-store.test.ts`、`im-store-pg.test.ts`；
server `im-replies.test.ts`、`im-review-execution.test.ts`。新增平台响应数据使用合成值。
出口：O04–O07、R01–R08；fresh journal/store/worker 恢复的实际 POST 次数满足断言。

## SDC-03：Slack client、渲染及输出接线

已实现于共享 `packages/outputs/src/social-im.ts`、`social-im-markdown.ts`；
修改 `im-markdown.ts`、`template-engine.ts` 的相关入口、outputs 导出及 server `bootstrap.ts`、`im/connections.ts`。

1. 读取 S1–S8，client 注入 fetch/clock/signal，主动发 chat.postMessage；验证 team/bot 及频道元数据 readiness，固定 origin 和 Bearer。
2. 复用 toSlackMarkdown，补 `**bold**`、代码、链接及不可信 Slack 控制语法处理；不能仅测试标题替换。
3. 每条总预算 3900 UTF-16 单元，包含截断提示与 target；复用已打包的 wecom-summary 内置摘要模板。
4. 按 generation 解析 token/缓存 client；接入实际 publisher resolver、空结果策略及缓冲刷新。
5. 429 遵守 Retry-After；业务错误、身份不符和未知发送按规范分类，不凭 HTTP 200 判成功。

出口：O01–O07、G01–G02；server `social-im-publishing.test.ts` 的 Slack 参数从配置生成 publisher 后检查 HTTP。

## SDC-04：Discord client、渲染及输出接线

共享 outputs `social-im.ts`、`social-im-markdown.ts`；修改与 SDC-03 相同的公共入口。

1. 读取 D1–D6；使用 API v10、Bot Authorization；后台核查 application 和频道 guild/type。
2. 新 toDiscordMarkdown，1900 UTF-16 总预算；始终显式 allowed_mentions，不创建 embed/components。
3. 发送/回执 ID 全部保留字符串，覆盖超过 JS safe integer 的 snowflake；校验回执 channel_id。
4. 按 bucket/major resource/global 429 信号调度，不把整个服务阻塞在一个 sleep 中。
5. 从真实配置 resolver 生成 publisher；不借 Gateway 或 Message Content intent 接收 slash command。

出口：O01–O07、G01–G02；server `social-im-publishing.test.ts` 的 Discord 参数覆盖实际 wiring。

## SDC-05：Telegram client、渲染及输出接线

共享 outputs `social-im.ts`、`social-im-markdown.ts`；修改公共导出/模板/bootstrap。

1. 读取 T1–T5；getMe readiness 取得并核对 bot_id，username 只用于定向命令；token 不从 URL 输出到日志。
2. 新 toTelegramMessage，text+白名单 entities；按最终 text 计算 UTF-16 范围，含截断后重算。
   text 总预算 3900，不开 parse_mode；正文不生成原生 mention，宿主可为解析出的作者追加 tg 用户链接实体并预留预算。
3. 验证 sendMessage 的业务响应、chat.id、message_id；迁移群、Bot blocked、无权限返回明确失败，不自动改目标。
4. 支持显式配置的 private/group/supergroup，拒绝 topic/channel/business 消息目标；更新 generation 缓存。
5. 接入 output resolver，覆盖负 chat ID、Unicode 和无安全 target link 的 P4/SVN 报告。

出口：O01–O07、G01–G02；server `social-im-publishing.test.ts` 的 Telegram 参数检查实际发送参数及错误脱敏。

## SDC-06：HTTP 协议与四个命令

三个验证函数位于 server `im/protocol-social.ts`，共用有界 raw body/严格 JSON 工具；
修改 `callback-routes.ts`、`command-service.ts`、`reply-service.ts`、`connections.ts` 及 server 路由/bootstrap。

1. 使用原始有界请求字节、真实密码算法和固定独立向量完成认证；新增协议测试文件，覆盖认证前无数据库/远端副作用。
2. 按规范 §4 映射原生命令到已有 parser；Discord 一个 command STRING option，Telegram 检查 entity 和 @username。
3. 扩展 typed channel 在授权、status、chat-id、持久 JSON 和 source reply 中的处理；移除新分支的“非 group 即 DM”假设。
4. 新平台接入共享持久 admission；检查 callback readiness、snapshot 和当前授权。
   旧 callback 预写 inbox 的模式不能让新 Telegram request/reply 事务分裂。
5. Slack/Discord 同步返回简短结果，Telegram 原子登记 reply 后 ACK。加入 1 秒内部预算，
   用阻塞 VCS/模型/发消息替身证明 callback 未等待它们；事务超时后不继续创建幽灵请求。
6. 复用原 ManualReviewService、revision resolver 和执行器；当前授权复查与原 snapshot 固定同时生效。
   不使用管理端 retry API 代替 IM request，不改自动提交去重/游标。
7. 生成 Slack manifest、Discord 单条 aicr command JSON、Telegram 注册参数样本；先以测试校验内容，不自动应用远端。

出口：S01–S09、A01–A06、R02–R06。新增 `im-slack-protocol.test.ts`、`im-discord-protocol.test.ts`、
`im-telegram-protocol.test.ts`，扩展 `im-callback-routes.test.ts`、`im-command-service.test.ts`、`im-combined.test.ts`。

## SDC-07：配置管理、热发布和旧平台回归

修改 core `config-ui-spec.ts`、`config-ui-runtime.ts`；server `config-api.ts`、dashboard 的相关表单/状态组件；
字段 inventory 的实际生成入口由 `config-ui-spec.test.ts` 定位。

1. 新 connection/output 字段按 kind 显示；public_key 可见，token/signing_secret/secret_token 密封遮罩。
2. 管理 UI 创建草案→预览→发布→查看实际 readiness→触发测试用回调→查询 request/reply 状态形成闭环。
3. 引用改名/删除、密钥轮换、应用身份变更、旧 generation 正在发布时新配置上线分别测试。
4. 无 callbacks 配置的新平台连接不得进入 ImLongConnectionService 的既有飞书/企微默认分支。
5. 回调路径保持 pathPrefix；平台认证入口可用，管理 API 仍需管理员认证。

出口：C02–C05、G01–G04、R06；core UI、server runtime-generation/runtime-http/config-e2e-publish-review 和 browser 均有证据。

## SDC-08：故障、重启与真实数据库

1. 对三个平台各执行响应丢失、receipt 落库失败、重启、过期 lease、同 key 不同 payload、429 和身份变更测试。
   用新实例读取同一数据库，禁止只调用同一对象两次冒充重启。
2. SQLite 使用两个连接竞争；PostgreSQL 使用独立连接/事务覆盖同一 conformance；若改 Redis-backed queue/config 引用，
   使用真实 Redis 验证 wake-up/config snapshot，不把 Redis 声称为 IM 请求表后端。
3. 分析已完成再恢复发布，断言 LLM 调用计数不增；已确认消息不重发；unknown 不重发；明确 429 才按 due time 重试。
4. 验证正常启动/preview 无远端注册副作用、shutdown 先停 admission/claim 再关闭 store。
5. 临时后端按[服务指南](../testing-services.md)启动、限额及清理，保留故障日志与独立清理检查。

出口：R01–R08、G03–G04；真实数据库项不能用 mock 或环境 skip 代替。

## SDC-09：最终使用文档与可运行样例

先按用户确认的仓库范围建立显式 workspace/trigger/alias 映射。
只接入既有配置中的仓库时，复用已有 workspace 和 trigger，不扩展组织仓库清单或 GitHub 安装权限。
用户要求接入组织全部仓库时，再分别查询组织仓库清单和 GitHub App 安装授权。
旧路由使用 `match.repo_ref` 精确规则，在原有宽泛规则之前保留原有渠道并追加 Bot 输出。
验证 `config-compiler.test.ts` 的选路及 `social-im-publishing.test.ts` 的三平台真实 resolver 调用；
其他组织、相似仓库名、不同事件类型均不能发送到新目的地。配置与安装授权缺口单独记录，禁止推断授权已存在。

本步交付的是实现后可用的操作文档；当前[草案](../../example/slack-discord-telegram-design.md)不能直接加载。
公开内容按实际完成的平台同步双语，不能一次宣称未完成的平台已支持。

| 交付文件 | 必写内容 |
| --- | --- |
| `docs/site/src/content/docs/{zh-cn,en}/integrations/slack.md`（新增） | 创建单 workspace App、Bot scopes、安装及重新安装、加入频道、取得 ID、配置 token/signing secret、slash request URL、manifest、验证与排障 |
| 同目录 `discord.md`（新增） | 创建应用/Bot、guild install、最小频道权限、public key、Interactions URL/PING、单条命令注册、snowflake 字符串、无 Gateway 的边界 |
| 同目录 `telegram.md`（新增） | BotFather、用户先开始私聊/加入群、privacy mode 定向命令、取得精确 ID、HTTPS/secret header、setWebhook/getWebhookInfo、避免覆盖他人 webhook |
| 两语 `integrations/im-bots.md`、`configuration/outputs.md`、`reference/config-fields.md`、站点导航 | 三平台入口、支持范围、字段/枚举、文件配置仅输出与持久命令前提 |
| `example/slack-app.yaml`、`discord-bot.yaml`、`telegram-bot.yaml` 及 example README | 无真实凭据的输出配置与 disabled 批量授权草案；命令启用片段；显式授权策略/会话/repository/snapshot 部署前提 |
| `docs/output-channels.md`、IM 稳定规范、AI index/source map、输出 skill 的条件引用 | 发送/ACK/恢复/不支持能力的已实现规则；主评审 prompt 无需变化 |
| `docs/testing-services.md` | 三平台 live 环境变量、调用/时长预算、注册授权、测试数据及清理范围 |

每个平台的用户文档都应按以下顺序写实际操作：

1. 前提与支持范围；最小权限表及为何需要每项权限，不要求管理员权限替代精确权限。
2. 创建应用/安装/获取秘密和身份；区分 channel ID、actor ID、workspace/guild/Bot ID。
3. 仅输出配置及一条合成报告；展示 no_problems、截断、失败/unknown 的实际含义。
4. 增加持久配置和四命令 binding；设置 HTTPS 回调；平台注册作为显式操作执行。
5. help→chat-id→固定合成 commit review→status→终态，示例包含命令 ACK 和最终报告不同目的地。
6. 撤权、停用、token 轮换、回滚；状态未知时查询/人工确认，不建议删除数据库或盲目重发。
7. 401/403/429、ACK 超时、私有频道缺权限、Telegram privacy/group migration、Discord 15 分钟限制等排障。

新增 `packages/server/test/social-im-examples.test.ts`：读取实际 YAML 样例，合并最小完整 app config，
经 schema→compiler→bootstrap→HTTP 替身验证；Markdown 草案不加入现有可运行 YAML 扫描。
出口：D01–D04；每条文档命令/配置都能在样例或操作验收中定位证据。

## SDC-10：完整门禁与真实平台交付

1. 最终编辑后按仓库 baseline 顺序运行完整 runtime 门禁；此改动同时涉及 schema/UI/site，故 docs:check、
   docs:build 和 test:browser 都适用。记录发现数、通过/失败/跳过及 coverage，不降低阈值。
2. 使用专用测试 workspace/guild/Bot 和合成仓库，按 L01–L03 验收真实输出、认证回调、命令和终态。
   没有账户凭据则跳过并保持该平台 live 未完成；部分变量配置必须报错。
   Slack 在控制台关闭 Enable Socket Mode，或在已有 manifest 中设置 `settings.socket_mode_enabled: false`，
   再核对 `/aicr` 的 Request URL。生成工具未显式输出该开关；URL 字段隐藏时先检查 Socket Mode。
   模式切换涉及整应用，须核对已有事件/交互端点；客户端真实命令及 callback 记录才是投递证据。
3. 真实注册和测试发送须有明确授权，普通测试不加载私有 YAML 或扫描环境凭据；不得碰生产频道。
4. 文档/计划分别记录“本地实现完成”“真实平台验收完成”；任一平台未验收，不宣称三平台已全部接入。
5. 仅当所有任务及验收完成，将稳定约定合并到主题文档，保留必要的真实验收限制；更新导航后再退役执行清单，
   不删除原 Plan 中其他未完成 IM/RUN 任务。

本地实施包含 runtime、schema/UI、迁移、注册工具、示例和双语站点；完整 runtime、browser、
docs 门禁均适用。实际测试文件采用共用 `social-im*.test.ts` 参数化三平台，
不再按规划中的三个独立 client/protocol 文件重复实现。真实账户验收另行授权并记录。

## 验证命令与执行记录

从仓库根目录运行，Windows 使用 PowerShell 7+。先创建日志目录：

```powershell
New-Item -ItemType Directory -Force build/logs, build/tmp | Out-Null
```

现有配置/IM 入口的定向回归示例：

```powershell
node node_modules/vitest/vitest.mjs run packages/core/test/im-config.test.ts packages/core/test/im-contracts.test.ts packages/core/test/config-capabilities.test.ts
node node_modules/vitest/vitest.mjs run packages/outputs/test/publication-journal.test.ts packages/outputs/test/im-markdown.test.ts packages/outputs/test/multi-channel.test.ts
node node_modules/vitest/vitest.mjs run packages/server/test/im-callback-routes.test.ts packages/server/test/im-command-service.test.ts packages/server/test/im-replies.test.ts packages/server/test/im-review-execution.test.ts
node node_modules/vitest/vitest.mjs run packages/store/test/im-store.test.ts packages/store/test/im-store-pg.test.ts
```

平台参数化测试使用共享文件；追加路径见本节末尾实际文件清单，不要求按平台复制文件。
`packages/outputs/test/social-im.test.ts` 和 `packages/server/test/social-im-publishing.test.ts` 各参数化三个 kind。
验收脚本先检查路径存在，再运行；零发现不算通过。`AICR_PG_TEST_URL` 缺失时的 PG skip 不满足 R01–R03。
Redis 变量及受控服务启动命令从 baseline/服务指南读取，不能用生产 endpoint 凑门禁。

实施阶段最终门禁，按顺序逐条运行；每条检查退出码，失败先处理，不能用后一个命令覆盖失败状态：

```powershell
node node_modules/eslint/bin/eslint.js . --max-warnings=0
node node_modules/typescript/bin/tsc -b tsconfig.json --pretty false
node node_modules/vitest/vitest.mjs run --coverage
node node_modules/markdownlint-cli2/markdownlint-cli2-bin.mjs
cmd /c "pnpm build"
node packages/cli/dist/index.js eval --validate-only
cmd /c "pnpm test:browser"
cmd /c "pnpm docs:check"
cmd /c "pnpm docs:build"
git diff --check
```

docs:check/build 顺序执行，避免共享 Astro 产物竞争；browser 在 build 后执行。
后端迁移相关全量测试须注入专用 PG/必要 Redis 环境，live 平台测试另行执行，防止全量 coverage 重复通知。
每次实际运行记录命令、环境层次、exit code、发现数、pass/fail/skip 和 `build/logs/` 日志路径。
本地 eval 是离线样本校验，不是模型质量或真实平台验收。

## SDC-13：Slack Socket Mode

1. 核对 S12/S13 与固定 SDK：hello App ID、slash envelope、三秒 ACK、应用级切换、dispatcher 代理和重连生命周期。
2. core 增加 socket_mode 严格字段、HTTP 互斥、同应用接收归属和 app_token 加密/遮蔽；配置 UI 和元数据同步。
3. server 使用独立 Socket 接收器，先验证 app/team，再复用共同持久接收流程；不得伪造 HTTP 签名、复制审查队列或打印 SDK 原始日志。
4. 测试真实 SDK 回环握手/ACK、错 app/team、授权、去重、冷 readiness、一秒超时、配置轮换和停止重连；运行完整适用门禁。
5. 注册工具增加 --slack-mode socket 并显式生成应用开关；交付双语设置/排障/回切文档和可加载示例。
6. 部署前从本地 yq 捕获 App-Level Token，只上传私密临时文件；备份实际运行源、配置、env、DB 和镜像。候选镜像使用新配置/新 env 离线验证后再切换。
7. 单实例上线，核验真实 hello/代理、三平台 readiness、重启重连和跨缓存刷新周期；用户在配置频道验证 help/chat-id。
8. 保留 HTTP URL/signing secret；回滚时恢复匹配源/config/env 并核对 Slack 控制台开关。连接状态不替代真实命令或模型/报告验收。
