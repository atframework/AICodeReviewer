# Slack、Discord、Telegram 验收矩阵

状态：本地实现、参数化测试和适用完整门禁通过；真实账户 L01–L03 未执行。
规范见[接入规范](slack-discord-telegram.md)，任务见[执行步骤](slack-discord-telegram-execution.md)。
表中测试位置相对相应 package 的 `test/`；平台专属协议和发送用例合并到共享 `social-im-*` 文件。
沿用原 IM 验收作为共享前置，不用同名新编号覆盖原文件中的证据。

## 2026-10-12 实现与证据定位

| 对应断言 | 实现入口 | 本轮实际测试与边界 |
| --- | --- | --- |
| C01–C03 | core `im-config.ts`、`config.ts`、`config-capabilities.ts`；server `social-callback.ts` | `social-im-config.test.ts`、`social-im-callbacks.test.ts`；三 kind、精确范围、file-only 拒绝、disabled 草案；metadata 反例在 outputs `social-im.test.ts` |
| C04–C05、G02 | core `config-secret-*`、`config-ui-spec.ts`、`config-components.ts` | config-publish/secret-policy/sealing/UI 测试；`social-im-authorization.test.ts` 的三平台轮换/撤权；browser `config-ui.spec.ts` 新表单流程 |
| S01–S07、A01–A02 | server `protocol-social.ts`、`social-command-service.ts`、共享 parser | `social-im-protocol.test.ts` 固定 HMAC/Ed25519 向量、UTF-8/重复键/数字身份；`social-im-callbacks.test.ts` 三平台认证、去重、越限与空 body 取消；授权测试验证 status 同 actor 范围 |
| S08 | `social-callback.ts`；store `acceptImDelivery` 的 deadline/事务 | 独立 SQLite writer 锁与 PG ACCESS EXCLUSIVE 锁均验证 admission 小于 1 秒、零 inbox/request；PG 独立连接用例见 `im-store-pg.test.ts`。stalled stream 1 秒取消，wall-time 断言允许 500ms 调度误差；不将合成 callback 计为公网期限证据 |
| A03、R01–R03 | SQLite/PG append-only 013；`im-store*.ts`；`reply-service.ts` | `im-store-conformance.ts` 由 `im-store.test.ts` 和真实 `im-store-pg.test.ts` 执行：通知工厂故障整笔回滚、duplicate 一次回复、超限 payload、owner/fence、sending 租约后零重领；PG 独立连接并发接收 |
| A04、R05–R06 | `currentImRequestAuthorized`；manual worker；executor/journal `beforeWrite` | worker 测试验证撤权零 VCS、queued ID 在 fresh worker 复用、窗口等待零尝试、暂时 IO 退避；两后端 conformance 验证忙 workspace 排除；executor 三平台断言分析前及 durable intent 后撤权零新 POST。原 IM 多进程组合矩阵继续保留 |
| A06、O01–O02、G01 | bootstrap publisher/resolver；`social-im-markdown.ts`；wecom-summary 内置模板 | `social-im-publishing.test.ts` 三平台实际配置、summary/line-only/named template、一条聚合消息、重复 flush；`social-im-examples.test.ts` 实际 YAML→compiler→resolver→HTTP；源回复只含 ID/状态 |
| O03–O07、R08 | outputs `social-im.ts`、formatter、publication journal | `social-im.test.ts` 三平台身份/type/TTL/429/业务失败/错目标回执，fresh journal 的 confirmed/unknown/rejected 零重复 POST；旧 journal/checkpoint/multi-channel 测试补充超限与部分成功。普通非持久路径没有跨重启 exactly-once 保证 |
| R03、R06–R07 | `reply-service.ts`、版本化 payload/current auth/sending CAS | `social-im-replies.test.ts` 三平台只持久有限回执、fresh worker 响应丢失不重发、撤权无远端请求；Telegram 429 due 跨 worker 恢复；sending crash 不重发 |
| G03、D01–D03 | 注册工具、双语指南、侧栏、字段参考、三份 YAML | `social-im-registration.test.ts` 默认离线 dry-run、Discord 单条 PATCH 保留其他命令、Telegram webhook 所有权冲突零写入；启动没有注册调用；六篇指南及样例由配置示例/文档门禁检查 |
| G04、D04 | repository baseline；专用 loopback PG/Redis/OOM | 完整覆盖率最终发现 239 文件、5139 用例；5107 通过、32 环境跳过；真实存储与服务清理见下方门禁记录 |
| L01–L03 | 专用真实平台账户与公开 HTTPS callback | 未执行；没有平台注册、真实通知或真实 LLM 验收证据 |

