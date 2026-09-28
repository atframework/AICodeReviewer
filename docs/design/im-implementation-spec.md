# IM 实施规范

状态：分阶段实施中，完成范围以 [Plan.md](../../Plan.md) 和当前代码为准。本文为[执行手册](im-implementation.md)
规定跨模块接口和失败处理方式，未完成部分不是现成 API。平台能力见[总体设计](im-integrations.md)及[来源记录](../ai/sources/im-integrations.md)。
标为“新增”的位置须先核对实际代码，未创建的类型、字段和数据表在对应任务中实现。

## 1. 范围和默认决策

这些决策用于减少开发模型自行选择方案。发现源码或官方协议与之冲突时，先提交具体冲突和替代方案，
不通过兼容分支、静默降级或修改测试掩盖冲突。普通命名、内部私有函数拆分不需要再次确认。

| 项目 | 首期固定选择 |
| --- | --- |
| 接收 transport | HTTP 回调；不实现 WebSocket、不引入完整 IM SDK、不建立常驻外部连接 |
| 命令 | help、chat-id、review、status；watch 表示消息监听，长期 watch/unwatch 不实施 |
| 评审目标 | 每条命令一个已配置仓库、一个固定 revision；Git、P4、SVN 按总体设计语义 |
| 可执行命令的存储 | `StoreDb` 为 SQLite 或 PostgreSQL，且 `config_sources.database.enabled: true`，得到非空持久 snapshot ID |
| 文件配置模式 | 应用推送与文件目录可使用；没有持久 snapshot 的实例拒绝启用 review 命令，不降级内存接收 |
| 队列 | 使用现有 ReviewQueue 唤醒；请求表拥有状态、次数、租约、恢复真相；不修改自动提交 store 的 stream 语义 |
| 目录 | 一个频道只选一个来源，不合并 API 与文件；YAML/JSON，共用严格 schema |
| 文件更新 | 父目录 watch + 周期内容摘要；无效目录不为新发布提供过期身份 |
| 输出权限 | 默认 workspace 固定路由；首期源会话只收请求编号与状态，不新增动态完整报告转发模式 |
| 配置默认值 | 整个 `im` 父节点 optional；缺省时不注入 `{}`，保持历史 canonical config 和 snapshot hash |
| 身份模型 | 文件目录默认关闭猜测；沿用专用身份模型及预算，不改主评审 prompt，不用模型授权 |
| 分发升级 | 不为本任务升级所有依赖、迁移全部历史配置或重构全部 publisher |

持久 ConfigStore 是首期恢复的部署前提：`RuntimeConfigManager` 在 file-only 模式
返回 null snapshot，不能保证改动 YAML 后重启仍使用接收时的配置。当前运行时不受此提案影响。
推广到 file-only 的持久配置副本属于后续独立设计，不由实施模型临时新增第二套快照格式。
执行命令启用另需 runtime capability readiness：协议适配器、持久接收服务、worker 与密封密钥均已接线。
分阶段实现期间允许保存 disabled 草案；不得接受没有消费者的任务或展示尚不可用的按钮。

## 2. 配置字段和所有权

新增 `packages/core/src/im-config.ts`，从 `config.ts` 引用。新节点用严格对象 schema；
旧 passthrough 对象的未知扩展保留规则不改变。规范化过程中不要将可选新字段补进旧配置。

