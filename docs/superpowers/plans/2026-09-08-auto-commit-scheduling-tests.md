# 自动提交调度测试与性能验收矩阵

状态：待执行。2026-09-08 编写，2026-09-09 修订；未实现功能，也未运行本矩阵中的新测试。

合同来源：[设计方案](../specs/2026-09-08-auto-commit-scheduling-design.md)。
任务归属：[实施计划 P0–P6](2026-09-08-auto-commit-scheduling-plan.md)。
下表的“预期”是未来测试断言，不是当前代码结果。

## 1. 测试方法与落点

| 层 | 建议位置 | 证据形式 |
| --- | --- | --- |
| 配置/日历/分组/来源排除 | `packages/core/test/config.test.ts`，拟新增 schedule/batch/source-filter 策略测试 | 注入 UTC clock，固定时区/元数据/规则，断言分组、排除判定与下一边界 |
| queue 共享合同 | `packages/core/test/queue*.test.ts` 及拟新增 conformance 场景 | memory、真实 SQLite、Redis adapter 对相同操作序列给出相同逻辑结果 |
| Redis 真实语义 | core 的独立 integration 场景 | 真实 Redis + 安装版 BullMQ；隔离 key prefix，校验 delayed/lease/Lua/outbox |
| VCS | `packages/vcs/test/git.test.ts`、`p4.test.ts`、`svn.test.ts` | runner 参数断言 + 可解释的真实 CLI fixture；Git/SVN 临时本地仓库 |
| 服务接线 | `packages/server/test/index.test.ts`、`bootstrap.test.ts`、各 webhook tests | 真实 HTTP handler、持久后端和 fake 审查依赖；断言没有直接调用旧 timer 路径 |
| 输出/状态 | server 的 review-orchestrator、run-snapshot、observability 测试，outputs 各 publisher 测试，store schema/database tests | 一个 batch 一份结果，多 receipt 关联，失败不关闭旧问题 |
| 负载与恢复 | 独立集成/benchmark 场景 | 操作次数、query plan、命令数/字节、重启状态、版本信息和完整日志 |

纯策略测试使用 fake clock，不 sleep 120 秒或等待真实午夜。并发测试用 barrier/latch
控制竞争点，不依赖 CPU 调度“刚好碰撞”。Redis 过期/续锁测试使用真实时间，但采用
显式状态观测、宽裕截止时间和隔离服务；不能只把系统时间 mock 掉就声称 TTL 已验证。
测试临时数据使用临时目录；agent 会话产生的脚本、日志、基准结果统一写入 `build/`。

## 2. 配置与时间