上述行定位本轮覆盖的断言与限制，不把同一编号内所有未列出的 crash/跨进程组合自动标完成。
原 IM 的完整范围目录、P4 depot/SVN 作者和多进程组合仍见 [Plan.md](../../Plan.md)。

## 最终门禁记录

2026-10-12，以下命令退出码均为 0。日志是本次工作区的本地证据，位于忽略的 `build/logs/`。

| 门禁 | 实际结果 | 最终日志（相对 `build/logs/`） |
| --- | --- | --- |
| `node node_modules/eslint/bin/eslint.js . --max-warnings=0` | 无 lint 错误或警告 | `social-im-lint-last.log` |
| `node node_modules/typescript/bin/tsc -b tsconfig.json --pretty false` | 全部项目通过 | `social-im-typecheck-final.log` |
| `node node_modules/vitest/vitest.mjs run --coverage --maxWorkers=1` | 239 文件：225 通过、14 跳过；5139 用例：5107 通过、32 跳过 | `social-im-coverage-last.log` |
| 覆盖率阈值 | statements 88.27%、branches 80.72%、functions 90.27%、lines 90.32%；全部适用阈值通过 | `social-im-coverage-last.log` |
| Repository Markdown | 166 文件，0 issues | `social-im-markdown-last.log` |
| `pnpm build` | 11 个 runtime package 构建通过 | `social-im-build-final.log` |
| `node packages/cli/dist/index.js eval --validate-only` | 6 个离线 fixture 通过；无真实模型调用 | `social-im-eval-final.log` |
| `pnpm test:browser` | 44 用例通过，含新三平台表单与秘密保存流程 | `social-im-browser-final.log` |
| `pnpm docs:check` | 827 schema 路径、11 enum 行、29 双语页面对及内部链接校验通过；Astro 16 文件：0 errors、0 warnings、10 hints | `social-im-docs-check-verified.log` |
| `pnpm docs:build` | 60 页面及搜索索引构建通过 | `social-im-docs-build-final.log` |
| `git diff --check` | 无 whitespace 错误 | `social-im-diff-check-last.log` |

完整测试显式注入本次拥有的 PostgreSQL、Redis、独立 Redis OOM 端点，PG migration/conformance、
Redis 故障注入未因端点缺失跳过。其余环境条件跳过不计为通过，真实平台 L01–L03 未运行。
服务清理见 `social-im-services-cleanup.log`；独立检查确认三个监听端口及专用 fixture 数据均已移除。

首轮失败保留在 `social-im-coverage-final.log`：指南配置片段缺少连接域字段、
generic auth 遮罩抢先分类 JWT，均已修复。后续 `social-im-coverage-pass.log` 的历史 SQLite
迁移进程用例超时，检查资源并保留日志后，未改断言或时限的定向检查和完整重跑通过，
不据此推断超时的唯一成因。文档字段校验补上 discriminated union 遍历并补齐双方参考；未放宽门禁。

## 证据填写方式

每个 ID 最终记录：实现符号、测试文件与用例名、命令/日期、实际发现及通过数量、日志路径、未覆盖边界。
每个平台各有的用例必须参数化执行三个 kind，不能只测一个平台后把整行标完成。
状态使用“待实施/本地通过/真实服务通过/真实平台通过/失败/环境跳过”。
HTTP 替身、独立 SQLite/PG 连接、公网回调、平台客户端显示是不同证据层次。

## 配置 C01–C05

