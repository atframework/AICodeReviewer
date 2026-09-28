# IM 开发验收矩阵

状态：计划，所有编号尚未执行。配合[任务卡](im-implementation.md)和[实施合同](im-execution-contracts.md)使用。
编号表示需求断言组，不表示已存在测试，也不等同 Vitest 用例数量。每组允许多个测试，不能用一条宽泛快照替代。
源码定位基于 2026-09-28；当前门禁的唯一权威是[仓库基线](../ai/AGENTS.repository-baseline.md)。

## 1. 测试建设规则

每组记录：编号 → 测试文件和用例标题 → 执行命令 → 实际结果/日志。没有对应断言就保持未完成。
正常输入和负面输入必须成对测试，负面用例明确断言数据库行数、队列数、远端调用数和 LLM 次数。
验签失败不得因 catch 吞错后返回 success 而被算通过；只有“没抛异常”的测试无效。

采用现有 fixture/clock/transport 工厂。协议 fixture 使用合成身份，crypto 预期值独立计算并附来源；
watch 使用假事件验证时序，再用真实临时文件验证 OS 行为；DB 并发使用独立连接而非单对象顺序调用。
SQLite/PG 共用 conformance 断言，PG 必须连接真实专用后端；测试数据加本轮 namespace 并精确清理。
重启恢复至少关闭旧对象并构造 fresh store/runtime；关键 crash 边界另用子进程退出重开验证。
测试入口只能调用公开服务/路由/实际 publisher，不能直接写私有状态来绕过 admission 或 checkpoint。

下面路径均相对仓库根。“新增”表示实施时创建，不是现存工具。

## 2. 配置 C01–C08

主要位置：新增 `packages/core/test/im-config.test.ts`、`im-contracts.test.ts`；
扩展 core config-format/source/capabilities/secret/compiler/publish/UI 测试和 server config-api/UI 测试。

| 编号 | 输入或故障 | 必须观察到的结果 |
| --- | --- | --- |
| C01 | 现有 v1/v2、旧飞书内联、缺省 im 配置 | canonical 对象和旧 snapshot hash 不变；旧 reader 行为不被悄悄放宽 |
| C02 | 三种 connection、两种应用目标、文件/API 目录正常配置 | strict schema 成功；字段经 public export 可访问；ReviewEvent 仍是原 VCS provider |
| C03 | secret/env 同填、缺凭据、未知字段、错误身份、启用命令但无持久配置/消费者 | 在明确配置路径拒绝；禁用草案可保存；没有“发布成功但无法执行”的 review binding |
| C04 | 文件/DB 同名覆盖、实体增删改名、非法跨类型引用 | 两条来源链使用相同规则；rename/delete 不遗留悬空引用；不丢失旧 passthrough 扩展 |
| C05 | 新 secret 字段、masked 编辑、省略/显式删除、换 keyring | 静态/DB 路径正确密封和解析；列表/preview/log 无明文；错用途不能解密 |
| C06 | 没有 im 的历史快照、新实体 snapshot、篡改 hash | 历史可恢复，新配置可固定；篡改仍拒绝，不靠关掉 hash 校验兼容 |
| C07 | 重叠 binding、scope 不符、目录暂缺、source report 非允许策略 | 重叠/范围/策略拒绝；文件暂缺仅辅助目录降级；跨副本发布不依赖本机文件恰好存在 |
| C08 | 管理表单完整新建/编辑/预览/发布/恢复 | API 到实际配置闭环；字段 inventory 与消费者一致；秘密不回显；现有 UI coverage 门槛保持 |

## 3. 应用输出和回复 O01–O12

主要位置：新增 `packages/outputs/test/wecom-app.test.ts`、`wecom-app-publishing.test.ts`、
`packages/server/test/im-replies.test.ts`，扩展 bootstrap、publication-journal 和现有 IM 测试。

