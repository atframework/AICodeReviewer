# Slack、Discord、Telegram 接入规范

状态：2026-10-12 已接入本地 Bot API 输出和 HTTP 四命令；真实平台验收独立保留。
当前接口以源码为准，实际测试与剩余验收见矩阵；此前规划所列 baseline 不代表现状。
源码基线 `d7994eb`，开始调研时工作树干净。后续实施须重新核对源码，不能把本文的拟新增接口视作已有 API。
入口见 [Plan.md](../../Plan.md)，任务顺序见[执行步骤](slack-discord-telegram-execution.md)，
测试断言见[验收矩阵](slack-discord-telegram-acceptance.md)，外部事实见[官方来源](../ai/sources/slack-discord-telegram.md)。

## 1. 交付范围与固定选择

| 项目 | 本次选择与理由 |
| --- | --- |
| 输出类型 | 新增 `slack_app`、`discord_bot`、`telegram_bot`；统一引用 `im.connections`，主动 Bot API 可处理长任务终态 |
| 接收方式 | 复用 `/callbacks/im/:connection` 的 HTTP 入口；新平台不启用长连接、Gateway 或 polling |
| 命令 | `help`、`chat-id`、`review <alias> <revision>`、`status <request-id>`；新平台 capability 显式拒绝其他命令，既有平台命令不变 |
| 执行 | 复用命令授权、持久请求、ReviewQueue、ManualReviewService、VCS resolver 与编排器；不新增聊天 Agent 或另一个任务队列 |
| 授权 | 精确 typed actor + 精确会话 + 显式仓库别名；新连接不支持 any、目录 scope、allow_all_repositories |
| 报告目的地 | 仅 workspace 既有输出路由；命令所在会话只接收请求编号和状态，不自动收到完整报告 |
| 单应用范围 | Slack 一个应用/一个 workspace；Discord 一个应用/一个 guild；Telegram 一个 Bot/一个 webhook。相同应用不能启用多个相互覆盖的 callback connection |
| 会话范围 | Slack workspace 频道；Discord guild 普通文本频道；Telegram 已建立的私聊及 group/supergroup。线程、forum topic、频道广播、Slack/Discord DM 不在首期 |
| 报告长度 | 每次汇总每渠道一条受限消息；超长明确截断并保留可用详情链接，沿用已有 IM 截断思路；不新增附件/多片自动发送 |
| 作者提醒 | 首期只显示作者文本；新渠道拒绝 `mention_author: true`、`mention_fallback: all`、member_directory/author_mappings/guess_author，避免配置接受却无消费者 |
| 按钮等扩展 | 不实施重新评审按钮、模态框、普通聊天监听、用户目录同步、公开 OAuth 分发、跨频道动态报告路由 |

会话范围和作者提醒是本计划的收敛选择，非平台能力限制。扩大任一项时先补对应规范和验收，
不借现有字段 passthrough 静默启用。HTTP 方案要求可被平台访问的 HTTPS 地址；无公网入口的部署
可先仅启用输出，不能声称命令入口可用。

## 2. 实施前 baseline 与前置约束

下表记录规划提交 `6112f05` 的起点。当前共用实现为 outputs `social-im.ts`、
`social-im-markdown.ts`，server `im/protocol-social.ts`、`social-callback.ts`、
`social-command-service.ts`、`social-identity.ts`；职责和验收沿用本规范，没有增加 SDK/Gateway/polling。