| ID | 输入/故障 | 必须观察到的结果 | 测试位置 |
| --- | --- | --- | --- |
| C01 | 旧 config 无 im、新 connection、file-only 启用 review | 旧 canonical/hash 不变；新增配置贯通；file-only 输出可用但 review 拒绝且无 request/VCS/LLM | core im-config/config-compiler；server im-callback-routes |
| C02 | 错 connection kind、混合内联 token、缺凭据、literal/env 同时设、非法 key/ID | 预览/发布明确拒绝；disabled 草案策略一致；无意外网络 | core im-config/config-capabilities；server config API |
| C03 | scope/any/allow_all_repositories、未知命令、DM/线程/topic、原生 mention/目录字段 | 不支持的字段/会话结构在配置期拒绝；ID 对应真实类型由 readiness 拒绝，不能按前缀猜测；旧平台能力保持 | core im-config/config-capabilities；server connection readiness |
| C04 | connection rename/delete、secret 轮换、app/team/guild/Bot 改变 | 引用完整或拒绝；同身份轮换 dedup 稳定，不同身份分域；旧通知不转到同名新连接 | core config-source/config-publish；server runtime-generation |
| C05 | 管理 UI/API export/preview/audit、异常错误含 token/response_url/bot URL | 所有 secret 遮罩；public_key 保留；用途授权不能将 secret 发往不同身份/目标 | core secret policy/sealing/scrubber；server API/UI/browser |

## 协议 S01–S09

| ID | 输入/故障 | 必须观察到的结果 | 测试位置 |
| --- | --- | --- | --- |
| S01 | Slack 独立 HMAC 向量；form 空格/%2B/+、字段顺序和 raw bytes 篡改 | 正确请求通过；篡改失败；不以重编码 form 验签；认证前零 store/VCS/POST | im-slack-protocol |
| S02 | Slack 缺/重复关键字段、错 app/team、时间窗 ±300 秒边界 | 拒绝范围明确；完全相同请求重投返回原 request；同 delivery key 不同 digest 冲突 | im-slack-protocol；im-callback-routes |
| S03 | Discord 独立 Ed25519 向量、合法/非法签名 PING、错 app/guild、重复身份字段 | PING 验签后 type=1；错签 401；不创建 request；用户身份来自 member.user | im-discord-protocol |
| S04 | Discord option 类型错/多余参数、interaction 重投、超 safe integer snowflake | 拒绝非法 command；相同 ID 一次接收；所有 ID 原样保留 | im-discord-protocol；im-command-service |
| S05 | Telegram 正确/缺/错误 secret header、safe/unsafe 数字 ID、负 chat ID | 只有正确连接 secret 通过；ID 无精度损失；没有 timestamp 的合法更新可处理 | im-telegram-protocol |
| S06 | Telegram 私聊/群定向命令、指向其他 Bot、匿名 sender_chat、机器人、编辑/频道/topic | 支持输入可执行；其余不触发 review；不把 username 当授权 actor | im-telegram-protocol；im-callback-routes |
| S07 | chunked body、伪 Content-Length、超 256 KiB、非法 UTF-8/JSON/form | 有界读取并拒绝；不存 raw body；错误脱敏；无副作用 | im-callback-routes；runtime-http |
| S08 | 慢 VCS/LLM/send/readiness、DB 阻塞/提交结果未知、用户重复命令 | handler 不等待远端；本地 1 秒预算、Slack/Discord 3 秒期限分别测量；失败无虚假 accepted，结果未知按 key 恢复 | im-callback-routes；im-combined |
| S09 | pathPrefix、管理员未登录/已登录、未知/禁用 callback、未知合法事件 | 平台路由只受平台认证；管理 API 未放开；未知事件不引发任务循环 | runtime-http；im-callback-routes |

签名测试须有固定密钥/消息/期望签名三者的独立来源，不能只用待测函数签名再验签。
期限测试用可控时钟及真实 handler wall-time 两层证据；不得把超时阈值调大来通过。

## 授权及行为 A01–A06

| ID | 输入/故障 | 必须观察到的结果 | 测试位置 |
| --- | --- | --- | --- |
| A01 | 四命令、额外参数、换行/shell/revspec/URL/路径、其他平台语法 | 映射到固定 parser；只有显式 alias+固定 revision 可 review；无 shell 或自然语言解释 | im-command-service；三协议测试 |
| A02 | 同字面 actor 跨应用/租户、未知会话/仓库、同 request ID 跨人/跨会话 status | 精确交集授权；拒绝不泄露仓库/任务；私聊不会被错误映射成群/channel | im-command-service；im-combined |
| A03 | 同一 delivery、多连接竞争、同目标不同 alias、新消息在旧请求终态后到达 | 一个 inbox/活动 request/run；新明确命令在终态后可新建；重复不多扣额/发 reply | im-store-conformance；im-combined |
| A04 | 接收后撤权/禁用/改仓库映射，在 validating/analysis/publishing 前分别恢复 | 当前策略阻止新 VCS/LLM/POST，记录拒绝；原配置仍固定用于执行，不替换成 current head | im-review-runtime；im-review-execution |
| A05 | IM 操作人与 Git/P4/SVN 作者不同、已有自动提交任务 | author 来自 VCS，requestedBy 独立；自动游标/去重不变，原 VCS 范围测试继续通过 | im-revision-resolver；im-combined |
| A06 | 命令来自 A 会话、报告配置为 B，含敏感 repo/报告信息 | A 只收 ID/状态/查询说明；报告只发 B；help/chat-id/status 也须授权 | social-im-publishing；im-replies |