| ID | 输入/边界 | 预期 |
| --- | --- | --- |
| C01 | 三层全部缺省 | delay=120，全天可启动，时区 UTC；自动并发缺省 1 |
| C02 | global=300，defaults=180，instance=0；任一层只填 schedule | instance delay 为 0；只填 schedule 不重置继承的 delay |
| C03 | 下层只填 delay | 完整继承上层 schedule |
| C04 | 下层设置另一 schedule 或 rules=[] | schedule 整体替换；空规则列表解除全周限制，不与父层求交或按组追加 |
| C05 | 负数、小数、NaN/Infinity、超时间戳范围 delay，非法时区、未知子字段 | 配置阶段明确拒绝；错误指向对应层字段 |
| C06 | `9:00`、start=`24:00`、`24:01`、`10:60`、start=end、缺少端点 | 拒绝；end=`24:00` 合法，所选日全天使用 `00:00–24:00` |
| C07 | 多组重叠、相接、重复和跨午夜/跨周窗口，组顺序改变 | 周内归一化后并集一致，无组优先级；重复配置不产生重复启动 |
| C08 | `per_workspace_concurrency>1` 或多 consumer 配置版本不一致 | 自动路径迁移错误/拒绝领取，不能静默绕过串行限制 |
| C09 | days 含 mon 至 sun、重复星期、未知枚举/数字/缺省或空 days | 七个小写枚举正确映射、重复去重；非法或缺失 days 拒绝，不依赖 JavaScript Sunday=0 约定 |
| C10 | rules=[]、rules 缺失、组内 windows=[]/缺失、旧平铺 schedule.windows | 仅 rules=[] 解除限制；其余拒绝，旧草案形状不能静默变成全天开放 |
| C11 | 只选 sat/sun 的 `00:00–24:00`，另一个组只选 wed | 全天仅在所选日生效；其余日期未覆盖时禁止启动；24:00 转成本地次日零点 |
| T01 | accepted=10:00:00，delay=120，now=10:01:59.999/10:02:00 | 前者不可领取，后者可领取；attempt 仍从首次实际执行开始计数 |
| T02 | commit 时间早于/晚于服务器、重复投递、进程重启 | 使用首次成功入队时间；不重新开始等待 |
| T03 | 同来源 key 的 A 到期、B 尚未到期 | 仅 A 可启动；等待 B 不无限延后 A，不能让 B 提前加入 |
| T04 | A/B 都到期，worker 此刻释放 | 启动时合并 A+B，保留各自接收时间 |
| T05 | `[02:00,04:00)`，now=02:00/03:59:59.999/04:00 | 前两者允许，04:00 顺延下一窗口 |
| T06 | 多段窗口中间空隙、23:00–07:00 跨午夜 | 计算最早下一允许时刻，午夜属于同一跨日区间 |
| T07 | delay 到期正好落在关闭端点 | 顺延下一窗口，不能仅以 delay 到期忽略日历 |
| T08 | Asia/Shanghai 与 UTC，同一 instant；改变宿主机 TZ | 各按配置判断，宿主机 TZ 不改变结果 |
| T09 | America/New_York 秋季重复 01 点、窗口 01:15–01:45 | 两段实际 UTC 区间均正确；同 batch 不因回拨执行两次 |
| T10 | 春季跳过 02 点，窗口 02:15–02:45；另有 01:30–03:30 | 前者当天无有效时刻；后者覆盖真实存在的区间；不把 02:15 推到窗外的 03:15 |
| T11 | 非整小时 offset、半小时 DST、日期跳过与跨年 | 下一边界不循环、不逐分钟扫描，不假定每天固定 86400 秒 |
| T12 | 服务错过整段窗口后重启 | 只计算当前/下一有效窗口，不补跑每个过期 timer |
| T13 | 准备前窗口刚关闭，或任务运行中窗口关闭 | 尚未开始的释放 reservation 并延期；已运行任务允许完成 |
| T14 | failure backoff 到期在窗外，dead requeue | attempt 重试应用当前窗口；首次 delay 不重新计时；成员不重组 |
| T15 | 修改 schedule 后重启，old delay 已持久化 | schedule 头分批重算；未重算的不得执行；旧首次 delay 保留 |
| T16 | 系统时钟前跳/后跳，事件唤醒与 timer 同时触发 | 重新检查绝对时间，单实例调度循环不重入，无提前领取 |
| T17 | 用户示例：mon–fri 的 00:00–13:00、18:00–24:00，sat/sun 全天 | 工作日 12:59:59.999 允许、13:00 关闭、17:59:59.999 关闭、18:00 开放；周末任意时刻允许 |
| T18 | 上述示例的周五 24:00、周日 24:00、下周一 13:00 | 周五 18:00 至下周一 13:00 连续开放，跨午夜/跨周不重复启动；周一 13:00 关闭至 18:00 |
| T19 | days=[fri] 或 [sun]，窗口 23:00–07:00，次日不在 days | 分别延续到周六/下周一 07:00；06:59:59.999 允许，07:00 关闭，不能按次日星期截断 |
| T20 | 只在周一 02:00–03:00 可用，当前为周一 03:00 或周二 | 直接定位下一周一，不每天空唤醒或把本周无窗口当永久不可用 |
| T21 | UTC 周日但 Asia/Shanghai 已是周一，只配置 mon 窗口 | 按配置时区的本地星期匹配，不能用 UTC weekday |
| T22 | DST 前后每周同一星期/小时，全日窗口遇到 23/25 小时日 | 按本地日历推进；下周边界不机械加 604800 秒，全天不是固定 24 小时 |
| T23 | 周计划唯一窗口在本周 DST 缺失时刻，下一周该窗口实际存在 | 跳过本次，返回下周真实窗口；不限制为七天 UTC 搜索或陷入循环 |

## 3. 提交来源、顺序与 VCS 完整性

下表 A/B 表示不同提交来源分组键；P4 的 User 或 Client 任一变化都算不同来源。