| 编号 | 输入或故障 | 必须观察到的结果 |
| --- | --- | --- |
| O01 | 并发发送、token 到期、相同应用不同凭据版本 | 同 key 获取 single-flight；不同 key 隔离；按 expires_in 刷新，日志无 query token |
| O02 | message/send 与 appchat/send | HTTP path/body 分别符合官方协议；不互用 chatid/模板类型；收件人列表与群 @含义分开 |
| O03 | HTTP 200+业务错误、白名单失效码、未知码 | 明确失败；仅白名单刷新一次；未知码/timeout 不引发额外非幂等发送 |
| O04 | 部分无效/无许可收件人、平台限流 | 保留成功部分；不重发整个列表；退避遵循已核实码和上限，无无限队列 |
| O05 | Unicode/中文恰好到字节边界、长报告 | UTF-8 字节数与平台结构均有效；分片 operation 有固定序号和独立回执，无截断损坏 |
| O06 | 真实 config→bootstrap→publisher，混合 Git/IM 输出 | 新频道被实际实例化并发送；旧频道、聚合和空结果策略不变；不以 helper 成功代替接线 |
| O07 | webhook 手机号、userid、Markdown 与 text | 手机号只进受支持 text 字段；Markdown userid 正确；业务 errcode 被检查，无无效字段伪 @ |
| O08 | 已发送部分分片后断连/回执丢失 | delivered/partial/unknown 正确；已送达不重发，未知未核实不新发 POST；不再调用 LLM |
| O09 | API bot accepted 与终态、1 小时边界 | accepted 不消费留给终态的一次性 URL；只消费一次，到期不发；status 仍可查 |
| O10 | 伪造 URL、错误 host/path、重定向、错行密文 | 仅认证来源的允许 HTTPS 目标可用；不跟跳转；AEAD row/purpose 不匹配拒绝，无外连 |
| O11 | 飞书卡片更新 token 到期/第三次更新 | 30 分钟和两次预算有持久竞争保护；不得把临时 token 当永久消息通道 |
| O12 | 终态通知失败/unknown、源会话没有报告权限 | 分开显示评审与回复状态；不重跑分析，不转发完整报告；未知一次性 URL 不重用 |

## 4. 文件目录 D01–D16

主要位置：新增 `packages/core/test/member-directory.test.ts`、
`packages/server/test/member-directory-service.test.ts`；扩展 channel-identity、author-resolution、
feishu-app-publishing、runtime-generation 与 bootstrap 测试。

| 编号 | 输入或故障 | 必须观察到的结果 |
| --- | --- | --- |
| D01 | 等价 YAML/JSON、空 members、多个独立目录 | 相同成员模型；空集合清空；只选配置目录，不合并跨 scope 身份 |
| D02 | 重复 key、重复成员 ID/key、YAML tag/alias、JSON 宽松语法 | 转成普通对象前检出重复；不合法整份拒绝；不静默过滤坏成员 |
| D03 | 未知版本/字段、错误编码、大小/条数边界 | 等于上限通过，超限明确拒绝；没有无界分配/深度；不存在猜测版本兼容 |
| D04 | mention 注入、all/@all、错误类型/身份 scope | 拒绝并无 @输出；跨应用同字面 ID 不合并；显示名不能成为权限 |
| D05 | 配置相对路径、DB 配置、cwd 改动、symlink 逃逸 | 始终按固定 baseDir/allowed_root；根外目标拒绝；每次重读重新验证 |
| D06 | 原地写、截断恢复、临时文件 rename | 父目录 watch 捕获更新；300ms debounce/2s 最大等待有界；半文件期间不使用旧身份发新提醒 |
| D07 | 漏事件、filename 缺失、mtime/size 相同 | 定期摘要仍发现内容变化；不是只做 stat；相同摘要不重复安装/清缓存 |
| D08 | watcher error/close、父目录删除重建、watch:false | polling 持续，重挂有退避；关闭 watch 不关闭自动 reload，无忙循环 |
| D09 | 连续 dirty、慢读取、dispose 与 reload 竞争 | single-flight，旧读取不覆盖新快照，关闭后无晚到安装、timer/句柄泄漏 |
| D10 | 缺文件/无权限/坏内容→恢复、配置预览 | unavailable 时报告仍发但不 @；恢复自动启用；预览不留下永久 watcher |
| D11 | 精确 VCS 账户、同名跨 trigger、aliases/email 歧义 | 正确 namespace 才匹配；歧义不选第一个；明确 author_mapping 指向有效 member key |
| D12 | 黑名单、共享 P4 账号、workspace 身份 | 保持已有优先级；黑名单先于猜测；不能把共享提交账号当具体人员 |
| D13 | guess 关闭/模型返回非候选/no_problems | 无多余模型或目录读取；只接受候选 opaque key；空结果抑制先于 @ |
| D14 | 三种目标真实 publisher、飞书外部群、手机号补充提醒 | raw payload 使用正确 typed ID；补充 text 独立计限额与回执；无目录旧 webhook 行为回归 |
| D15 | 报告拆分途中目录更新、新旧 generation 并存 | 本次所有分片使用同一 digest；新发布取新快照；旧 generation 不借新 scope/path |
| D16 | 发布恢复途中目录变化、隐私探针 | 已持久 payload/operation 不换收件人重发；日志/主 prompt/MCP/run artifact 无完整成员资料 |