## 输出 O01–O07

| ID | 输入/故障 | 必须观察到的结果 | 测试位置 |
| --- | --- | --- | --- |
| O01 | 三平台从真实配置生成 publisher，PR/commit/P4/SVN | 正确 host/auth/body/目标；无 VCS URL 则文本标签，不生成假链接；summary-only/line-only/重复 flush 次数正确 | 三个平台 publishing 测试；multi-channel |
| O02 | named/workspace/builtin 模板，空结果各层覆盖、错误与混合渠道 | 模板选择、no_problems 和 error bypass 与原规则一致；一个渠道被抑制不阻止其他渠道 | template-engine；multi-channel；bootstrap |
| O03 | 中文/emoji/组合符/代码/链接/恶意 mention，预算 N−1/N/N+1 | 不切断代理对/实体/代码结构；提示及链接算入预算；不会 @all/@everyone/任意用户 | im-markdown；im-report-limits；新 dispatcher 测试 |
| O04 | Slack/Telegram HTTP 200 业务 false、Discord 非 2xx、缺/错 receipt | 只有完整成功可 delivered/confirmed；明确业务失败 rejected；缺回执 unknown | 新 clients；publication-journal |
| O05 | 429/header/body retry、5xx、丢响应/连接断开、abort | 429 到期前零重发；时间单位正确；未知 POST 不重发；abort 后无后续 POST | 新 clients；im-replies；journal |
| O06 | fresh journal 恢复三平台已确认消息；失败保存 checkpoint、超过 1 MiB | 零重复 POST；重建响应含所需字段；保存失败/超限时零后续写入，保留最后 durable checkpoint | publication-journal；im-review-execution |
| O07 | changed request/destination、Discord nonce 过数分钟、群迁移 | 未知状态不以 nonce/配置变化自动重新发送；不更换目的地；明确记录失败或 unknown | publication-journal；im-replies |

## 持久化及恢复 R01–R08

| ID | 故障点 | 必须观察到的结果 | 证据层次 |
| --- | --- | --- | --- |
| R01 | 旧 DB 升级、新 DB、verify、旧 outbox JSON、非法/超 16 KiB 新 payload | SQLite/PG 一致；append-only migrations；旧记录可读；非法新数据 fail closed | 两后端真实 store |
| R02 | Telegram inbox/request/reply 事务中途失败、commit 后 ACK 前退出 | 全回滚或完整提交；重投返回原 ID、只一条 command reply；配额不多扣 | 两后端独立连接 |
| R03 | 两 worker 竞争、delivering 到期、sending 后进程退出/回执丢失 | delivering 仅发送前可重领；sending 到期 unknown；旧 fence 无效，remote POST 不重复 | fresh worker/store |
| R04 | finishRequest/终态通知/receipt 持久化各阶段 crash | 终态与 outbox 一致；通知失败不重跑 review、不重复 run/用量；状态区分分析/发布/通知 | im-store + im-replies + executor |
| R05 | enqueue 前后退出、busy workspace、执行窗口、retry_wait、原 snapshot GC | 同次 handoff ID 稳定；公平性/许可/次数满足原 IM R10–R13；活动 snapshot 不被删除 | 原 IM 前置验收+新平台链路 |
| R06 | 新旧 generation、凭据轮换、同名身份替换、撤权 | 旧请求内容固定；新安全策略生效；不把通知发到新应用/频道，不使用过期授权缓存 | runtime-generation；真实 store |
| R07 | 限流超过通知期限、unknown retention、shutdown 有在途 POST | due/expiry 持久；不提前重试；unknown 不删后重建；停机留可恢复/未知状态 | im-replies；bootstrap |
| R08 | 无持久 journal 的普通路径、已分析请求恢复、三个渠道部分成功 | 普通路径不宣称跨重启 exactly-once；持久路径不重复 LLM；保留每渠道真实结果 | executor；multi-channel |

