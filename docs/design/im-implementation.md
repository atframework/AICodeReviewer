# IM 功能执行手册

状态：所有开发任务未执行。仅制定计划不授权安装依赖、修改运行时代码、启动服务或发送真实消息。
后续收到实施授权后，按本手册逐项推进；已经授权的范围不需要在每项任务结束时重复请示。
任务状态入口是 [Plan.md](../../Plan.md)，合同入口是[实施合同](im-execution-contracts.md)，
测试编号和最终门禁见[验收矩阵](im-acceptance.md)。

## 1. 开发模型每次开始时执行的流程

1. 读根 `AGENTS.md`、Plan 的未完成任务和本次任务卡，只加载该卡列出的源码、skill 和参考章节。
   先核对 Git diff，保留用户和其他任务的修改；不要复制旧会话里的文件快照覆盖当前文件。
2. 查依赖任务的实现和证据，不能只看 checkbox。确认 public export、bootstrap 接线和测试文件真实存在。
   文档中标注“新增”的文件目前不存在属于正常现象，不将示意类型当成可调用 API。
3. 搜索当前符号和调用者：有 `.codegraph` 时先用 CodeGraph；结果缺失/过期再用 rg。
   本文列出的是 2026-09-28 的定位路径，若已移动，找真实继承者并同步导航，不建立同职能重复模块。
4. 用一段话说明本次改动、使用的合同、受影响文件和验收测试，再编辑。
   只能调整任务卡的产品表面；关联 export、manifest、锁文件和必要测试属于同一任务。
5. 先写有可观察断言的测试，再补实现；复用现有 fixture、clock、transport 和 store 工厂。
   对已有行为写回归，不能只证明新增 helper 返回自己刚构造的对象。
6. 按卡片顺序实现，运行定向测试，查看实际发现的文件/用例数。覆盖不足或测试没被发现不能标完成。
7. 检查 diff、文档同步和全部适用最终门禁。连续实施的中间迭代可用定向检查；
   结束交付或宣称任务完成前按仓库基线运行适用门禁，不能用本手册的定向测试替代。
8. 更新 Plan 状态和交接记录，继续已授权且依赖满足的下一项；不要因日常实现选择反复等待用户。

临时日志、实验与交接记录放 `build/logs/im/`、`build/tmp/im/`，先建目录。
永久测试 fixture 放所属 `packages/*/test/fixtures/im/`；`eval/` 不放任务测试数据。
禁止改全局格式、关闭 lint/coverage、扩张测试超时来掩盖错误。

## 2. 状态与停下来的条件

任务状态使用 `todo → in_progress → implemented → validated`。
implemented 只表示代码已接线；validated 需要对应断言、文档和适用门禁证据。
外部账户尚未验收时，IM-21 保持 pending_external，其余独立本地任务可继续。
Plan 的 checkbox 只在该项 validated 后勾选；整个功能不能因本地 mock 通过宣称交付完成。

以下情况仅暂停受影响步骤并报告：官方协议与合同冲突；无法建立数据库原子性/安全恢复；
需要改变公开字段或既定首期范围；必须升级不相关依赖；缺少真实验收账户。
报告须带“冲突的合同、当前代码/来源、影响、建议选项”，不能仅说“不确定”。
平台单据格式不清时拒绝该输入，不猜字段；但不能把拒绝所有正常输入当作功能完成。

普通路径移动、已有 helper 可复用、函数拆分、局部类型收敛、失败后修复并重跑同一测试无需新增审批。
若运行环境阻止进程启动，按 shell skill 排查与申请精确工具权限，不修改产品或测试断言。
本次用户只要求细化文档，因此现在不执行下面任一开发任务。

## 3. 任务顺序与阅读范围