| 字段 | 类型、缺省及规则 |
| --- | --- |
| `im.connections` | 可选命名 map；数据库实体 kind `im_connection`，collection `im_connections` |
| `im.command_bindings` | 可选命名 map；kind `im_command_binding`，collection `im_command_bindings` |
| 新 map 的键 | 1–64 字符，`[A-Za-z0-9][A-Za-z0-9_-]*`；拒绝原型链保留键 |
| connection `kind` | wecom_app、wecom_aibot、feishu_app；不得作为 VCS trigger kind 使用 |
| connection `enabled` | boolean，运行时缺省 true；callback 缺省关闭 |
| wecom_app | corp_id:string、agent_id:正整数；app_secret/app_secret_env 二选一 |
| feishu_app | app_id:string、app_secret/app_secret_env 二选一；base_url 沿用两个官方 origin；开启 callback 时 tenant_key 必填 |
| wecom_aibot | aibot_id:string、corp_id:string；corp_id 是本地绑定身份域，不声称加密消息内携带它 |
| `callback.enabled` | boolean，缺省 false；启用后按类型要求凭据，无默认秘密值 |
| 企业微信 callback 凭据 | token/token_env、encoding_aes_key/encoding_aes_key_env，各一对互斥且启用时必填 |
| 飞书 callback 凭据 | verification_token/verification_token_env、encrypt_key/encrypt_key_env，同上 |
| binding `enabled` | boolean，缺省 false；示例显式开启，发布时检查实际回调及持久配置能力 |
| binding `connection` | 必填命名引用；禁用/不存在/协议不支持时拒绝启用 |
| binding `actors` | 非空 typed ID 数组；type 为 wecom_userid、wecom_encrypted_userid 或 feishu_open_id；命名空间继承 connection |
| binding `conversations` | 非空数组：app_direct、bot_direct，或 group + 非空 id；各类型必须匹配 connection 协议 |
| binding `commands` | help/chat-id/review/status 的非空去重数组；未知命令拒绝配置 |
| binding `repositories` | repo-alias → workspace/source_trigger/repo_ref；review 启用时非空；三者经现有 routing/VCS 范围校验 |
| binding `report_policy` | 首期仅 workspace_routes，运行时缺省此值；拒绝其他值 |
| output `connection` | 新应用频道必填；旧 feishu_app 可用原内联凭据，不能与引用同时使用 |
| wecom_app `target` | recipients + 至少一个非空 users/parties/tags 数组，或 appchat + chat_id，严格二选一 |

普通 `wecom_app` 回调不支持 group binding，appchat 输出不因此获得收群消息的能力。
`app_direct` 的对端由通过认证的 actor 决定；不能解释为所有企业成员获得权限。
多个 enabled binding 若对同一 connection/actor/conversation/命令可能重叠，首期发布时拒绝，
避免运行时顺序优先或把多个 allowlist 做并集。需要多仓库时放入同一 binding 的 repositories。

新增 literal secret 名称必须进入 `SEALED_LITERAL_SECRET_FIELDS` 及对应 secret-purpose policy；
`*_env` 是引用，不是秘密。connection 的删除/改名需更新引用或拒绝发布，不能静默清除 binding。
`author_mappings` 属于 output，目标是 file member key；它不进入命令授权模型。
文件字段的完整结构以[目录设计](member-directory.md)为唯一所有者。

必经配置链：schema → `CONFIG_ENTITY_COLLECTIONS` → database collection 双向映射/schema →
实体 capability → 引用收集/rename/delete → secret seal/policy → compiler/preview →
字段 inventory/UI → runtime generation。不能在 bootstrap 里读一个未注册的 raw object 作为捷径。
config v1/v2 都可增加 optional im 节点；不要为此修改旧路由优先级。
只有 canonical 输出确实变化才走既有 resolver-version 迁移流程，禁止简单放宽 snapshot hash 校验。

## 3. 包与接口边界

以下类型名和方法名是实施目标；private helper 可以调整。新接口以判别联合表示失败，不用 boolean 混淆
“没有匹配”“没有权限”“目录不可用”“远端发送结果未知”。