| ID | 场景 | 预期 |
| --- | --- | --- |
| B01 | A1,A2,B1,A3；通知乱序 | 按 VCS 历史分成 A1+A2、B1、A3；不把 A3 跨 B1 合并 |
| B02 | 中间 B1 只改 exclude 文件 | B1 仍为连续性屏障；它自身可记录 skipped |
| B03 | workspace/trigger/repo/ref/P4 view/SVN root 任一不同 | 不合并；key 不能因路径/分隔符/凭据变化意外碰撞 |
| B04 | 分组字段缺失、来源明确脱敏的 email、损坏编码、同名不同邮箱 | unknown 不合并；排除判定明确允许后独立审查，不用内置账户字符串黑名单判断机器人 |
| B05 | 重叠 push、同 delivery 重试、已完成成员再次通知 | 成员只登记一次，首次时间不变；receipt 关联到正确已有批次 |
| B06 | 新提交在元数据读后、seal 前到达 | CAS 拒绝旧版本或仅封存已验证前缀；新成员保留且可继续合并后续批次 |
| B07 | 已封存/重试中的成员与新提交同来源 key | 旧 batch 不变，新提交进入下一批；不能改变失败重试的 diff |
| B08 | 超过 50 成员、元数据超过 1 MiB、超文件/patch 限制 | 有界拆分、cursor 前进，无丢尾；单提交超限有解释 |
| B09 | 每页边界都是同来源 key，下一页首项为另一来源 | 正确衔接；元数据读取有界但不错误跨来源合并 |
| B10 | 核验发现中间提交未收到通知；迟到通知在前批完成后到达 | 缺口是屏障；迟到成员不丢失，单独补审，不重写前批结果 |
| G01 | author 与 committer/pusher/sender/平台账号全部不同 | key 用来源命名空间与 commit author name+email；事件 author 不覆盖 VCS 记录 |
| G02 | .mailmap 映射、大小写差异、Unicode 名称 | 使用原始 `%an/%ae` 精确比较，不套 mailmap 或大小写折叠 |
| G03 | 一次 push 内多作者，payload commits 为空/被截断 | 从固定端点有界展开并拆批；不能仅分析 payload 最新部分 |
| G04 | GitLab 超 20 commits、GitHub 超 2048 commits、Gitea/Forgejo 无完整性证明 | 不把 webhook 数组作为完整历史，分页核验覆盖范围 |
| G05 | 日期乱序、分支分叉、直接 parent 不匹配 | 不依赖日期/queue seq 排序，非直接父子不合并 |
| G06 | merge、octopus merge、侧分支多作者 | merge 独立，完整审查相对第一 parent 的净变更；不伪称所有变更由 merge author 编写 |
| G07 | force push、相同 SHA 出现在不同历史世代 | 不跨世代合并；固定 before/after，不能替换为当前 HEAD |
| G08 | 浅仓库、端点不可达、deepen 不允许或耗尽 | 明确阻断/失败；不省略旧提交，也不扩成全仓历史 |
| G09 | before/after 全零的 branch 创建/删除、tag | 保持既有跳过/分类语义，不进入自动批次污染队列 |
| G10 | 先改后修复/撤销、重命名、删除、submodule gitlink | 净 diff 与固定 head 一致；不拼接旧坐标 patch，不递归拉全子模块 |
| G11 | 同邮箱不同 name、同 name 不同邮箱、改名但邮箱不变 | 原始二元组不同则分批；不为了减少批次数而自动归并别名 |
| G12 | 有效 noreply 邮箱、同平台账号关联多个邮箱、两个提交记录完全相同的共享身份 | noreply 不一概视为缺失；平台账号不覆盖原始 key；相同记录可合并但不声称同一自然人，也不直接产生 mention |
| P01 | 同流 User 相同、Client 不同；同 Client、User 不同；二者均同 | 前两者必须分批，第三种才可按连续性合并；不能以分析 client 替代来源 Client |
| P02 | payload 缺 user/client 或与 VCS 不一致 | 后台批量读取 submitted metadata；记录作者与事件操作者分别保留，不混拼，也不用配置服务账号填作者 |
| P03 | submitted CL 数字有空洞、pending/shelved CL、其他 depot 提交 | 只按指定源范围的 submitted 历史判断；无关占号不制造错误相邻关系 |
| P04 | A 修改 f，A 下一 CL 只改 g | 合并 diff 同时覆盖 f 和 g，不能仅 describe 最后 CL |
| P05 | add/edit/delete、move/add+move/delete、binary/type change、只改属性 | 真实 diff2/describe fixture 解析正确；缺端点不当作空结果 |
| P06 | 文件含空格、Unicode、`@/#/%`、超 argv 上限 | 安全编码和有界参数分块；不逐成员一个请求，也不打印凭据 |
| P07 | transport/auth/permission 失败、stdout 含网络错误字样 | 用实际诊断分类；重试耗尽明确失败，stdout 内容不误触发 retry/空审查 |
| P08 | User、ImportedBy、trigger 操作者分别不同；历史 User/Client spec 已删除 | key 使用 changelist 记录的 User+Client；不查询当前 spec 替换历史来源，不声称已认证自然人 |
| P09 | User 完整但 Client 缺失；换 Client 同时改变监控 view | 前者来源 key 不完整，不降级 User-only；排除明确允许才独立审查；后者同时受 Client 与源范围边界隔离 |
| P10 | 相同 depot 路径位于不同服务；User 大小写不同且 AICR 与服务端操作系统不同 | 来源命名空间区分服务；首版按记录精确比较，不能按客户端系统自动转小写 |
| P11 | 管理员修改已提交 changelist 的 User/Client，后台读到冲突值 | 未封存成员 conflicted，不合并且按字段证据判定排除；封存后仅追加诊断，保留观察与原快照 |
| P12 | alice@task-a 的 C1、alice@task-b 的 C2、alice@task-a 的 C3，全部在同一 depot | 分成三批；不能只按 User 合并，也不能先按 Client 过滤历史后把 C1/C3 合并 |
| S01 | author 账户相等/不同/缺失，XML 转义 | 同仓库内按原始账户精确比较；缺失独立，XML 用 parser，不回退到服务账户 |
| S02 | 全局 revision 空洞、其他监控路径提交 | 用范围内历史相邻性；不要求 revision 数值连续 |
| S03 | copy/rename/删除、peg revision、权限过滤日志 | 不跨 lineage 或配置根；partial 不证明连续，不退到 HEAD |
| S04 | 合并 r10+r12，r11 修改本范围其他文件/仅修改范围外 | 前者屏障；后者可合并但 diff 严格限定本范围 |
| S05 | property-only、文件撤销净空、损坏 XML/网络中断 | 可解释结果；损坏/失败不能标无变更成功 |
| S06 | 不同仓库同名账户；账户大小写/域前缀不同 | 来源隔离，不删域前缀、不推断 LDAP/SSO 别名，不以展示名或邮箱替换 author |
| S07 | 同一 revision 的 svn:author 被修改或删除 | 固定 revision 不代表作者不可变；首次读取缺失时独立，后续观察冲突按快照规则处理 |
| I01 | name/email 或来源含分隔符，Unicode 字符视觉相似、首尾空格不同 | 有版本结构化 key 不碰撞；只剥协议封装，不做 Unicode 折叠或任意 trim |
| I02 | 来源已入元数据页，重启后重试；随后字段变化或规则版本升级 | 三后端保留 sourceSnapshot 和分组/排除版本；重试不重新组批，重复通知不新增成员 |
| I03 | 大批同作者提交、多 Client、重复投递和长时间等待 | 批读复用、P4 按 Client 分组；不逐提交拉账户资料或定时刷新作者；不声称已检测未再读取的变化 |
| I04 | 相同 sourceKey，但 blame/事件操作者指向其他人；SVN payload 只有 author | 分别表达来源与责任归因，仅明确操作人证据填操作者；P4 批次展示共同 User+Client 并保留逐成员证据 |