| 位置 | 当前证据 | 实施约束 |
| --- | --- | --- |
| core `im-config.ts` / `im-contracts.ts` | 连接只有 wecom_app/wecom_aibot/feishu_app；actor 和 conversation 是严格类型 | 增加联合类型和校验，不把新平台冒充飞书或企微 |
| core `config.ts` / `config-capabilities.ts` | 输出 capability 无三平台；`slack_bot` 是未知类型拒绝测试样本 | 本计划用 slack_app；保留未知类型拒绝测试，不能只放宽 kind |
| outputs `im-markdown.ts` | 已有 `toSlackMarkdown`，尚未接 publisher；测试文件未覆盖该函数 | 复用并补安全/格式测试；无需重复写一个 Slack transformer |
| server `im/callback-routes.ts` | 读取限 256 KiB，现有协议分支内接收/响应；部分回复直接发远端 | 新分支须独立 fast ACK；不能在 3 秒内等待 VCS、LLM、发消息或平台身份查询 |
| server `im/command-service.ts` | 可持久接收命令，但原计划仍列 file-only/readiness 缺口 | review 必须取得真实持久 snapshot，不能保存 `file-only` 代替 |
| server `bootstrap.ts` / `im/manual-review-service.ts` | worker 已接队列和编排器；仍有原计划的当前授权、交接恢复、公平性缺口 | 命令交付以前完成相关 IM-11/14/17 验收；保留原任务 ID |
| server `im/reply-service.ts` | send 返回 boolean；失败/异常进入重试；连接主要按当前名称查找 | 新 API 需区分拒绝与 unknown，并比对持久平台身份，不能照搬 boolean 重试 |
| outputs `publication-journal.ts` | 已有 unknown/confirmed/rejected、unqueryable 策略；receipt 压缩及重建针对现有平台 | 新平台业务成功、嵌套回执、恢复重建必须增加专用处理 |
| store `im-store.ts` / `.pg.ts` | inbox、请求、outbox 和 lease/fence 已有 | 扩展已有事务接口；SQLite/PG 同语义；不建立平行数据库 |

既有任务还有 VCS 家族/范围和真实重启验收，详见 [Plan.md](../../Plan.md)。本任务不将其自动标为完成。

## 3. 配置与身份

### 3.1 连接和输出

以下字段已实现。可加载示例见 [Slack](../../example/slack-app.yaml)、
[Discord](../../example/discord-bot.yaml)、[Telegram](../../example/telegram-bot.yaml)。
`im` 仍 optional，旧配置解析结果不注入新默认节点。

| kind | 连接字段 | callback 字段（启用时要求） | output 字段 |
| --- | --- | --- | --- |
| slack_app | app_id、team_id、bot_user_id；token/token_env 二选一 | enabled；signing_secret/signing_secret_env 二选一 | connection；channel_id |
| discord_bot | application_id、guild_id；token/token_env 二选一 | enabled；public_key（32-byte Ed25519 公钥的 64 位 hex） | connection；channel_id |
| telegram_bot | bot_id；token/token_env 二选一 | enabled；secret_token/secret_token_env 二选一 | connection；chat_id |

- enabled 缺省沿用 connection=true、callback=false、binding=false。disabled 草案允许保存；启用时凭据必须可解析。
- 所有平台 ID 在配置/存储中用字符串。Discord snowflake 不能转为 JS number；Telegram chat_id 可为负十进制。
  Telegram JSON 数字先验证 safe integer 再规范化为十进制字符串；禁止科学计数、浮点和正号形式的配置 ID。
- 新 output 必须引用同 kind 的连接；不能混用内联 token、webhook_url、base_url、target 或线程字段。
  Slack/Discord channel_id 不接受显示名；Telegram 不接受 `@username`，避免改名/迁移绕过精确目的地。
- API origin 固定为 `https://slack.com/api`、`https://discord.com/api/v10`、`https://api.telegram.org`。
  注入 FetchLike 用于测试，不开放任意 base_url；禁止跨 origin redirect 带出 token。
- 复用已有 secret sealing 的 token；新增 signing_secret、secret_token 的密封、脱敏、互斥及 purpose policy。
  public_key 是公开验证材料，不作为 secret 密封。secret-policy destination 加入 team/guild/application/bot/channel 等身份。
- 现有 `im_connection`、`im_command_binding` 和 channel 数据库实体足够；不新增一套 config collection。
  引用 rename/delete、preview、field inventory、管理 API/UI 和 generation 都必须走现有配置链。

### 3.2 稳定身份与会话

复用 `ImConnectionIdentity`，扩大字段注释的语义，保留旧三平台的序列化结果和 hash：

| 平台 | platformId | tenantKey | actor type | conversation |
| --- | --- | --- | --- | --- |
| Slack | app_id | team_id | slack_user_id | 新 `{kind: channel, id: channel_id}` |
| Discord | application_id | guild_id | discord_user_id | 新 `{kind: channel, id: channel_id}` |
| Telegram | bot_id | undefined | telegram_user_id | 私聊沿用 bot_direct（验证 chat.id=from.id）；群沿用 group+id |