| 新增位置 | 最小责任与接口 |
| --- | --- |
| core `im-contracts.ts` | 无网络/DB：ImPrincipal、ImConversation、VerifiedImEvent、ImCommand、ManualReviewRequest、错误码 |
| core `member-directory.ts` | 文件字节 → 严格 schema/不可变目录数据；不在 core 中启动 watcher |
| outputs `wecom-app.ts` | WeComAppClient：token、sendToRecipients、sendToAppChat；注入 FetchLike、clock，不读 process.env |
| outputs `wecom-app-dispatcher.ts` | 结构化报告 → 平台 payload/分片和 DispatchResult；不解析聊天命令 |
| server `im/connections.ts` | 按 generation 解析 env/密钥、client/adapter 缓存、dispose；不读取 workspace 私有目录 |
| server `im/protocol-*.ts` | 三种平台：verifyAndDecode(raw request) 和 buildAck；不调用 VCS/LLM/outputs |
| server `im/callback-routes.ts` | 选择 connection、限额、raw body、认证、接收和响应；不拼 shell 命令 |
| server `im/member-directory-service.ts` | acquire/release view、getSnapshot、health；持有 watch/poll 资源 |
| store `im-store.ts` / `im-store.pg.ts` | 事务、唯一约束、CAS、lease；server 不散写 SQL |
| server `im/command-service.ts` | parseCommand、authorize、admit；只处理固定语法与精确 ID |
| server `im/revision-resolver.ts` | 可信 binding + revision → VCS 元数据与 ReviewEvent；不信任消息中的 author/url |
| server `im/manual-review-service.ts` | durable request 状态、队列交接、执行及 checkpoint；复用编排器 |
| server `im/action-service.ts` | issueAction、consumeAction；短期动作关联和原子消费 |
| server `im/reply-service.ts` | ack 以外的通知 outbox、一次性凭证、安全 URL、发送恢复 |

定义 `VerifiedImEvent` 时至少保留：connectionIdentity、protocol、deliveryKind/key、payloadDigest、
actor `{type,id}`、conversation `{kind,id?}`、occurredAt、messageId/eventId/actionId（按类型存在）、
content 判别联合。认证工厂的构造边界留在 server；core 的类型存在不允许路由直接用 `as` 伪造已验证值。

`connectionIdentity` 为 kind + 平台应用/机器人身份 + tenant/corp 域的稳定摘要，包含部署 namespace。
连接名用于配置查找；secret 轮换不改变 identity，应用/企业/租户变更必须改变。
飞书 open_id 以及企业微信加密 userid 不与其他连接下同字面值合并。
目录/actor ID 保留原始字面值，仅匹配文本做明确规范化，不擅自统一平台 ID 大小写。

ReviewEvent 新增 optional `requestOrigin`：`{kind:'im_command', requestId, connectionIdentity, requestedBy}`。
不改原 VCS provider/triggerName；`author` 是 VCS 提交作者。
路由和自动接收分类显式识别 requestOrigin，不通过 reason/title/rawEventName 的模糊字符串判断。
新字段必须贯通 strict schema、事件持久化、队列恢复及相关 serializer。

## 4. 持久数据和原子操作

全部 IM 表使用现有 StoreDb；SQLite/PG 同语义。以部署 namespace 隔离数据。
下列字段是逻辑数据约定，SQL 列可合并为经版本化 schema 校验的 JSON，但唯一键、索引与 CAS 字段必须可查询。
不可用任意 `runtime_state` JSON 代替需要数据库原子性的约束。

| 表 | 必须保存的字段与约束 |
| --- | --- |
| im_inbox | id、connectionIdentity、deliveryKind/key、payloadDigest、receivedAt、status、requestId?；唯一 `(namespace,identity,kind,key)` |
| im_review_requests | requestId、runId、bindingId、requestedBy、conversation、repo target、requestedRevision、resolvedRevision/base、configVersion、state、attempt/attemptsByPhase、resumePhase、nextAttemptAt、leaseOwner/leaseUntil/fence、dispatchSeq、checkpoint、errorCode、created/updatedAt |
| im_active_targets | 唯一 `(namespace,workspaceInstance,sourceIdentity,revision)` → requestId；直到执行/发布终态释放 |
| im_actions | opaque actionId、connectionIdentity、issuedConfigVersion、source message/TaskId、conversation/recipient、固定 target/revision、expiresAt、consumedRequestId、status |
| im_conversations | 唯一 namespace/identity/typed conversation key；能力、discovered/lastSeenAt、revokedAt；不能保存自动授权 |
| im_reply_outbox | operationId、request/action reference、destinationIdentity、payloadDigest、state、expiry、sealedReplyCredential?、compactReceipt、nextAttemptAt、lease/fence |
| im_rate_limits | namespace/scoped bucket key/window 起点的唯一计数；到期清理；与接收命令同事务消费 |