### 3.1 跨通知合并与不重复触发

基准采用设计 §5.2.1 的通知及时间：N1 覆盖 A1–A3，N2 覆盖 A4–A5，N3 覆盖 B1；
全部于 18:00 前到期，大小未超预算，没有来源排除。构造真实父子/范围元数据，经 HTTP
入口和实际队列消费到可计数的审查 handler；正常成功路径禁用故障注入，避免把重试
次数与重复调度混在一起。N 场景的成员/批次/关联断言在三个队列后端共享执行。

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| N01 | 用户基准，三通知进入延迟队列，18:00 启动并顺序完成 | 仅两批 [A1…A5]、[B1]；handler=2、结果=2、每成员归属次数=1；A diff=A0→A5、B diff=A5→B1；N1/N2 同 run，N3 另一个 run |
| N02 | N1/N2 原 delivery 重投递；不同 deliveryId 通知覆盖相同范围，均在 seal 前 | 成员仍为原集合，firstAcceptedAt/delay 不变，仍仅两次分析；receipt 可增加关联，但不能每通知建 job |
| N03 | A 批次已封存/运行/完成，新通知覆盖 A1…A5 并新增 A6，分别覆盖三种状态 | 旧成员只关联原 batch，未处理 A6 独立候选；旧 A1…A5 不再进入任何新批次，不回退 pending |
| N04 | N2 先展开，N1 后展开；范围重叠、delay 不同，较早通知尚未到期或发生时钟回拨 | 按 VCS 历史排序，以持久接收顺序确定最早覆盖通知的时间/delay；不能只查询已到期通知后用较短 delay 提前执行，也不依赖展开顺序拆批 |
| N05 | N1/N2 位于通知页两端，元数据页在 A3 结束；关联页另有重复项，批次预算足够 | 保存 cursor 继续准备，到 A5 才封存；通知/分页边界不制造三批；没有提前调用 handler |
| N06 | 两 producer 重叠入队，两 consumer 同时组装/封存用户基准 | 每成员仅一个 batch 归属，A 只有一个 outbox 和执行 job，B 按流顺序执行；没有重叠 active batch |
| N07 | 重复唤醒、通知展开完成回调、outbox 重投递、BullMQ 完成 job 已清理 | 只 sealed batch 能调用 handler；终态成员/batch ledger 仍防止再次审查，N1/N2 不各自生成 fallback job |
| N08 | 组装读完 N1 尚未读 N2 时崩溃；另测 seal 后、dispatch 后崩溃 | 前者恢复固定截点/cursor 并完成 A1…A5 组装；后两者恢复原 batch/outbox，不另建 A1…A3 或 A4…A5 的执行批次 |
| N09 | 通知全覆盖已有 completed/skipped/dead 成员，或部分覆盖旧成员 | 全覆盖只补可查关联，0 个新 run；部分覆盖仅新增未归属成员，终态不复活、统计不重复 |
| N10 | N1 已到期但 N2 未到期；另测 N2 在首批封存后才接收 | 首批可为 A1…A3，下一批仅 A4/A5；不让成员提前分析、不无限等待新通知，也不再审整个 A1…A5 |
| N11 | B1 没有任何通知覆盖；仅收到 P4 C3/C5 或无可信范围的 Git head 通知 | 不发现 B1、不把 C1/C2/C4 或当前 HEAD 擅自加入分析；用户基准中的 B1 必须由 N3 提供 |
| N12 | P4/SVN 用各自单 CL/revision 的六条通知覆盖六个成员；P4 B 与 A 同 User 不同 Client | 同样只生成 [A1…A5]、[B1] 两批；P4 来源判定始终包含 Client，跨通知不放宽来源/流边界 |
| N13 | assemblyCut 固定后持续追加通知，含与旧成员重叠的范围 | 已验证前缀能封存，不因尾部 append 无限 CAS 失败；截点后新增成员留待后续，重复覆盖只补关联 |
| N14 | 一个 receipt 覆盖超过批次预算的连续成员；另有大量重叠 receipt | 按真实条数/字节预算拆分且不漏尾；receipt 可指向多批，批次/事务不保存无限 receiptId 数组，关联按页复用 |