corpId 保持 undefined；namespace 继续参与隔离。凭据轮换不改变接收身份，应用或 workspace/guild 改变则分域。
连接重命名不能让旧通知发到同名的新应用。更新 conversation 匹配、chat-id/status、JSON serializer 和 outbox 校验；
不能把新增 channel 走进“非 group 则发给 actor”的旧默认分支。

发送 client 的 generation 缓存须含 secret 指纹；日志不输出该指纹。后台 readiness 核验 Slack auth.test
的 team/user 及 conversations.info 的 context_team_id、频道类型、成员身份和写入限制，Discord 当前应用及频道 guild/type、Telegram getMe 的
id/username 及 getChat 的目标类型。不能按 ID 前缀猜测会话类型。
元数据缓存有效期 300 秒（本地设计值），按 generation/身份/目的地隔离；失败或到期且未刷新则不 ready。
预热范围只含已配置的输出和 binding 会话；不自动发现其他频道。Slack 增加 channels:read，
使用私有频道时增加 groups:read；不申请历史或成员目录权限。
readiness 不在 callback 内请求网络，失败则新接收/发送返回明确不可用，不能改用其他连接。
单纯配置保存和预览不调用平台 API；绑定上线前必须通过 readiness。

### 3.3 接收与执行权限

新平台 binding 只允许精确 actor、上述精确 conversation、四个命令、显式 repositories，report_policy 固定 workspace_routes。
`review` 要求 SQLite/PG StoreDb、数据库 ConfigStore、非空 snapshot、worker ready 与所需 secret 可用。
输出发送本身仍可用于 file-only 配置。

接收、开始 VCS 校验、开始分析、每次新发布之前复查当前连接/绑定/actor/会话/仓库授权；
执行目标、模型和输出内容继续固定原 snapshot。当前授权撤销只阻止后续副作用，不把旧请求切到 current 配置重跑。
status 同时检查原请求 actor、连接身份、会话和仓库范围，不只比较随机 request ID。

## 4. 协议、命令与 ACK

| 平台 | 输入与规范化 | 认证/去重 | 响应 |
| --- | --- | --- | --- |
| Slack | `/aicr review demo <revision>`；command 必须 `/aicr`，text 交给已有固定 parser；form 解码只发生在验签后 | S1；校验 api_app_id/team_id；delivery key 使用已验证 timestamp+原始 body 的 SHA-256，只保证完全相同请求的重投；不要伪造 Events API event_id | 持久接收后 HTTP 200 ephemeral 文本，含 request ID；help/chat-id/status 在同一响应中返回 |
| Discord | Guild slash `/aicr command:review demo <revision>`；注册一个必填 STRING option `command`，禁止未知 option/类型 | D1；校验 application_id、guild_id、member.user.id；delivery key=interaction.id；PING 先验签再返回 type=1 | 命令 HTTP 200、type=4、flags=64、allowed_mentions.parse=[]；本期不 deferred，不保存 interaction token |
| Telegram | 私聊 `/aicr review ...`，群 `/aicr@BotUsername review ...`；检查首位 bot_command entity 及 bot username | T1 secret header 常量时间比较；delivery key=update_id；from.is_bot、sender_chat/匿名管理员、无 from、edited/channel/非文本消息不触发 review | inbox/request/command reply outbox 原子提交后 HTTP 200；worker 再调用 sendMessage，不能在 ACK body 内代发 |

协议适配器只认证和规范化；由共享服务做授权、接收和状态查询。
Slack form 重复敏感字段、Discord JSON 重复认证/身份关键字段及非法 UTF-8 必须拒绝，不能以重新序列化内容验签。
Telegram 无平台签名 timestamp，不能套用 Slack 5 分钟规则误拒合法延迟更新。
对所有协议的同 key 不同业务 digest 返回冲突，不创建第二个请求；不保存原始聊天全文/response_url/token。

内部 ACK 目标 1 秒，Slack/Discord 平台硬期限 3 秒（S2/D2）。实现须有可取消的接收预算：
超时后不能启动新的提交或副作用；若事务结果不确定，按 delivery key 查询恢复，不返回虚假 accepted。
验证失败 401；超限 413；存储不可用 503。已认证但未授权的命令可返回平台格式的通用拒绝，不能泄露仓库存在性。
已认证未知非命令事件 2xx 忽略；有效 Discord PING 不写 inbox/request。