采用随机 request ID 和 run ID，一对一固定；新明确命令可在旧请求终态后创建新的一对 ID。
configVersion 复用 core `ExecutionConfigVersion`，包括 configSnapshotId、databaseRevision、fileDigest 和适用 routeId；
IM request 的 snapshot/fileDigest 不允许 null。issuedConfigVersion 用于原卡片追溯及 GC，不取代点击时的新请求配置。
inbox、action、outbox 间的引用及受影响 snapshot 必须纳入同一个活动引用枚举入口。
active-target 在远端校验前使用可信 binding 的仓库身份及规范化 revision：Git hex 小写，P4/SVN 规范十进制；
SVN 允许前缀 r，移除后使用相同 key。拒绝正负号、空白和范围；对象存在/范围校验仍在 worker 内。
别名不同但映射相同可信 source/workspace/revision 应合并活动请求，不能按消息 alias 文字分锁。
payloadDigest 来自通过验证后的规范化业务内容；不含每次重试变化的签名、投递 nonce 或临时 URL。
规范化函数需版本号；保存当前版本，跨版本不能把旧 key 下的新摘要误认为同一内容。
临时 URL 不参与业务去重；同一 delivery 的更新凭证只允许按平台身份匹配后有界替换未消费凭证。

必须提供以下 store 原子操作：

1. `acceptDelivery`：相同唯一键返回原结果；相同键不同 digest 返回 conflict。新命令在同一事务中
   创建 inbox、请求/active-target，必要时消费 action 和限额。已存在的同目标活动请求只关联，不新建。
2. `claimRequest`：仅允许 due 且 lease 不存在/过期的状态；CAS fence 递增，返回 claim token。
   每次更新、checkpoint、释放目标及终态写入必须携带 token；零行更新意味着失去所有权。
3. `prepareDispatch`：原子递增 dispatchSeq 并保留 pending 交接；队列 job ID 为
   `im-review-<requestId>-<dispatchSeq>`。同一次交接重试沿用同一 ID，后续尝试使用新序号。
4. `consumeAction`：检查来源、当前权限、期限和状态，再与 acceptDelivery 在同事务中消费；
   consumed 返回原 request。失败事务不得烧掉按钮或增加限额。
5. `finishRequest`：写终态/回执、释放 active target、创建必要终态通知 outbox 同事务；
   外部通知不在事务中发送。已有终态不重复累计 run/用量。

当前关系型 store 与 ConfigStore 可能是不同后端，不能宣称跨库事务。
接收顺序固定为：获得 current admission generation → begin/withAdmissionPin → IM 事务提交 →
end pin → 返回 accepted。pin 收尾失败但事务已提交时，按唯一 delivery key 查询恢复，不建立新请求。
把 IM store 的 `listActiveConfigSnapshotIds` 注册到 runtime GC；任何后端查询失败，本次 GC 停止。
fileDigest/snapshotId 丢失或无法加载返回明确错误，不 fallback 到 live head。

## 5. 请求状态与队列恢复

| 当前状态 | 允许的下一状态 | 条件 |
| --- | --- | --- |
| accepted | validating、rejected | 取得租约；再次确认安全策略 |
| validating | queued、retry_wait、rejected | revision 被可信 adapter 验证后保存完整固定目标；永久错误拒绝，暂时 IO 有界重试 |
| queued | running、rejected | 时间窗口/预算/当前授权通过，且取得共享并发许可 |
| running | publishing、retry_wait、failed | 保存分析结果后进入 publishing；分析故障不得误标发布成功 |
| publishing | succeeded、partial、publication_unknown、retry_wait、failed | 按逐 operation 回执归类；分析已完成后重试只能恢复发布 |
| retry_wait | validating、queued、publishing、rejected | 持久 resumePhase 和 due time；不得由是否存在某个可选字符串猜恢复位置 |
| 终态 | 无 | succeeded/partial/publication_unknown/failed/rejected 不原地变成新评审；新命令创建新请求 |

lease 到期不等于状态回退：保存 checkpoint/resumePhase；新所有者按 checkpoint 恢复。
发布前先检查 fencing，失去 lease 立刻停止新的远端请求；已在网络中的发送进入 unknown 对账。
partial 表示已知部分送达；publication_unknown 表示至少一笔远端结果不可证明，不能自动重新发送。
`status` 分开展示 analysis、publication 和 reply delivery，禁止把 accepted 展示为 review 成功。