## 5. 协议和 HTTP S01–S12

主要位置：新增 `packages/server/test/im-protocol.test.ts`、`im-callback-routes.test.ts`；
fixture 放 `packages/server/test/fixtures/im/`。协议 fixture 不依赖真实凭据。

| 编号 | 输入或故障 | 必须观察到的结果 |
| --- | --- | --- |
| S01 | 官方协议独立固定向量、已锁定 XML 依赖/options | 密文/签名预期匹配；记录来源与版本；不能只测同一实现 encrypt→decrypt |
| S02 | 企业微信应用 GET/POST、错 receiver/AgentID | challenge 正确明文；正常 XML 解密；错误域拒绝且无 inbox/job/发送 |
| S03 | API bot 空 receiveid、aibotid、stream 刷新 | 独立 JSON 协议和 encrypted ACK；错 bot 拒绝；stream 不创建 review |
| S04 | 飞书 raw body 空格/顺序变化、错 token/app/tenant | 签名对原始 bytes 验证；篡改与跨域失败；不靠 JSON 重序列化验签 |
| S05 | 飞书 URL challenge 和普通消息/事件/卡片 | 专用验证路径，challenge 不入库执行；事件与卡片分型，按真实协议响应 |
| S06 | bad padding/长度、重复认证字段、DTD/XXE、多根/过深 XML | 全部拒绝；无网络实体请求；未知合法事件可 ignored，非法 envelope 不假成功 |
| S07 | 超 body/text 上限、Content-Length 伪造、chunked | 读取过程限额有效；解密后再限额；错误脱敏，无超限持久 payload |
| S08 | 时间窗边界、旧消息的新签名重试、相同 key 不同内容 | 合法补推仍可去重；重放/冲突拒绝；不误用事件创建时间；源站复用旧签名需先复审策略 |
| S09 | createServerApp+pathPrefix、管理员认证 middleware | 平台专用验签能访问正确路由；管理员会话不是回调凭据；其他管理端点未放开 |
| S10 | challenge/消息/卡片 deadline、慢 VCS/LLM/发送替身 | 内部 ACK 目标 1 秒，平台期限独立计时；请求路径未调用慢远端服务 |
| S11 | 认证合法但存储失败/预算耗尽、卡片不重投 | 不返回 accepted 成功；响应遵守平台失败协议；卡片不承诺重试，用户可重新查询/操作 |
| S12 | 未知类型、机器人自身消息、生命周期事件 | 无循环 review；仅支持的已认证生命周期更新状态，发现/退出不自动改仓库配置 |

## 6. 授权和动作 A01–A13