### 3.2 来源排除

X 场景为待实施测试；涉及持久状态、游标和恢复的断言在 memory/SQLite/Redis 共享执行，
不以 matcher 单元测试代替真实入口与队列接线验证。

| ID | 场景 | 预期 |
| --- | --- | --- |
| X01 | 全局/defaults/instance 分层设置；只改 delay/schedule；exclude_sources=[] | 最近显式数组整体替换，缺省继承；[] 清除；不拼接父规则或意外清除排除 |
| X02 | 错 vcs/字段、空 match、重复 id、空 pattern、glob/regex 同填、未知参数 | 配置阶段拒绝并给出完整路径；不能吞掉规则继续运行 |
| X03 | 同规则 user+client；两个独立的 user/client 规则；规则重排 | 前者 AND、后者 OR；重排不改变排除结果，规则 id 可追踪 |
| X04 | glob 的整串、*、?、**、点、方括号、斜杠、域账户反斜杠、中文/emoji | 无 basename/路径归一化/brace 语义；? 按码点，** 等价 *，其余按字面量 |
| X05 | regex 子串/锚定、Unicode、ignore_case=true/false、连续调用同 matcher | 搜索/整串语义明确，无 g/y lastIndex 漂移；匹配忽略大小写不改变 sourceKey |
| X06 | 正则语法错误、lookaround/反向引用、复杂重复量词、超规则/字节预算 | 不支持或超预算在配置阶段拒绝；支持的复杂式在 RE2 有界运行，不降级 JS RegExp |
| X07 | Git author=人类、committer=CI，pusher 为第三人；mailmap 修改 | 显式 committer 规则可排除；只配置 author 规则不受 committer/pusher 影响，原始字段同页读取 |
| X08 | P4 user 或 client 命中，配置分析账户/分析 client 恰好符合排除模式 | 只匹配 changelist 字段；不因服务配置误排除真实提交 |
| X09 | SVN author 命中/不命中，服务登录账户命中模式 | 只匹配 svn:author；账户大小写及域前缀遵从显式 matcher，不猜别名 |
| X10 | 已知 User 命中用户单字段规则但 Client 缺失；规则只依赖缺失 Client | 前者可排除；后者 unknown，有界重试/待处理，无 LLM、无假 excluded |
| X11 | AND 中一个 false+一个 unknown；OR 中一个 true+一个 unknown；所有适用规则 false | 分别明确不匹配、明确排除、允许；其他 VCS 规则不制造 unknown |
| X12 | 字段冲突/损坏/超长；规则需要该字段或只依赖另一个完整字段 | 不截断/空串替代后匹配；逐字段三态判断，unknown 耗尽后 dead，不偷偷分析 |
| X13 | A1、被排除 X、A2；X 与 A 甚至具有同分组 key 但 committer 不同 | A1/A2 分批；元数据查询不按排除规则裁剪；净 diff 不跨 X，X 不变成无问题 review |
| X14 | 一个 Git push 混合人类/bot，另一个 push 全排除 | 逐成员保留、允许成员分析；全排除返回可查 receipt 和 skipped 原因，没有虚构 run/token/cost |
| X15 | merge 含侧分支多人；force-push 范围含允许与排除成员/被移除历史 | merge 按其记录决定整条范围；rewrite 不用 head 身份代表全范围，混合/不完整则 exclusion_scope_conflict 待处理 |
| X16 | skipped 批量写入前/后崩溃、重投递、后续迟到成员、整页均排除 | 状态与游标原子一致，保留分隔/去重记录，不建 run/job/outbox；按页写入并让出调度机会 |
| X17 | 待决定成员遇配置版本改变、已封存批次重试、清空排除规则 | 前者重算判定；封存/终结成员保持版本，不重组、不自动复活 skipped；时段仍使用当前配置 |
| X18 | 来源排除与文件 include/exclude 同时存在；receipt/API/IM/managed issue | 来源排除先于完整代码/diff 准备，不发 review/无问题消息、不标 reviewed、不关闭问题；字段证据仅按权限展示 |
| X19 | PR/MR、triage、manual replay；自动队列重复通知 | 仅自动提交套用来源排除；显式手工 replay 独立，重复 webhook 不复活终态 |
| X20 | 100k pending / 1k workspace、最大规则预算、复杂 regex/长字段、重复来源 | 同策略编译一次、按 vcs 复用、分块让出事件循环、三后端读取和写入有界，不逐提交查账号；记录实测成本 |
| X21 | Node 下限、Windows/Linux、镜像各支持架构、原生依赖离线安装/打包后启动 | RE2 绑定实际加载并发现用例；缺产物不跳过规则，安装许可最小化，不把下载失败当产品匹配通过 |