请求表是次数/退避的唯一所有者。ReviewQueue 对 IM 唤醒 job 使用 `maxAttempts: 1`，
队列 job 完成只是本次唤醒结束；后台扫描仍按请求表 due 状态补投递。
扫描器先按 request.configVersion 加载 generation，再在 `RuntimeConfigManager.withGeneration` 中 enqueue；
现有 runtime-queue wrapper 会调用 captureForTask，不能让后台当前 generation 覆盖接收时版本。
队列 job 与请求表的 configVersion 必须一致；不一致拒绝执行并保留诊断，不选其中较新者。
每个实际尝试获得 request lease 后才计数；重复队列 delivery 不消耗第二次预算。
请求表按 validating/analysis/publication 保存 attemptsByPhase；执行窗口等待、繁忙 workspace、重复唤醒不计尝试。
使用接收快照的 `queue.retry.attempts/backoff` 策略；未配置时每阶段最多 3 次尝试，沿用现有
2 秒起始、60 秒上限的指数退避和 jitter 计算。实际 due time 持久化，重启不重新抽样提前重试。
发布仅重试可证明未送达的 operation；partial/unknown 终态不能因仍有次数而自动重发。
临时回复 outbox 也只对明确未发送失败做最多 3 次有界尝试，且受平台期限/次数更严格限制。
IM job 根据严格 `kind:'im_review'` 分支；其他 job 保留已有注入 handler，不能覆盖它。
现有 worker 获得并发许可后不要再调用会重复获取同一许可的调度包装；验证并发计数只增加一次。

扫描优先级和批量上限有界：默认每次至多 100 个 due 请求，排除忙 workspace 后继续扫描其他 workspace。
退避或执行窗口等待不占用全局/工作区许可。SQLite 多进程、PG 多连接须验证 lease 和唯一键。
memory queue 可作唤醒，只要两个持久 store 前提满足；rabbitmq 的现有内存 fallback 不改变这一前提。

## 6. 固定安全边界和本地资源预算

下列是本地默认常量，首期不做大量新配置字段。以注入 clock、transport、watcher 的测试替身验证。

| 边界 | 默认值/规则 |
| --- | --- |
| HTTP body | 最大 256 KiB；实际读取时也计数，不只信任 Content-Length；解密后相同上限 |
| 命令文本 | 最大 2,048 UTF-8 字节；单行、固定 token 数；不调用 shell 或 LLM 解释 |
| XML | 仅 XML 1.0 单根、最多 32 层；禁止 DTD/外部实体；认证字段不得重复；禁止宽松 HTML 模式 |
| HTTP ACK | 内部目标 1 秒内；challenge 1 秒、平台业务限制按 source record；不能等待 VCS/LLM/发送 |
| Replay | 正常业务签名请求窗口拟 5 分钟；原消息时间不等同签名投递时间，平台合法重试 fixture 优先验证 |
| 命令限流 | 每 actor+connection 每分钟 5 次新 review；每会话每分钟 20 次；同目标已有活动请求复用，不再计新任务 |
| 待处理容量 | 每 workspace 100、全 namespace 1,000；原子检查，满时明确拒绝，不先 ACK 成功后丢弃 |
| 请求/通知 lease | 60 秒，20 秒续约；CAS fence；使用 DB 时间或受控一致时钟，多副本不依赖未校准的客户端墙钟 |
| due 扫描 | 1 秒周期、每次至多 100 条；claim/dispatch 有索引和单轮截止，无无限分页 |
| Action | 系统 CSPRNG 至少 128 bit；24 小时；完成后保留去重 tombstone 至少 7 天 |
| Inbox | 终态 7 天；未处理、活动请求、未决发布依赖不按普通 TTL 删除 |
| 文件目录 | 大小、条数、300ms debounce/30s poll 等沿用目录文档，不重复设置第二份默认值 |

跨副本限流使用持久 bucket；现有 LLM provider rate limiter 不能直接作为用户命令配额。
限流 key 使用固定摘要，日志不显示 user ID/手机号；管理员受控审计可以保留 typed actor。
普通 payload/token/response_url 不进入异常原文。所有失败响应不区分私有仓库“不存在”与“无权限”。