| 任务 | 直接依赖 | 交付物 | 对应阶段 |
| --- | --- | --- | --- |
| IM-00 | 无 | 基线、协议常量、依赖候选及测试资料清单 | P0 |
| IM-01 | 00 | 共享类型和配置 schema | P0 |
| IM-02 | 01 | 来源合并、引用、凭据和配置版本 | P0 |
| IM-03 | 02 | 配置管理 API、字段 inventory 和 UI | P0 |
| IM-04 | 02 | 企业微信应用 API client | P1 |
| IM-05 | 04 | 应用输出 dispatcher 与接线 | P1 |
| IM-06 | 01 | 严格文件目录解析器 | P2 |
| IM-07 | 02、06 | 文件监视与目录资源生命周期 | P2 |
| IM-08 | 05、07 | 原生 @、模板和目录版本接线 | P2 |
| IM-09 | 02 | 持久 IM store 与迁移 | P3 |
| IM-10 | 00、02 | 平台验签/解密/归一化适配器 | P3 |
| IM-11 | 09、10 | 会话、命令解析、精确授权和接收服务 | P3/P4 |
| IM-12 | 11 | Hono 回调路由及持久确认 | P3 |
| IM-13 | 11 | 指定 revision 验证和 ReviewEvent | P4 |
| IM-14 | 09、12、13 | 请求 worker、队列交接和发布恢复 | P4 |
| IM-15 | 05、09、12、14 | 卡片动作发行、校验与原子消费 | P4 |
| IM-16 | 04、09、12、14、15 | 状态通知 outbox 与临时回复 | P4 |
| IM-17 | 07、12、14、16 | 切换配置、撤权、轮换、排空和 GC | P5 |
| IM-18 | 03、09、17 | 受控查询 API、管理视图与指标 | P5 |
| IM-19 | 08、15、17、18 | 组合回归和故障注入 | P5 |
| IM-20 | 19 | 全部文档/示例/AI 同步和最终门禁 | P5 |
| IM-21 | 20 | 真实平台受控验收 | P6 |
| IM-22 | 21 | 合同归并、里程碑与计划退役 | P6 |

默认按 00–22 顺序执行。依赖表允许跳过暂时外部阻塞而处理独立本地任务，不要求多 agent 并发。
配置任务使用 config/state pitfalls；发布任务使用 output skill；队列恢复使用 scheduling pitfalls；
VCS 使用 VCS pitfalls；AI 资产修改使用 maintenance skill；每次不必加载所有主题。

## 4. 任务卡

### IM-00 基线与协议资料

- 读：`AGENTS.md`、仓库 baseline、三份设计、来源记录；`package.json`、`vitest.config.ts` 和当前 Git diff。
- 做：记录当前 HEAD、相关 dirty 文件和已有测试失败；盘点实际 installed dependency 与 host 命令。
  固定 W1–W10/F1–F8 对应的 endpoint、payload、身份域、长度单位、ACK 与重试、有限凭证期限。
  补查企业微信 token 失效码白名单、发送字节上限/限速和租户 IP 要求；给每个常量附官方链接和日期。
- XML 依赖：按来源记录检查 `fast-xml-parser` 稳定 5.x 的具体补丁、Node/ESM 兼容及安全公告；
  固定 package/lock 版本方案和禁 DTD/实体展开的 options。只在实施授权下安装，不运行官方 demo 服务。
- 产出：`build/tmp/im/protocol-matrix.md` 和合成 fixture 清单；把长期有效的核查结果并入来源记录。
  永久 fixture 只写最小合成消息与预期值，不提交官方整页、真实会话、个人 ID 或凭据。
- 验收：C01、S01 的测试输入有明确定义，所有空白处标“阻塞哪个适配步骤”，不填猜测值。
  IM-00 完成不是平台接入完成。

### IM-01 共享类型与配置 schema