主要位置：新增 `packages/server/test/im-command-service.test.ts`、`im-actions.test.ts`。
动作测试包含平台卡片 raw payload→HTTP callback→store 的联合链路。

| 编号 | 输入或故障 | 必须观察到的结果 |
| --- | --- | --- |
| A01 | help/chat-id/review/status、额外参数/换行/shell 字符 | 固定 grammar，非法拒绝；无 shell/LLM 自然语言执行；error 不泄露仓库存在性 |
| A02 | 配对合法 actor 与同名跨租户/应用 ID | 只精确 typed principal 命中；目录成员、别名和模型猜测不能授权 |
| A03 | 单聊、允许群、未知群、未 @当前机器人 | 仅 binding 命中且群 @条件通过可 review；会话发现不创建 binding |
| A04 | alias、workspace、trigger、repo 不一致/路径/URL 输入 | 只接受预注册 alias 和可信绑定；消息不提供 clone URL、工作区路径或凭据 |
| A05 | 猜 request ID、同 actor 跨未授权会话 status | 同时验证 actor/仓库/会话；不返回其他任务报告/状态；chat-id 不伪造 appchat ID |
| A06 | 同一 actor/会话跨副本并发、新请求/重复请求 | 持久配额不超限；相同投递/活动目标复用不重复扣新任务预算 |
| A07 | workspace/global 队列容量刚好满、事务失败 | 原子上限准确；拒绝明确；rollback 不占限额/动作，不先成功 ACK 后丢请求 |
| A08 | 绑定禁用/撤权、无 worker 或持久 config 能力 | 不接收不可执行请求；既有已接受请求保留可查询拒绝状态；不 fallback 管理 retry API |
| A09 | 支持卡片平台正常发送/点击 | 客户端仅见 opaque action ID；服务端保存固定 target/revision；真实 operator 单独记录 |
| A10 | 同按钮并发点击/响应丢失后再点 | consume+request 同事务；同一 action 返回原 request；总 run/动作消费次数为 1 |
| A11 | 转发卡片、改 action value、错 source message/TaskId/会话 | 即使 action ID 存在也拒绝；不能用回调自报来源补齐待绑定动作 |
| A12 | 24 小时边界、撤权后旧卡片、旧 action 记录 | 过期/撤权拒绝；tombstone 保证重复可识别；不能被新消息语法绕过 |
| A13 | 远端发送与本地 action 绑定间隙/失败、unsupported channel | pending action 不执行，失败可诊断；传统 webhook/appchat 不展示不支持的回调按钮 |

## 7. VCS 和评审语义 V01–V08

主要位置：新增 `packages/server/test/im-revision-resolver.test.ts`；
扩展 VCS adapter 和 auto-commit/runtime 测试。Git 建真实本地仓库；P4/SVN 使用既有受控 fixture/服务。

| 编号 | 输入或故障 | 必须观察到的结果 |
| --- | --- | --- |
| V01 | Git 完整 SHA-1/SHA-256 与短 SHA/branch/tag/revspec | 支持配置仓库 object format 的完整 commit ID；拒绝浮动/范围表达式；不从输入构造 shell |
| V02 | Git root/普通/merge commit、blob、范围外对象 | root 对空树，merge 对第一父；只接受范围内 commit；目标/基线在执行前固定 |
| V03 | P4 submitted/pending/不存在/范围外 change | 仅授权 depot 的已提交 change；基线与文件范围由 adapter 给出；不评审 pending shelf |
| V04 | SVN rN/纯 N、HEAD/范围/范围外路径 | 接受固定正整数 revision，按配置路径求差异；拒绝浮动目标或非法访问 |
| V05 | commit 作者与聊天操作者不同 | author 来自可信 VCS；requestedBy 单独记录；路由/归属不被消息伪造字段覆盖 |
| V06 | 已评审 commit 再收到新明确命令 | 旧 run 留存，新 request/run 可执行；同活动目标合并；不被旧 commit 去重永久吞掉 |
| V07 | 手动 review 与自动流同时运行 | 自动游标/批次/窗口语义不变；IM requestOrigin 不进入自动 admission/re-arm 分支 |
| V08 | metadata IO 暂时失败、缺必要 metadata/快照 | 有界重试或明确拒绝；不换成 latest HEAD/current config；未验证目标不启动 LLM |