企业微信 SHA-1 是官方协议，不改成自选 HMAC。AES 协议解析要独立实现严格 padding、长度和 receiver 检查；
机器人空 receiveid 与应用 CorpID 分支不可合并。飞书验签使用原始请求字节。
加解密正向样例必须有独立预期密文/摘要；仅同一实现 encrypt→decrypt 自测不足以证明协议兼容。

XML 候选依赖固定为上游维护的 `fast-xml-parser` 稳定 5.x，IM-00 锁定具体补丁和 options 后才安装；
官方说明支持实体/DOCTYPE，默认选项不构成安全保证。用禁用实体处理、显式拒绝 DTD、保留重复节点检测、
严格 validator 和边界测试封装到单一模块；不能用正则表达式解析完整 XML。
若锁定版本不能满足这些断言，阻塞 XML 适配任务并请求设计复审，不由执行模型换一个解析库继续。
JSON 文件使用能检测重复 key 的解析路径；不得先 JSON.parse 后才尝试检查已被覆盖的字段。
可复用已有 YAML 依赖的 JSON schema/AST 路径，但要额外拒绝 YAML-only 语法并保留严格 JSON 测试。

## 7. 目录和临时回复的生命周期补充

新增文件配置 `allowed_root` 为可选管理员受信根，缺省为主配置文件的 baseDir；
解析符号链接后的每个读取目标必须在该根内，使用路径边界比较，不能用字符串 startsWith。
上层 root 替换/权限变化也重验。配置发布验证 schema/scope；本地文件暂时缺失只降级辅助目录，
不能因此让已经通过的全局配置发布在不同副本随机失败。

watcher 注册在基于 generation 的宿主资源 registry，由 `onGenerationDispose` 释放引用。
同一文件可共享读取器，不共享不同 scope 的身份视图；一次发布固定一个 snapshot。
对遇到 dirty 事件但尚未完成验证的目录，新请求暂不使用旧身份。
slow reload 使用序号/CAS 防止迟到安装；首个 watcher 失败不阻止 poll 启动。

临时回复凭证保存为带用途和 row ID 绑定的 AEAD envelope，沿用部署密钥管理；
不能复用只按字段名关联的 config 密封接口而丢掉用途/所属行校验。
凭证缺少密封密钥时拒绝可执行回调配置，不把 URL 明文写进请求、队列或 journal。
token 轮换的旧解密密钥依既有只解密 keyring 保留到未决通知过期。

outbox 先写 pending，发送前占用/记录 sending；收到明确成功才 delivered。
一次性 response_url 网络结果未知后标 unknown，不再尝试；固定渠道消息也必须遵守其查询/幂等协议。
ACK、accepted 通知和最终状态是独立 operation，机器人一次性 URL 留给最终状态。
卡片动作不依赖临时回复 URL 的可用性，过期后用户仍可用 status 查询。
status 查询同时校验 actor+仓库+会话范围；不能通过猜 request ID 读到其他会话数据。

## 8. 故障注入点

在测试中注入以下边界，不在产品配置增加“制造故障”开关：

| 注入点 | 必须可恢复的事实 |
| --- | --- |
| pin 写完、IM 事务前退出 | 无请求，遗留 pin 由确认所有引用后的 GC 清理 |
| IM commit 后 ACK 前退出 | 平台重投递返回原 request ID；按钮未重复消费 |
| prepareDispatch 后 enqueue 前退出 | 扫描同 dispatchSeq 补投递 |
| enqueue 成功、交接标记前退出 | 同 job ID 不产生第二个 claim；请求状态不被覆盖 |
| job completed 后需新 attempt | 新 dispatchSeq 唤醒，避免旧 completed job 永久挡住重试 |
| 分析完成、发布开始前退出 | checkpoint 重启恢复，LLM 调用计数不增加 |
| 平台已收消息、本地未写回执 | remote unknown；未经证明不新发 POST |
| 完成请求、终态通知前退出 | outbox 可续发，run/用量不重复计账 |
| GC 读取一个后端失败 | 不删除 snapshot/pin/未决记录 |

对应可观察断言和任务绑定见[验收矩阵](im-acceptance.md)。