## 4. 队列、恢复与并发

以下 Q 场景在三个后端执行共享逻辑断言；不适用的持久性项明确记录，例如 memory
重启丢失是其既有边界，而非一次“恢复通过”。

| ID | 场景 | 预期 |
| --- | --- | --- |
| Q01 | 首次延迟 enqueue、getJob、stats、dequeue | queued 可见且 notBefore 一致，未到期不会 running |
| Q02 | 两 producer 同时投递同事件/重叠成员 | 原子唯一，首次时间稳定；202 返回可解析的持久 receipt |
| Q03 | SQLite 锁/磁盘写入失败，Redis 断线 | 不返回成功 202，不把后端错误转为空队列 |
| Q04 | 两 consumer 同时 claim/封存同前缀 | 仅一个 lease owner；成员至多归属一个封存 batch |
| Q05 | 全局并发 1、2 与多进程 consumer | 总运行数不超过配置值，不是每进程各允许 N |
| Q06 | 忙 workspace 在队首，另一个 workspace 已到期 | 后者能推进；无 moveToWait/claim 忙循环 |
| Q07 | 单大 workspace 与许多小 workspace 持续入队 | 公平队列有界轮转，释放槽位后其他 ready workspace 获得机会 |
| Q08 | 同 workspace 自动提交与 PR/manual 同时启动 | 共用执行目录不发生并发写；PR 不新增低谷日历限制 |
| Q09 | batch seal 成功、outbox 未投递就崩溃 | 重启投递同 batch，成员不丢失、不回到任意新合并 |
| Q10 | BullMQ add 成功、outbox ack 前崩溃 | 确定 jobId 去重；BullMQ job 已清理时仍由 batch 终态阻止重复审查 |
| Q11 | 运行时间超过 SQLite/BullMQ 初始 TTL | 续租保持所有权，不并发重领；不能用过长 TTL 逃过测试 |
| Q12 | 暂停续租/kill worker，stalled checker 与任务完成竞争 | 回收同 batch；过期 token 的 complete/fail/renew 均被拒绝 |
| Q13 | 延期至下个窗口、容量等待、关闭/重开 | 不消耗 attempt，不长时间占用执行槽位，不产生单任务 timer |
| Q14 | transient retry、永久错误、达到最大次数 | 只有统一 queue 级 retry；稳定 batchId/成员，dead 保留查询/requeue 信息 |
| Q15 | graceful shutdown 与新 enqueue、active handler 交错 | 停止领取，已接收持久事件可恢复；资源关闭不丢 outbox |
| Q16 | 旧 SQLite schema、有 delayed/retry/running/dead job | 迁移保留数据；旧字段缺失回退合同明确，重复 migration 幂等 |
| Q17 | 配置/源范围变更、workspace 删除、consumer 版本不一致 | 明确阻塞/迁移状态，不能错路由或按过期窗口启动 |
| Q18 | 通知丢失、Redis reconnect、SQLite 跨进程新事件 | 兜底索引校准发现；恢复延迟有界，future payload 不被周期全读 |
| Q19 | queue backend 与 observability/cache/object 组合变化 | 调度真相只在 queue 后端；可选投影失败可重放，不破坏成员唯一性 |
| Q20 | rabbitmq 配置 fallback，postgres 预留配置 | 如实显示 effective memory 或现有不支持错误；不出具虚假的外部后端通过证据 |