## 8. 持久化和恢复 R01–R18

主要位置：新增 `packages/store/test/im-store-conformance.ts`、`im-store.test.ts`、`im-store-pg.test.ts`；
新增 server `im-review-runtime.test.ts`、`im-callback-routes.test.ts`、`im-replies.test.ts`。
conformance 文件由 `.test.ts` wrapper 引入，不能把 helper 未被自动发现误认为已跑。

| 编号 | 输入或故障 | 必须观察到的结果 |
| --- | --- | --- |
| R01 | 新建、旧版本升级、verify 模式、旧 reader | SQLite/PG 对等；append-only migration/checksum；verify 不写；旧 reader 明确拒绝不支持结构 |
| R02 | 多连接同 delivery key、不同 payload digest | 同内容一个 inbox/request；冲突拒绝；唯一约束不是 get→insert 竞态 |
| R03 | 同 target 不同 alias/大小写/合法 revision 表达、终态后新命令 | 规范化后活动期关联一个 request；终态释放后可新建；workspace/source identity 隔离 |
| R04 | consumeAction/限额/acceptDelivery 中途 rollback | 动作、inbox、请求、配额整体提交或回滚，无半消费 |
| R05 | claim 竞争、lease 到期、过期 fence 写 checkpoint | 单 owner；fence 单调增加；旧 owner 零行更新并停止新副作用 |
| R06 | snapshot pin/活动引用/终态清理及跨库失败 | 接收前持久 pin；所有活动引用阻止 GC；一个查询失败即停止本轮清理 |
| R07 | pin 后 IM 事务前 crash | 重启无幽灵请求；孤立 pin 经引用确认后可回收 |
| R08 | IM commit 后 ACK 前 crash/重复平台投递 | 查询返回原 request；不会第二次扣额、消费动作或 enqueue 新逻辑尝试 |
| R09 | ACK 前存储超时且 commit 状态不确定 | 按 delivery key 对账；不能直接创建新请求；未知不宣称 accepted/failed 已确定 |
| R10 | prepareDispatch 后 enqueue 前 crash、期间 current 配置改变 | 同 dispatchSeq/job ID 补投递；runtime-queue 捕获原 request.configVersion，不被扫描时 current 覆盖 |
| R11 | enqueue 后标记前 crash、重复 queue job | 同 handoff ID 去重，request lease 防二次执行；不覆盖已有运行/终态 |
| R12 | job completed 后请求需重试、memory queue 进程丢失 | 新 dispatchSeq 唤醒；请求表恢复遗漏 job；分阶段次数和 due time 不重置；maxAttempts:1 不丢逻辑请求 |
| R13 | busy workspace、执行窗口等待、预算不足 | 复用共享并发/公平性；等待不占 permit；一次实际执行只获取一次许可/计一次尝试 |
| R14 | 分析完成后、发布前 crash | fresh process 用 checkpoint 恢复；LLM 计数不增加；未完成分析不能伪装完成 |
| R15 | 远端收消息后本地回执丢失、部分目标失败 | journal 对账，已送达不重发；不支持证明时 publication_unknown；其他目标结果保留 |
| R16 | run 完成/用量入账/释放目标时 crash | 重启终态一致、计费/用量和 run 计数不重复；resumePhase 明确，非法状态迁移拒绝 |
| R17 | 请求终态后通知前 crash、多个 outbox worker | 通知独立恢复，单 claim/operation；不能因通知失败重做 review |
| R18 | sending 后丢回执/临时凭证过期/密钥轮换 | 一次性凭证 unknown 不再发；旧密钥可在期限内解密；期限后清理凭证，状态仍可查 |