- 改：新增 core `im-config.ts`、`im-contracts.ts`，编辑 `config.ts`、`review-event.ts`、core `index.ts`。
- 顺序：实现[实施合同 §2–3](im-execution-contracts.md#2-配置字段和所有权)的判别类型；
  加 optional im 父节点；扩展应用 channel、目录来源、author_mappings；保留旧飞书内联和 API 目录形式。
  ReviewEvent 增加 requestOrigin，不增加 wecom/feishu VCS provider。
- 验证：新建 `packages/core/test/im-config.test.ts`、`im-contracts.test.ts`；扩展 review-event/config 回归。
  C01–C03：旧输入 canonical deep equality；正常新输入；逐项缺失/混用/错误类型/未知字段阴性用例。
- 禁止：`.passthrough()` 代替新 schema；默认启用 callback/review；为通过解析放宽旧字段验证。
- 出口：正常配置可表达全部目标，错误配置给具体路径；尚未接线能力不在用户页面标为可用。

### IM-02 配置源、引用与凭据

- 改：`config-format.ts`、`config-source.ts`、`config-capabilities.ts`、
  `config-secret-policy.ts`、`config-secret-sealing.ts`、`config-compiler.ts`、`config-preview.ts`、`config-publish.ts`。
- 顺序：注册两个 entity kind 与 collection 双向映射/schema；补 reference collection、rename/delete；
  更新 secret 注册及 purpose/host grants；补 connection 与 output/binding 类型校验；
  文件/DB 合并保持单次默认填充和来源优先级；跨实体校验放共享编译/发布边界，不能只在 UI 校验。
- 验证：C04–C07；扩展同名 core 测试和 `config-store-conformance.ts`。
  新/旧 config 后端序列化、缺省 im 时旧快照哈希、旧版本读取失败边界、秘密 seal/mask/恢复均覆盖。
- 禁止：把目录内容密封到 config snapshot；复用 VCS token grant 给 IM host；删除旧迁移或跳过 hash 验证。
- 出口：文件配置与 DB 配置产生等价有效配置；所有 credential literal 均密封，masked UI 更新不会清空秘密。

### IM-03 配置管理表单

- 改：core `config-components.ts`、`config-ui-runtime.ts`、`config-ui-spec.ts`、必要的 form-state；
  server `config-api.ts`、`dashboard/client/config-app.js` 及实际需要的 dashboard 资产。
- 顺序：注册实体页面、PAGE_ASSIGNMENT/ENTITY_PATH_PREFIX/required keys；字段 inventory 描述真实消费者；
  connection 引用候选与 kind 分组；secret 输入/省略保留/显式删除；编辑绑定和目录路径。
  暂无运行时消费者的字段不能把 inventory wired 标成 true，直到对应任务接线并补消费测试。
- 验证：C08；扩展 `config-ui-spec.test.ts`、`config-ui-integration.test.ts`、
  `packages/server/test/config-api.test.ts`、`config-ui-client.test.ts`、`tests/browser/config-ui.spec.ts`。
- 禁止：为新字段跳过现有 100% coverage；一次保存覆盖整个配置；把 draft secret 显示在 preview。
- 出口：创建→编辑→暂存→预览→发布→恢复链路真实运行，引用删除和协议切换正确失败。

### IM-04 企业微信应用 client

- 改：新增 outputs `wecom-app.ts` 及导出；server `im/connections.ts` 负责凭据解析/实例管理。
- 顺序：注入 transport/clock；固定官方 origin；实现 token single-flight/过期/隔离；
  分别实现 message/send 与 appchat/send；返回明确 delivered/partial/rejected/unknown 结果和脱敏错误。
- 验证：新 `packages/outputs/test/wecom-app.test.ts`，O01–O04；
  断言完整 HTTP method/path/query/body、并发 token 调用数、失效码单次刷新、HTTP 200+errcode 非零和部分收件人失败。
- 禁止：把所有 4xx/timeout 当 token 失效；未经确认重发非幂等 POST；日志记录 access_token 查询串。
- 出口：只有明确 API 成功生成成功回执；收到部分成功后不重发整个目标集合。

### IM-05 应用发布与模板接线

- 改：新增 outputs `wecom-app-dispatcher.ts`；`im-markdown.ts`、`template-engine.ts` 及确需模板资产；
  outputs `index.ts`、server bootstrap 的 rendering/channel/resolver 分支和复合 publisher 分类。
- 顺序：先 recipients text/Markdown，再 appchat Markdown，再无动作/可预留受控动作参数的模板卡片；
  接入目标链接、空结果策略、聚合和 UTF-8 分片；修复本次相关的 webhook 业务 errcode/手机号字段问题。
  IM-15 之前不对用户展示无法回调的“重新评审”按钮。
- 验证：O05–O08，新 `wecom-app-publishing.test.ts`，并扩展 bootstrap 和 publication-journal 测试。
  从真实 createOutputPublisherResolverFromConfig 调用到捕获 raw HTTP，不只测试 dispatcher。
- 禁止：给 appchat 塞 message/send 专属模板类型；将 buffered 当 delivered；以无限重试隐藏分片部分失败。
- 出口：静态和 DB 配置的真实发布路径都可用，旧 IM 和 Git 混合路由仍符合原合同。

### IM-06 目录 schema 与纯解析

- 改：新增 core `member-directory.ts` 和 `packages/core/test/member-directory.test.ts`。
- 顺序：按目录设计定义 schema；在 AST 层检出 duplicate key；JSON 严格语法与 YAML 安全选项分开；
  校验字节/成员/数组上限、scope/typed mention、重复 ID 与 member key；输出不可变数据和内容 digest。
- 验证：D01–D04，正常 YAML/JSON 等价，重复/超限/注入/未知版本与所有 all 伪身份被拒绝。
- 禁止：JSON.parse 后再查重复；平台 ID 大小写自行折叠；碰到错误成员就只过滤该项继续用不完整文件。
- 出口：整个文件成功或失败，显式空成员集合是成功清空；没有任何 filesystem watch/network 副作用。

### IM-07 Watch 服务

- 改：新增 server `im/member-directory-service.ts`，generation resource registry 与 dispose 接线。
- 顺序：baseDir/allowed_root 解析；受控读取→stat/摘要→parse→原子快照；
  父目录 watch、debounce/最大等待、periodic digest、single-flight+dirty、watcher 重建；
  health 状态与引用计数；旧 generation 独立视图；关闭后取消 timer/watcher 并等待读取。
- 验证：D05–D10，新 `member-directory-service.test.ts`；假 watcher 测漏事件/无 filename，
  真实临时文件测试原子 rename/删除重建/同 mtime 替换；日志/句柄清理有断言。
- 禁止：只 watch 原文件 inode；仅比较 mtime；坏文件继续给新通知用 last-good；无界 timer 或并行 reload。
- 出口：watch 不可用仍能自动 poll，正常文件恢复后自动启用；错误辅助文件不阻止报告发送。

### IM-08 目录身份与原生 @

- 改：outputs `channel-identity.ts`、`author-resolution.ts`、`feishu-members.ts`、相关 dispatcher；
  server bootstrap、必要的 `author-identity.ts` 候选包装。
- 顺序：按配置来源判断 directory capability；绑定 sourceTrigger 精确账户；映射至 opaque member key；
  延续黑名单/歧义/P4 workspace 优先；按平台 payload 渲染；同一报告/分片固定 snapshot。
  手机号只在受支持 text 消息中发送，独立记录补充通知 operation。
- 验证：D11–D16，扩展 channel-identity、feishu-app-publishing、runtime-generation 和真实 publisher 测试。
- 禁止：原 VCS username 直接变平台 ID；目录错误后 @all；把通讯录传给主 review prompt/MCP；
  为加入文件来源更改没有配置目录的旧 webhook 默认行为。
- 出口：三种相关频道的实际 HTTP payload 使用正确 ID 类型；guess 开关和 no_problems 抑制先于读取/通知。

### IM-09 持久化与迁移

- 改：新增 store `im-store.ts`、`im-store.pg.ts` 及必要共享 types/export；
  `schema.ts`、`schema.pg.ts`、`database.ts` 的 SQLite migration registry、`pg-migrations.ts`。
- 顺序：按实施合同建立表、索引和唯一约束；实现 accept/claim/dispatch/consume/finish 原子操作；
  加临时凭证用途绑定的密封封装；snapshot 引用查询；终态/活动数据分开的 retention。
  从当前 migration registry 取下一个版本，不复制本文日期推算版本号，不编辑既有 checksum。
- 验证：R01–R06，新 `packages/store/test/im-store-conformance.ts` 及
  `im-store.test.ts`、`im-store-pg.test.ts`；复用同一合同跑 SQLite 和真实 PG；扩展迁移 fixture/进程测试。
- 禁止：get→判断→insert 代替唯一约束；SQLite 同步 API 写法原样套 PG；事务中远端发消息；
  将密码/临时 URL 明文塞进 generic JSON；无凭据时将 PG mock 称真实 PG 通过。
- 出口：双后端原子语义、升级 verify 模式、旧 reader 拒绝新结构和 fresh-store 重启可证明。

### IM-10 协议与密码学适配器

- 改：新增 server `im/protocol-wecom-app.ts`、`protocol-wecom-aibot.ts`、`protocol-feishu.ts`，
  单一严格 XML 包装模块；依赖只加 server manifest 与必要锁文件。
- 顺序：raw bytes 限制；认证 envelope；平台签名和解密；receiver/app/tenant 检查；
  message/event/card/stream/challenge 判别；未知合法类型生成 ignored，不落入 review 分支。
  解密和 schema 错误同样只输出脱敏错误码。
- 验证：S01–S08，新 `packages/server/test/im-protocol.test.ts` 和最小合成 fixture；
  每种协议有独立固定预期向量、篡改、错 receiver、bad padding、重复认证字段和 oversized 用例。
- 禁止：自己编造 crypto；拿应用 CorpID 处理机器人空 receiveid；以 JSON 重序列化参与飞书验签；
  主动抓取回调中的附件/链接；运行官方示例服务作为产品实现。
- 出口：协议模块不需要 store/VCS/LLM 即可验证；认证失败没有任何持久/网络副作用。

### IM-11 命令、会话与授权服务

- 改：新增 server `im/command-service.ts`、`conversation-service.ts`，复用新 store。
- 顺序：固定命令 tokenizer；群 @当前机器人检测；精确 actor/conversation/binding 解析；
  repo-alias → trusted target；限流/容量；建立当前 snapshot pin；调用 acceptDelivery。
  help/chat-id/status 也走权限策略；会话发现只写 registry，不修改配置。
- 验证：A01–A08，新 `im-command-service.test.ts`；一条允许输入与每一层拒绝输入配对；
  同名跨应用用户、多个 binding、机器人消息、目录推测出的同名成员均不得绕过权限。
  IM-14 接线前 review capability 保持未就绪，生产配置只允许保存 disabled binding；测试注入明确的就绪依赖。
- 禁止：自然语言交给 LLM 执行；调用管理员 retry API；首次收到群消息即绑定所有仓库；
  在 callback 请求内查询远程 VCS 来判断 commit。
- 出口：接受只表示持久请求已创建；重复消息/活动目标返回既有 request ID；原提交作者尚不从操作人推断。

### IM-12 HTTP 回调与确认

- 改：新增 server `im/callback-routes.ts`，`index.ts` 的 ServerAppOptions/mountRoutes 和 bootstrap。
- 顺序：固定 connection path；保持 server pathPrefix；认证专用 middleware 保留 raw body；
  挑战验证快速返回；正常消息进入 command service；认证后的 lifecycle 更新/unknown ignored 分流；
  达到时间预算前按平台 ACK/失败格式返回。
- 验证：S09–S12、R07–R09，新 `im-callback-routes.test.ts`；必须用 createServerApp 发 HTTP，
  覆盖前缀、管理员 auth 不拦平台、body 限制、无签名拒绝、存储超时及 commit 后 ACK 丢失。
- 禁止：公开执行路由挂在“无需任何认证”的通用分支；2xx 后再异步写库；把 challenge 当业务消息。
- 出口：普通 ACK 内没有 VCS/LLM/远端发送调用；持久失败时没有成功 accepted 响应。

### IM-13 固定 revision 解析

- 改：新增 server `im/revision-resolver.ts`，`packages/vcs/src/contracts.ts` 和对应 git/p4/svn adapter 的必要能力。
  优先复用 resolveReviewRevision/listReviewCommitMetadataPage/describeSource，缺能力才加精确接口。
- 顺序：检查 provider/repo/workspace 绑定；Git 完整 object ID、对象存在/范围、第一父/root；
  P4 submitted change 与 depot scope；SVN revision 与配置路径；填可信 author/base/head/url/source metadata。
  生成 targetKind commit + requestOrigin；在进入自动提交接收逻辑前排除 IM 命令来源。
- 验证：V01–V07，新 `im-revision-resolver.test.ts`，扩展 vcs git/p4/svn 和 review-commits/source-descriptors 测试；
  Git 至少使用真实本地仓库创建 root/merge/范围外 commit，不能全部用字符串 mock。
- 禁止：去掉 -- 参数分隔符；字符串拼 shell；短 SHA/HEAD/branch 静默解析；把全局 SVN revision 当全路径授权。
- 出口：diff 和提交作者可由可信来源复算；未授权、非提交对象或不可证明范围明确拒绝，自动 stream 未改动。

### IM-14 请求 worker 与恢复

- 改：新增 server `im/manual-review-service.ts`，bootstrap jobHandler 分发、runtime-queue、
  review-orchestrator 的必要复用入口、publication-journal/持久 checkpoint 的必要扩展。
- 顺序：先 due 扫描与 dispatchSeq；再 lease/CAS 与固定 generation；再共享并发/时间窗口/预算；
  再分析→checkpoint→逐渠道发布；最后重启、fencing、retry_wait 和 graceful drain。
  enqueue 必须在请求固定 generation 内调用，让 runtime-queue 捕获同一 configVersion；消费时核对请求与 job 版本。
  配置 pin 接入 runtime GC；IM 分支以外的 injected jobHandler 保留原行为。
  完成接线后才允许启用 review capability，回归缺 worker/密封密钥时配置发布及 admission 均拒绝。
- 验证：R10–R16、V08，新 `im-review-runtime.test.ts`，扩展 queue-worker/runtime-generation/auto-commit-runtime。
  使用计数 LLM/publisher 断言次数；有 fresh service/store 对象，不只在同实例上重调方法。
- 禁止：复用 dead batch re-arm、删除旧 run、推进自动游标；用固定已 completed 的 job ID 阻断重试；
  同一次工作重复获得共享并发许可；先关闭数据库再等待 worker。
- 出口：新命令可重评已完成 commit，重复投递和重复 queue job 只执行一次活动请求；
  发布恢复不多调用 LLM，未知远端写入不盲发。

### IM-15 卡片动作

- 改：新增 server `im/action-service.ts`；Feishu/WeCom 支持卡片的 builder，request/publisher context 的受控 action 参数。
- 顺序：发送前发行随机 action record；保存目标/绑定/有效期；卡片仅输出 opaque ID；
  回调校验真实 operator、source message/TaskId、会话/接收人；原子 consume+request；重复返回原编号。
  如果远端消息 ID 在发送后才获得，保留待绑定状态并安全完成绑定，禁止用未核实回调来源补齐。
- 验证：A09–A13，新 `im-actions.test.ts`，平台 raw card 与真实 HTTP callback 联合用例；
  并发点击、转发、旧卡片、撤权、过期、响应丢失和绑定失败都有可观察结果。
- 禁止：按钮 value 直接传命令或 URL；共用全局 admin token；为传统 webhook 卡片伪造服务端回调能力。
- 出口：支持渠道的已发送卡片实际回调能建立同一目标新请求；unsupported 渠道不出现可点击但无效的操作。

### IM-16 状态通知与回复恢复

- 改：新增 server `im/reply-service.ts`、通知 outbox worker、临时凭证加解密；复用应用 API client。
- 顺序：ACK 与 accepted/终态通知分开；平台同步响应只展示已知本地结果；
  机器人被动 accepted + 保留一次性 URL；终态通知持久分发；到期/送达未知分类；status 兜底。
- 验证：O09–O12、R17–R18，新 `im-replies.test.ts`；断言 URL 1 次/到期不发、HTTPS host/path/重定向限制、
  卡片 token 更新预算、secret envelope 不能换行/跨用途复用、通知失败不重跑评审。
- 禁止：拿 response_url 当固定 webhook；URL 放入 log、metric、普通 run state；ACK 等通知成功；
  为“确保收到”把全量报告自动转发到来源群。
- 出口：请求状态与通知状态可分别查询，长任务超过临时能力期限仍可追踪。

### IM-17 配置切换、撤权和资源回收

- 改：connections/member-directory/manual-review/reply service，runtime-config 的 generation prepare/dispose 与 GC sources，关闭链路。
- 顺序：接收读当前 admission；旧任务执行配置固定；开始执行/发布前检查当前撤权；
  凭据变化重建对应 client；同一平台身份保持 dedup namespace；身份变化隔离旧数据。
  停机停止 admission/claim、abort/drain、释放 watcher/client、最后关 store；清理只删终态且无引用数据。
- 验证：X01–X07，扩展 runtime-generation/runtime-config、新 `im-lifecycle.test.ts`；
  请求跨 secret 轮换、旧目录与新配置、lease 失去后禁止新 POST、GC 任一后端失败均覆盖。
- 禁止：回退 current generation 处理丢失快照；将实例禁用当删除所有未决记录；日志输出旧 secret。
- 出口：旧工作不串配置，撤权立即限制新的执行/发布；已有远端不确定结果保留可诊断记录。

### IM-18 可观测性和管理查询

- 改：observability-api、core observability types、dashboard 相关 UI；复用当前 admin session/Bearer 边界。
- 顺序：只读分页 endpoints：`/api/admin/im/conversations`、`/requests`、`/directories`；
  展示 typed 会话 ID、请求/分析/发布/回复各状态、目录 digest/count/error、允许的受控操作提示。
  指标只使用有界维度：平台/状态/错误码，不用 actor/repo/requestId 作 label。
- 验证：X08–X10，扩展 observability-api/integration、config-ui-client 与 browser 用例；
  未登录拒绝、分页稳定、XSS、日志和页面中秘密/完整目录不存在。
- 禁止：新增匿名“调试”完整 payload API；沿用用户猜测的 request ID 作为访问权限。
- 出口：运维能区分没接到、被拒、等待、分析失败、发布未知、通知过期，无需读取聊天原文。

### IM-19 组合与故障测试

- 改：测试、必要的受控 fault injection seam；发现缺陷仅修对应任务表面。
- 做：按验收矩阵 C/D/O/S/A/V/R/X 所有编号确认测试映射，执行 fresh-process/store 与 crash matrix；
  完成 SQLite/PG、采用 Redis 时的真实 Redis、文件/DB、新旧 generation、三协议组合。
  Git 真实本地仓库必跑，P4/SVN 本地工具按已有受控服务规则验收。
- 证据：每个关键断言有文件/用例标题和日志，不把测试文件数量当需求覆盖数。
  平台 mock 与真实平台分开；未设置真实账户不影响本地矩阵，但 IM-21 不能勾选。
- 出口：逐条核对[故障注入表](im-execution-contracts.md#8-故障注入点)，任一未知发送没有新增重复 POST。

### IM-20 文档、示例与最终门禁

- 改：总体设计 §9 指定的当前行为文档，双语 `integrations/im-bots.md`、outputs、config-fields、
  overview、dashboard、operations、相关首次 webhook 说明；`example/config.yaml`/README/目录示例；
  AI skill 和来源记录；身份 prompt 只有候选合同变化才改，不让主模型掌握权限逻辑。
- 做：草案示例转成经过 `loadConfigFile`/schema/实际 bootstrap 测试的最小配置；
  单独说明持久 ConfigStore 前提、传统 webhook 限制和群 ID 类型；删除“schema 已接受=已支持”的措辞。
- 验证：所有适用完整 gates，确切命令见验收矩阵；文档站 build/check 与 browser 顺序运行。
  遇到原有不相关失败保留日志并报告，不删除测试或覆盖用户原有改动。
- 出口：实现、示例、双语页面、配置 UI 和 AI 指导描述同一行为；本地验收证据完整，生产仍未验证。

### IM-21 真实平台验收

- 前置：明确授权的测试应用/群/人员/仓库；不从历史配置自动读取 secret 或对生产群发消息。
- 做：按验收矩阵 L01–L06，一次测试群每种必要路径限量消息；平台配置权限和回调 URL 对照来源。
  缺少全部 env 跳过、部分 env 配置失败；先验证凭据/权限，再运行一次有界 review。
  密码学 demo 已读不等于平台连接通过；记录 @是否实际生效、会话类型、按钮实际 operator。
- 清理：能撤回的合成消息撤回；不能撤回的记录数量和原因；删除本任务生成的卡片动作/测试资源，
  不删除预存配置、成员或群。真实 review 可用确定性本地模型验证流程，真实 LLM 质量另列不冒认。
- 出口：每个承诺的平台路径均有指定账户/版本/权限证据；不可达路径保留明确未验收项。

### IM-22 归档

- 前置：所有必需本地与平台验收完成，或用户明确调整了交付范围并记录具体缺口。
- 做：稳定合同归入 architecture/output 文档，证据写新里程碑；更新路线图只留未完成事项；
  检索全部 inbound links 后，才退役本组临时设计/执行资料。保持来源记录和必要回归入口。
- 禁止：因为 checkbox 多或文档长而删除未完成计划；把暂停/缺凭据写为已验收。
- 出口：Plan 精简，任何未完成项仍可定位，历史证据不混进 prompt/skill 常规读取路径。

## 5. 每项任务的交接模板

在 `build/tmp/im/IM-xx-handoff.md` 使用以下结构。只记录本项新信息，不复制所有历史日志。
build 文件不保证跨机器保留；跨机器交接要提供当前 diff、Plan 状态和日志包，或将验收结论归入已追踪里程碑。

```text
任务：IM-xx；状态：implemented / validated / blocked
前置任务及核验：编号、实现符号、证据路径
实际变更：文件、公开接口、为何需要
保留的旧行为：有针对性的回归用例
测试：命令、退出码、发现文件/用例数、失败/跳过数量、日志
合同编号：本项已覆盖与未覆盖编号
外部证据：无 / 本地真实后端 / 真实平台；不得合并
剩余限制：具体原因与解除条件
下一任务：编号与依赖是否满足
```

## 6. 可直接交给开发模型的任务提示词

模板必须与用户实际授权一起提供。填写 IM 编号，不复制仓库秘密或完整通讯录。

```text
在用户已授权的实施范围内，执行 Plan.md 中依赖已满足的 IM-xx。
先读 AGENTS.md、该任务卡、该卡引用的实施合同和验收编号，再检查当前源码与 diff。
按任务卡的顺序改动；新增文件仅限任务边界及必要导出、测试和文档。
不把计划中的新增类型当成现成 API；先确认接线位置。
不得替换协议、字段、存储后端、授权或失败语义。若有源码/官方合同冲突，给出证据后暂停受影响项。
不得用 mock、内存状态、schema 接受或 helper 测试替代真实消费/恢复断言。
先实现正常路径及每个失败边界，再运行定向测试和适用最终门禁；核对测试发现数量。
保留无关修改、平台限制和未完成证据。更新本项状态并写交接记录。
若授权覆盖后续工作，依赖满足后继续下一项；日常实现选择不反复请求确认。
未授权的真实服务部署、生产写入、外部消息与收费模型调用不在任务模板授权范围。
```