## 管理、文档与门禁

| ID | 验收标准 | 证据位置 |
| --- | --- | --- |
| G01 | 静态配置和数据库配置的实际出站请求相同，预览/发布无 raw-object 捷径；readiness 预热、300 秒到期、失败和跨 generation 不串缓存 | config-e2e-publish-review；runtime-generation；平台 publishing 测试 |
| G02 | 管理表单按 kind 展示字段，禁用草案、发布校验、秘密遮罩、readiness 正确 | core config-ui 系列；Playwright browser |
| G03 | 新平台不误启动旧长连接；preview/bootstrap 不调用命令注册/setWebhook | im-long-connection-service；bootstrap |
| G04 | SQLite/PG 对等及必要 Redis 路径真实测试；临时服务结束清理已独立检查 | store conformance；服务日志 |
| D01 | 两语言三篇指南、聚合页/字段参考/导航一致，所有命令与权限有来源 | docs:check；docs:build；人工对照 |
| D02 | 三个实际 YAML 样例经 schema/compiler/bootstrap 后发出正确 HTTP；无真实 secret | social-im-examples.test.ts |
| D03 | 指南覆盖仅输出、命令、状态、超长/unknown、撤权/轮换/回滚；不宣传未实现能力 | 对照规范及 live 记录 |
| D04 | 全套 baseline、browser、docs:check/build、Markdown/reference/diff 门禁通过且记录发现数 | 最终验收日志 |

## 真实平台 L01–L03

| ID | 专用环境及显式变量（拟新增） | 必做流程 |
| --- | --- | --- |
| L01 | Slack：`AICR_SLACK_TEST_TOKEN`、`APP_ID`、`TEAM_ID`、`BOT_USER_ID`、`CHANNEL_ID`、`ACTOR_ID`、`SIGNING_SECRET`、`CALLBACK_BASE_URL`，除首项外均加相同 `AICR_SLACK_TEST_` 前缀 | 安装/scopes/频道身份→合成报告显示和无意外提醒→真实 slash help/chat-id/review/status→长任务终态；错 actor/频道拒绝；撤权和 429 的本地注入结果另列 |
| L02 | Discord：`AICR_DISCORD_TEST_TOKEN` 及同前缀 `APPLICATION_ID`、`GUILD_ID`、`CHANNEL_ID`、`ACTOR_ID`、`PUBLIC_KEY`、`CALLBACK_BASE_URL` | 正确/无效签名 PING→指定 guild 的 aicr 注册→报告显示→真实四命令→超过 interaction token 期限的终态仍通过 Bot API 送达 |
| L03 | Telegram：`AICR_TELEGRAM_TEST_TOKEN` 及同前缀 `BOT_ID`、`CHAT_ID`、`ACTOR_ID`、`WEBHOOK_SECRET`、`CALLBACK_BASE_URL` | getMe/getWebhookInfo→经授权注册→私聊及群定向命令→报告/状态→停用/错误 secret→群迁移或 blocked 的失败状态；无自动改目标 |

上述变量是验收工具设计，当前仓库未实现该入口。全缺默认 skip，部分配置 fail；只有显式 live 开关才解析秘密和发送。
三平台分别选择测试身份，禁止复用生产目的地。每次平台验收最多 10 次消息写入、20 次只读 API、20 分钟，
超预算停止并保留未完成；超过 15 分钟用受控 worker 等待验证，不以真实付费模型拖长任务。
真实回调由平台客户端触发；用本地私钥/已知 signing secret 合成请求不能算真实平台发送证据。
注册工具默认 dry-run，仅显式 apply 时写平台；Discord 不覆盖其他命令，Telegram 不默认丢 pending updates。
只清理本次创建的合成消息/命令/临时 webhook，恢复原 webhook 前核实仍归本次操作所有；已有资源保持。
若额度或凭据不足，拆成有独立预算的后续验收，不在同次执行中静默提高限制。