## 9. 生命周期和管理 X01–X10

主要位置：新增 `packages/server/test/im-lifecycle.test.ts`；扩展 runtime-generation/runtime-config、
observability-api/integration、config-ui-client 和 `tests/browser/config-ui.spec.ts`。

| 编号 | 输入或故障 | 必须观察到的结果 |
| --- | --- | --- |
| X01 | accepted 后发布新配置再重启 | 原请求加载接收时 snapshot；缺失明确错误；不取 current head 偷换目标/模型/输出 |
| X02 | secret 轮换、连接改名、tenant/app 改变 | 同平台身份 dedup 稳定；新身份分域；引用改名不遗失，旧 callback key 生命周期明确 |
| X03 | 排队/分析/发布前撤权或移出群 | 当前策略再次拦截新执行/发布；已发结果不假装撤销，保留 audit/unknown |
| X04 | 新旧 generation 同文件/不同 scope/path、资源释放 | 可共享 reader，不共享身份视图；最后引用释放才 dispose；无 watcher/client 泄漏 |
| X05 | worker 运行中 shutdown/abort | admission/claim 先停，worker drain/abort 后关 store；lease 可恢复，不误标成功 |
| X06 | 丢 lease 时恰有 in-flight POST | 禁止后续 POST；已在途保留未知对账，不能声称 fencing 撤销了远端请求 |
| X07 | retention 到期但有活动请求/未决发布/后端不可用 | 不删依赖；停止不安全 GC；已终态无依赖数据可有界清理 |
| X08 | 管理查询未登录、分页/ID 猜测 | 管理认证仍有效；受控分页稳定；聊天 status 不借管理员查询绕过权限 |
| X09 | 恶意显示名/错误文本/secret 字段、指标 labels | 页面转义，无 XSS；不泄露秘密/完整目录；指标只有有界平台/状态/错误码维度 |
| X10 | 配置 UI→回调→请求→状态→目录故障 | 管理端正确区别接收/授权/分析/发布/通知；browser 驱动真实 CLI 和临时 SQLite |

## 10. 真实平台 L01–L06

本节必须有明确测试账户/群/人员/发送授权，普通单元测试不隐式执行。
实施时在服务指南登记新的 WeCom 环境变量全集和调用预算，不猜现有变量名；全部缺失为 skip，部分填写为 fail。
每项证据记录平台/版本/租户能力、操作时间、预期与实际、消息数量和清理结果，屏蔽秘密与个人信息。

| 编号 | 实际操作 | 验收结果 |
| --- | --- | --- |
| L01 | 企业微信应用向测试成员和允许的 appchat 推送 | text/Markdown/受支持卡片实际显示；目标权限/业务回执正确；appchat 不测试不存在的卡片能力 |
| L02 | 企业微信与飞书 webhook 使用合成文件成员 @ | 客户端确实提醒指定人员；更新文件后下一新发布改变成员；有效清空停止提醒 |
| L03 | 三种连接验证 URL，发送消息/事件与 chat-id | 验签/解密成功；会话类型/ID 可查；普通应用单聊不返回伪群 ID |
| L04 | 消息命令指定固定合成 commit，完成后再次 review | 首次及新请求各一 run；作者正确；自动流不动；最终报告只走批准路由 |
| L05 | 支持卡片的应用/API bot 点击、重复点击、未授权人点击 | 正常执行、重复同编号、未授权拒绝；转发/撤权/期限拒绝有证据 |
| L06 | 长任务或模拟到期、服务重启、目录实际挂载 watch | reply 过期可 status 查；不重复发送；Windows/Linux 与使用的容器/网络挂载分别记结果和延迟 |

本地受控 Git/P4/SVN/PG/Redis、真实平台、真实 LLM 和生产验收是不同证据，不相互替代。
确定性模型足以验证本功能编排，不能据此声明真实模型评审质量。

## 11. 执行命令与门禁顺序