不在 HTTP handler 等待 readiness、VCS、LLM 或终态消息发送。Slack/Discord 的四个命令只依赖有界本地状态查询。
Telegram command reply 必须与 inbox 同事务登记；重复投递不能重复登记 reply。
Slash command 是明确调用，不要求额外 @mention；不能照抄旧群消息前缀判断。

## 5. 输出与格式

在 outputs 增加三个 client/dispatcher，网络依赖采用仓库 FetchLike + clock + AbortSignal；不引入三个完整 Bot SDK。
复用 template-engine 和结构化 ReviewProblem。publishProblem 缓冲、publishSummary 一次汇总；
summary-only、line-comments-only、重复 summary 的发送次数沿用已有 publisher 约定。
新渠道内建 no_problems 为 publish_if_summary，继承全局/频道/workspace/instance 的既有优先级。
错误通知继续绕过正常空结果抑制；PR、commit、P4、SVN 的链接来自既有可信 target resolver。

| 平台 | 发送 API 与 receipt | 渲染方案及本地预算 |
| --- | --- | --- |
| Slack | chat.postMessage，Bearer token；`ok:true` 且 channel/ts 合法才确认 | 复用并修复 toSlackMarkdown；text 预算 3900 UTF-16 单元；parse=none、link_names 不启用，unfurl_links/media=false；主动转义不可信控制 markup |
| Discord | POST /channels/{id}/messages，Bot token；2xx+合法 message.id/channel_id 才确认 | 新 toDiscordMarkdown；content 预算 1900 UTF-16 单元；allowed_mentions={parse:[],replied_user:false}，不加 embed/components |
| Telegram | POST /bot{token}/sendMessage；`ok:true`+result.message_id/chat.id 才确认 | 新 toTelegramMessage 返回 text+受控 entities，省略 parse_mode；预算 3900 UTF-16 单元；entity offset/length 从最终 text 计算，禁用 link preview |

这些数字是含标题、链接、截断提示的本地保守总预算，非三个平台共同的官方计数规则。
测试须覆盖中英文、代理对、组合字符、URL/代码块边界，不能切断 Unicode、entity 或平台链接。
超限按“目标、摘要、问题”结构保留可容纳内容，附“内容已截断”及已知安全链接；无链接时只说明截断，禁止编造详情地址。
作者、路径、提交正文、模型文本及自定义模板全部是不可信消息内容；禁止把 `<@...>`、`<!channel>`、
`@everyone` 或 Telegram mention entity 从正文自动升级为通知。
Telegram transformer 将通用 Markdown 转成普通 text 与加粗/代码/安全 URL 等白名单实体；不直接把 Markdown 当 HTML/MarkdownV2。

输出层可使用已有 summaryIssueUrl，但本期不扩展飞书专属 issue_link_card 模式和隐式跨渠道摘要链接策略。
模板 named reference、workspace templates、built-in 的查找顺序不改变；新增内建模板必须进入资源打包和测试。

## 6. 发布恢复、限流与通知 outbox

### 6.1 三种结果必须分开

共用发送结果：`delivered(receipt)`、`rejected(code,retryAt?)`、`unknown(code)`。
HTTP 2xx 不代表业务成功；缺回执、JSON 无法解析、超时、连接重置、可能已接收的 5xx 均不能证明未发送。
401/403、业务拒绝等明确失败不重发；可信 429/retry_after 可按平台给出的 due time 有界重试回复。
Slack `internal_error`、`fatal_error`、`service_unavailable` 和 Telegram 5xx 业务错误保持 unknown；
不能将所有 `ok:false` 都当作确定未写入。发布 journal 恢复也不会再次 POST 已明确拒绝的操作。
只读身份查询可采用既有有界 IO 退避，不把其规则照搬到 POST。

PublicationJournal 新 provider 使用 unqueryable 策略。发送前写 operation identity/request digest；
确认后只持久必要 receipt，不存 Bot URL、token、report body。补 Slack/Telegram 嵌套响应压缩和恢复响应重建，
恢复不能因为漏了 `ok`/`result` 字段把已送达消息判成失败。业务 rejected 不得错误写 confirmed。
已确认操作跳过；unknown 保持未知、停止该操作自动重发；当前请求变化不能授权新写入。
Discord nonce 若使用只能作额外短期保护，不改变 unknown 策略；不把“过去几分钟”编造成确定 TTL。
已有 1 MiB checkpoint 上限、fencing、lease 和发布阶段恢复仍适用。