## 5. 服务接线、输出与回归

| ID | 场景 | 预期 |
| --- | --- | --- |
| E01 | 各 provider 的有效自动提交 HTTP 请求 | 202 前已原子接收；delay/window 前审查和 VCS 准备依赖调用数为 0 |
| E02 | 新版 CLI serve，不注入自定义 jobHandler | 默认 worker/scheduler 真正启动并完成任务；不能只测 bootstrap 返回 queue 对象 |
| E03 | 签名错误、repo mapping 不匹配、越权 workspace | 不入队；既有认证和状态码合同不退化 |
| E04 | 连续三次 push 在旧 dedup key 相同 | 三者都可追踪到成员/批次；按 N01 验证跨通知分组，不存在 latest-only 丢失或每通知执行一次 |
| E05 | 一个 receipt 拆三批、三 receipt 合一批、重复 delivery | 双向分页关联正确；新增 receipt 不重复触发旧成员，不返回永远无结果的 runId |
| E06 | PR/MR request、comment re-review、issue triage、manual/replay | 原有路由/去重/返回合同保留，不套自动 delay/schedule |
| E07 | 批次多作者特殊范围与普通同来源范围 | 标题/范围/链接真实；head URL 不冒充整个 compare；作者提及可验证 |
| E08 | compression、agent repair、模型 fallback、fetch_more_context/blame | 所有 pass 固定 batch head，成员不变，bundle 仍按实际 attempt 正确物化 |
| E09 | merged run 被多个 receipt 引用 | usage/cost/run count 只算一次，等待耗时与执行耗时分列 |
| E10 | 无净变更、文件全排除、VCS 不可用、配置阻塞 | 分别得到可区分状态；失败/等待不构成“零问题完成” |
| E11 | 已完成结果在 store 投影前 crash | 同 runId 重放投影，日汇总幂等，UTC 分区正确 |
| E12 | 部分通道成功、下一通道失败、POST 响应丢失 | 成功回执复用；未知副作用不盲目重复发送，不重复计费审查 |
| E13 | 失败报告或范围不完整导致问题指纹未出现 | 不关闭/mark_resolved；保留 skipReconcile 和模型明确确认要求 |
| E14 | Gitea/GitHub PR/MR summary + managed issue 全生命周期路径 | 逐路径覆盖旧问题信息、范围/祖先 guards、resolution analyzer 错误和同范围重复身份清理 |
| E15 | receipt API、queue API、metrics 与日志 | 认证/作用域隔离、凭据脱敏、低基数 label；不泄露其他 workspace 元数据 |