以下命令只供后续获授权的实施使用，本轮不执行。Windows 先确认 PowerShell 7、node、rg、pnpm 等工具。
临时文件/日志先创建目录。以实际任务维护 test path 数组，不一次跑尚未创建的未来测试。

```powershell
New-Item -ItemType Directory -Force build/logs/im, build/tmp/im | Out-Null
$imTestPaths = @(
  'packages/core/test/im-config.test.ts'
  'packages/core/test/im-contracts.test.ts'
)
foreach ($imTestPath in $imTestPaths) {
  if (-not (Test-Path -LiteralPath $imTestPath)) { throw "Missing test: $imTestPath" }
}
node node_modules/vitest/vitest.mjs run @imTestPaths 2>&1 |
  Tee-Object -FilePath build/logs/im/IM-01-targeted.log
if ($LASTEXITCODE -ne 0) { throw 'Targeted gate failed' }
```

检查输出中实际 test files、tests、failed、skipped；禁止 `--passWithNoTests`。
conformance helper 不独立执行，使用两种 `.test.ts` wrapper；数据库迁移组串行跑或每组使用独立数据库，
不能多个 Vitest 进程同时迁移同一 schema。重试前查清失败原因，不延长 timeout/降低 coverage 遮盖问题。

最终开发门禁按下面次序串行执行，每条单独保留日志和退出码，失败先修复再继续宣称完成：

| 顺序 | Windows 仓库根命令 | 适用范围与额外证据 |
| --- | --- | --- |
| 1 | `node node_modules/eslint/bin/eslint.js . --max-warnings=0` | 全部运行时修改 |
| 2 | `node node_modules/typescript/bin/tsc -b tsconfig.json --pretty false` | public exports、包边界和严格类型 |
| 3 | `node node_modules/vitest/vitest.mjs run --coverage` | 全量发现数、覆盖率；IM store/队列修改需已导出专用 PG/Redis 测试端点 |
| 4 | `node node_modules/markdownlint-cli2/markdownlint-cli2-bin.mjs` | 仓库 Markdown，含隐藏 AI 资产 |
| 5 | `cmd /c "pnpm build"` | 在 Windows 允许的包管理 shim 例外 |
| 6 | `node packages/cli/dist/index.js eval --validate-only` | build 后离线 fixture 验证，不是 LLM 质量证据 |
| 7 | `cmd /c "pnpm test:browser"` | build 后真实管理 UI；浏览器未安装先记录并按授权完成前置 |
| 8 | `cmd /c "pnpm docs:check"` | 新 schema 的文档字段/类型引用 |
| 9 | `cmd /c "pnpm docs:build"` | 两种语言页面和站点；与 docs:check/browser 顺序运行 |
| 10 | `git diff --check` | 检查 whitespace；同时审查无关 diff 没有被覆盖 |

Linux 使用仓库基线的 `pnpm run ci` 和对应 browser/docs 命令。真实后端准备与清理按
[服务指南](../testing-services.md)，不要随意下载/启动未授权生产服务或清空共享数据库。
PG/Redis 环境变量、SVN/P4 executable 变量以仓库基线为准；缺少某项要写该断言“未运行”，不能算通过。
手动真实 IM 账户用例独立于全量 coverage，防止重复消息和付费调用。

本轮只改内部 Markdown：运行第 4、10 项和新增文档的本地引用、YAML 示例语法、skill 元数据、
任务依赖及编号完整性检查。YAML 可解析不代表当前 runtime 支持草案字段。

## 12. 完成判定

IM-19 之前逐行建立 C/D/O/S/A/V/R/X 的实现映射；IM-20 汇总门禁，IM-21 补 L 组证据。
一组只验证正常路径、不含对应故障断言，或测试被 skip，均不能勾选相关任务。
发现当前源码与计划不符时先更新明确合同及受影响编号，再修实现和测试；不要删编号以消除失败。
计划退役前保留稳定协议、来源和证据索引，未完成项继续留在 Plan/路线图。