### 6.2 outbox 扩展

复用 im_reply_outbox，通过追加迁移 `013_im_reply_payload` 新增版本化 `payload_json` 和必要 remote receipt，
将当前 compactReceipt 混用通知输入的旧格式保留为兼容读取。SQLite/PG 追加迁移，禁止修改历史 migration/checksum。
新 payload 含 connectionIdentity、connectionName、typed conversation、actor、requestId/command kind、
有界返回文本和摘要；不含原始输入、完整报告或临时交互凭证。单条 JSON 上限 16 KiB，输出文本仍遵守第 5 节预算。
只持久经过授权的 help/chat-id/status/accepted 简短返回值。

状态要求：pending → delivering → sending → delivered/rejected/unknown；明确限流可回 pending+nextAttemptAt。
claim 只取 pending 或到期 delivering；在网络调用前 fenced CAS 写 sending。
到期 sending 转 unknown，不能像当前 delivering 一样直接重领发送；到期 delivering 可证明尚未进入网络阶段才重领。
进程在写 sending 后、调用网络前崩溃也保守 unknown，接受少发风险，不能以猜测恢复重发。
每次状态更新校验 owner/fence，旧 worker 不能写新回执。pending 的过期转 expired；unknown 保留待诊断，不能 TTL 后重建发送。

acceptImDelivery 扩展可选 reply 写入，使 Telegram inbox、review 请求/配额、接受通知同事务提交；
help/chat-id/status 的 reply 同样与 inbox 原子登记。终态通知仍与 finishRequest 同事务产生。
终态源会话通知只含 request ID、状态和查询语法，不能复用当前包含 repoRef/revision 的文本模板泄露报告上下文。
发送前检查当前授权及持久 destinationIdentity，不允许连接名重用、群迁移或配置改动把旧消息转发至新目的地。
通知失败不改变已完成 review，也不再次调用 LLM。status 返回 request 的阶段/终态；
通知自己的 pending/sending/delivered/rejected/unknown 状态独立保留在 outbox，不合并成 review 状态。

### 6.3 限流与错误脱敏

遵守 S4/D5/T4；worker 顺序发送，client 按连接/目的地及 Discord global 提示保持限流缓存；
outbox 退避持久化 due time。缓存不提供跨进程吞吐承诺，其他 worker 仍需遵守各自收到的 429。
初始通知最多 5 次明确可重试尝试，生命周期 24 小时（本地设计值）；due 超过期限时 rejected，
仍 pending 而过期时 expired，不能缩短平台等待时间。
本地队列限流不替代远端 429；多进程测试验证不会忙循环，不能承诺平台固定吞吐。
Authorization、Slack response_url、Discord interaction token、Telegram `/bot<token>/` 路径均须脱敏，
包括 fetch 错误、redirect、trace、管理 API 预览和平台业务 error 文本。只记录有界错误码，不记录上游原文。

## 7. 管理、上线和回滚

- schema/capability → config entity/secret/reference → compiler/preview → UI inventory → generation/client → raw publisher/route
  必须全部有消费者和测试。保存草案不等于可启用。
- Slack manifest、Discord aicr command JSON 和 Telegram setWebhook/setMyCommands 操作说明属于最终交付。
  正常服务启动、配置预览及测试默认不注册远端命令或覆盖 webhook。
- Discord 工具只读现有 commands 后创建/更新指定 aicr；不得 bulk overwrite。Telegram 注册前检查 getWebhookInfo，
  禁止默认 drop_pending_updates；多个副本不能争抢同一 Bot webhook。
- 回滚先禁用新 bindings/callback admission，再停止新 claim、排空或保留可恢复请求；输出单独禁用。
  保留 outbox/unknown/receipt，不删记录后重发；恢复旧二进制前核查 schema reader 兼容性。
- 双语指南、可运行示例、输出规范和 AI 导航同步维护；主评审 prompt 无需平台操作规则，
  传输认证、当前授权与恢复由宿主实现。