## 6. 性能验收

以下为验收目标，尚无实测结果。以结构与操作数量为回归门禁，吞吐/耗时记录为基准
数据；避免依赖开发机速度写脆弱的毫秒断言。

| ID | 数据/负载 | 可重复断言 |
| --- | --- | --- |
| F01 | 100k pending，1k workspace，全部未来到期；无 active job/outbox retry | 同进程只保留一个调度 timer；跨进程校准不超过每 30 秒一次；无 VCS/LLM 调用 |
| F02 | 1 条 ready + 100k future | 只读有界 head/成员页，不随 future 总量解析全部 payload；SQLite query plan 使用调度索引 |
| F03 | future 从 10k 增至 100k，ready 数量不变 | 候选/metadata/payload 读取条数不按总积压线性增长；记录实际 heap 操作或 SQL/Redis 命令计数 |
| F04 | 64 workspace heads、256 metadata records、1 MiB 边界 | 所有 read/写事务/Lua 单次处理受条数与字节上限约束，不使用大 OFFSET/全量 key 扫描 |
| F05 | 同流 1000 提交通知，来源连续，含重复和重叠范围 | 范围、元数据与关联按页批读/写，命令数随未缓存页数增长；不每通知重拉全范围，分组不受通知边界影响 |
| F06 | worker 全满、窗口全关、队首 workspace 被锁 | 不逐 job 反复 claim/requeue；任务完成或边界触发才推进，其他 ready workspace 不饥饿 |
| F07 | 大小 workspace 混合持续入队，concurrency=1/4 | 有界公平轮转，global/workspace 上限不突破；报告最长等待和 oldest pending age |
| F08 | metadata 大页、超大 commit、P4 参数上限 | 有界分块、可解释超限，不全仓拉取、不静默截掉末尾成员 |
| F09 | 周期更新同一 workspace head、丢通知后恢复 | memory stale heap 有界清理；Redis/SQLite head 不积累无限重复候选 |
| F10 | SQLite busy、Redis reconnect、租约超时与入队突发 | 退避避免忙循环；恢复后吞吐可继续，无漏成员、重复并发或 false-empty |
| F11 | 同一周计划从 2 组增至多组，归一化后可用并集不变，pending 数相同 | 日历编译一次并复用；队列/VCS 拉取次数和 timer 数不随组数增长，不为每组扫描 pending |

基准记录包含 Node/依赖/后端版本、硬件/容器限制、数据规模、成员字节分布、query plan、
SQL/Redis/VCS 命令数、事务/Lua 最大批量、峰值内存、吞吐与 p50/p95/p99 等待/领取时延。
fixture 初始化成本与稳态调度成本分开。日志和中间报告写入 `build/logs/auto-commit/`。

## 7. 发布前完成标准

- 所有适用 C/T/B/G/P/S/Q/E 场景有具体测试或实测证据，未完成项不能仅标“代码看起来支持”。
- 三个队列后端通过同一逻辑合同；Redis 延迟、Lua、续锁、断连以真实服务验证。
- Git/SVN 使用真实本地历史；P4 的批量历史与端点 diff 至少有真实服务 smoke。
- F 类结构/调用次数门禁通过，规模基准有数据，无未经测量的“高性能”结论。
- 最后一次编辑后完整 runtime gates、双语文档站 gates（适用时）通过，测试实际发现数量有记录。
- 迁移、停止旧 timer、版本隔离、恢复和回滚已演练；当前无法支持的 RabbitMQ/PostgreSQL
  不算作“已完成后端”，memory 的非持久性对外可见。
