# 外部成员目录与热加载设计

状态：待实施，2026-09-28。配置字段和文件 schema 均为提案。
本设计属于 [IM 开发计划](../../Plan.md)，与[回调授权](im-integrations.md#6-会话发现与命令授权)独立。
当前 `member_directory` 仅支持飞书应用的 API 群目录。
执行步骤为 [IM-06–08](im-implementation.md#im-06-目录-schema-与纯解析)，断言为[验收矩阵 D 组](im-acceptance.md#4-文件目录-d01d16)。

## 1. 文件与绑定

采用 UTF-8 YAML 或 JSON，使用同一个严格 schema，扩展名决定解析器。
YAML 禁止重复 key、自定义 tag 和无限 alias 展开；JSON 同样拒绝重复 key，避免不同解析器选择不同身份。
首期不支持 CSV、远程 URL、可执行脚本、目录递归扫描或任意文件 include。
使用仓库已有 YAML 依赖，增加解析限制，不为文件监视引入守护进程。

一个文件可含多个独立 `directories`，每个目录绑定一个平台身份命名空间和一组声明的群成员。
输出频道明确选择 `directory_id`，不自动搜索所有目录。
同一个人可以在不同目录出现，平台身份不能跨目录推断相等。
运行人员负责文件中群成员和 ID 的正确性；文件不是平台签发的实时成员证明。

拟新增配置：

```yaml
member_directory:
  source: file
  path: ./private/im-members.yaml
  directory_id: engineering-wecom
  identity_scope:
    kind: wecom_corp
    id: ww_example
  watch: true
  debounce_ms: 300
  poll_interval_seconds: 30
```

应用频道从 connection 身份推导允许的 scope，显式配置若冲突必须报错。
webhook 频道没有可查询的身份，需要管理员显式配置 scope 并在测试群验证。
`path` 相对主配置文件的 baseDir 解析，数据库实体也使用这一 baseDir；
不相对 run 目录、评审 checkout 或当前 cwd 解析。支持管理员配置的绝对本地路径。
新增可选 `allowed_root` 也按 baseDir 解析；缺省为主配置文件父目录（即 baseDir）。
绝对 path 在该根外时必须显式配置相应受信根。每次读取比较根目录和目标文件的真实路径边界，
包括直接路径、`..` 和符号链接；同一文件但 `allowed_root` 或 reload 策略不同的视图独立读取。
容器采用只读挂载。数据库配置写权限继续受管理员权限控制；管理 UI 不提供任意文件下载。

旧 API 目录 `{chat_id, cache_ttl_seconds}` 保持兼容；新 API 写法可显式 `source: feishu_api`。
file 来源不接受 `cache_ttl_seconds`，poll 是检查文件变化的周期，不是飞书 API TTL。
`watch: false` 关闭事件监视但保留定时校验；必须保证仍能自动 reload。
拟限制 debounce 为 50–2000 ms、poll 为 5–300 秒。默认值是设计选择，后续以测试测量调整。

## 2. 通讯录 schema

```yaml
version: 1
directories:
  engineering-wecom:
    platform: wecom
    identity_scope:
      kind: wecom_corp
      id: ww_example
    members:
      - key: alice
        display_name: Alice Zhang
        aliases: [张三]
        emails: [alice@example.invalid]
        vcs_accounts:
          - provider: github
            source_trigger: github-main
            username: alice-dev
        mention:
          type: wecom_userid
          id: alice_zhang
```

| 字段 | 约定 |
| --- | --- |
| `version` | 必填整数 1；未知版本拒绝整次 reload，不能猜测兼容 |
| `directories` | 必填非空映射；稳定目录名供配置引用 |
| `platform` | `wecom` 或 `feishu`，必须匹配频道能力 |
| `identity_scope.kind/id` | `wecom_corp`、`feishu_app` 或 `feishu_tenant` 的明确命名空间；不包含 secret |
| `members` | 数组，允许显式空数组作为清空；不是“空数组就沿用旧目录” |
| `members[].key` | 目录内稳定唯一的本地键；不等同平台用户 ID |
| `display_name` | 可选显示名，只做匹配证据/展示，不可成为授权身份 |
| `aliases/emails` | 可选数组，规范化后去重；重复到不同人员时构成匹配歧义 |
| `vcs_accounts` | 可选精确账户关联；provider 与 source_trigger 均必填，避免不同 Git 服务器同名用户混用 |
| `mention.type/id` | 必填的唯一投递身份，按下表验证；不接受任意 HTML/Markdown、all 或 @all |

| 目录/身份 | scope 要求 | 渲染与限制 |
| --- | --- | --- |
| `wecom_userid` | `wecom_corp` | 企业内成员 userid；仅在该发送 API 支持时渲染 `<@userid>`，应用通知收件人与 @ 分开处理 |
| `wecom_mobile` | `wecom_corp` | 仅传统 webhook text 的 `mentioned_mobile_list`；不能写进 Markdown 对象或用于回调授权 |
| `feishu_open_id` | `feishu_app` | 记录 open_id 来源 app_id；应用频道必须同应用，webhook 需管理员确认该来源的 ID 在目标群可用 |
| `feishu_user_id` | `feishu_tenant` | 只用于已验证支持 user_id 的发送表面；飞书外部群不使用 user_id @ |

首期飞书应用保持现有 open_id 渲染能力；选择不支持的身份类型时明确拒绝绑定，不能静默伪装成功。
飞书 webhook 的卡片按其卡片协议渲染 `at`，不把 text 的 `user_id` 属性直接套到 JSON 2.0 卡片标签。
内部 `ChannelUser.id` 改为不透明候选键或有类型的安全映射；平台 mention 由宿主查询原始类型后生成。
专用身份模型只返回候选键，不能输出手机号、平台标签或授权结论。

对已有 `user_mappings` 保留飞书 open_id 值的兼容；新增文件来源下提供 `author_mappings`，
目标为 member key。二者不能在同一频道混用；旧映射启用目录时仍须验证目标属于该目录。
文件关联不替换 VCS 平台自己的 issue assignee 解析，不改变 Git 原生频道的行为。

拟定资源上限：文件 4 MiB、每文件最多 64 个目录、合计 10,000 个成员；
每项 aliases/emails/vcs_accounts 分别最多 20 项，普通匹配字符串最多 256 字符。
ID 另按平台长度/字符约束校验；禁止控制字符和 mention 注入字符，不使用邮箱前缀拼接平台 ID。
这些是宿主资源预算，须在公开配置与测试中标为本地限制。
未知字段、重复 member key、同一 typed platform ID 对应多个人、跨 scope 类型或悬空映射拒绝发布快照。

## 3. 匹配和通知策略

只在 `mention_author: true` 时获取/使用目录；关闭后不触发目录读取、模型调用或 @all。
匹配输入增加可信 `sourceTrigger`，用于隔离文件内的 VCS 账户；输入来自运行事件，不能由 LLM 自行指定。
优先级为显式 `author_mappings`、带 provider/trigger 的精确 VCS 账户、现有确定性匹配、可选专用身份模型。
现有确定性匹配保留邮件黑名单、同一层歧义阻断、P4 提交工作区优先于共享账号及 guess 开关语义。
每个匹配结果必须属于本次选中的有效目录；最优层有多个候选时禁止降级猜测。

文件目录的 `guess_author` 默认 false，运维可显式开启；现有飞书应用默认行为保持。
缺失目录、无效快照、歧义、黑名单、模型失败不能退化为 @all。
只有已成功读取目录且确定 unmatched，并显式配置 `mention_fallback: all` 时才可走现有受控 fallback；
新示例一律 skip。显式空成员集合视为停用成员提醒，不触发全员提醒。
没有配置文件目录的旧 webhook 行为先保留，公开迁移建议采用验证过的目录或明确映射；
P2 的回归必须区分旧默认行为与启用目录后的严格身份校验。

仅手机号的企业微信记录不能驱动 Markdown @。选择该记录时采用一条有界 text 提醒加原报告，
只有确实需要提醒才多发一次；两次远端写入分别记回执和限速。
若没有配置/实现 text 补充通知能力，则拒绝手机号目录绑定，不能发送一个无效 Markdown 字段。
实际原生 @效果仍需真实群验收，API 成功不代表目标是有效群成员。

## 4. Watch 与 reload

使用 Node `fs.watch` 监视父目录，同时定时读文件摘要校验。
父目录监视用于应对编辑器的临时文件+rename 保存；定时校验覆盖 Windows、网络挂载、
容器挂载、缺少 filename 和漏事件情况。[Node 官方限制](https://nodejs.org/docs/latest-v22.x/api/fs.html#caveats)
说明不能只依赖 watch，也不能只盯原 inode。

reload 流程：

1. 事件按规范化绝对路径合并，300 ms debounce，持续变化最长等待 2 秒就尝试读取。
2. 同一路径只允许一个 reload 执行；执行期间的新事件只置 dirty 标记，完成后再读一次。
3. 验证路径和文件类型，读取前后比较 stat，限制文件大小，计算内容摘要；变化中则限次重读。
   周期检查读取有界内容摘要，不仅比较 mtime/size，覆盖同大小和同时间戳内容替换。
4. 严格解析并验证整个文件、所引用目录和绑定 scope，构造不可变快照。
5. 摘要不同才原子交换快照，generation 递增；相同内容不清缓存、不重复记录成功日志。
6. watcher error/close 后记录降级状态，定时校验继续；有界退避重新挂载 watcher。
   父目录删除重建也重新挂载，不忙循环。

路径读操作不执行内容。拒绝符号链接跳出管理员配置的受信目录；如容器配置卷需要 symlink，
只允许解析后仍在该受信根中的目标并逐次重验。目录路径或租户变更时使用新资源，不复用旧 scope。

| 状态 | 发布行为与恢复 |
| --- | --- |
| 首次文件缺失/无权限/格式不合法 | 目录 unavailable；报告继续但不 @，健康/管理状态说明原因，后续 watch/poll 自动恢复 |
| 写入中或原子替换间隙 | 有界重读；期间新匹配不使用已知可能过时的身份，旧快照仅供诊断或已开始的发送 |
| 已有目录后出现无效文件 | 保存 last-good 对象供诊断但不服务新的 @；不无限期沿用被删除成员；恢复合法文件后自动启用 |
| 有效 `members: []` | 原子安装空目录，立即停止新的成员提醒 |
| 删除/撤权/范围不符 | 标记 unavailable 并停止新提醒；错误日志只包含目录标识及错误码 |
| 显式去掉 `member_directory` | 固定配置规则生效，旧 generation 按租约保留资源；不能跨租约借用新配置目录 |

默认不提供 stale 身份容忍时间。保持 last-good 可诊断性与“不可使用已知无效身份”的行为分开。
报告本身无需因辅助目录故障失败；配置 schema 错误或绑定到不支持的身份类型则在配置发布时拒绝。

## 5. 生命周期、一致性和隐私

监视器按 baseDir/规范路径复用，只负责文件读取；目录视图按配置 generation、目录 ID 和 scope 隔离。
保留 reference count，最后一份租约释放后取消定时器、关闭 watcher、等待读取结束；
`unref` 防止辅助定时器阻止进程退出，dispose 之后不得安装迟到快照。
配置发布/预览不自动启动永久 watcher，候选校验使用一次性受控读取。
schema/scope 错误阻止发布；文件暂缺、无权限或读取失败只提供降级诊断，不让全局发布依赖单副本磁盘状态。

目录内容是一种动态辅助数据，不随任务执行配置 snapshot 固定。
一次报告在首次解析成员时固定目录快照，后续拆分消息与问题/summary 使用同一版本。
长评审尚未开始发布时可以使用最新目录；新的 generation 不能改变旧任务的目录路径或身份 scope。
多副本分别 watch 同一挂载并暴露 digest；不承诺同时切换，部署需分发相同文件并监控 digest 不一致。

发布日志只记录目录 digest/解析器版本，不保存完整目录。
恢复时已送达操作复用回执；待定操作若目录导致收件人/正文摘要变化，不用新 payload 重发旧 operation。
不能证明安全的情况保留 unknown，需遵守原发布恢复协议。
每次新的评审或明确新的发布操作才可重新解析成员；避免恢复途中替换通知对象。

文件建议由管理人员维护、只读挂载并列入本地 secret/PII 忽略规则。
成员姓名/邮箱/手机号不进入 metric label、日志、run artifact、普通 MCP 或主评审 prompt。
管理状态只显示目录 ID、digest、成员数、成功时间、最近错误码与 watch/poll 状态，
不提供默认全量成员查询。显式身份模型仅接收有界候选信息与不透明键，沿用已有预算和取消机制。

## 6. 必需回归与验收

- Schema：YAML/JSON 等价、重复字段、未知版本、超限、错误编码、同 ID 多人、无效 scope、空目录、注入字符。
- 匹配：精确账户命名空间、别名/邮箱歧义、共享 P4 账号、黑名单、模型返回不在目录内、禁止 all 提权。
- 平台：飞书卡片/text 的不同 @协议、外部群限制、企业微信 userid 与手机号 payload 的区别。
- 文件：原地写/截断/原子替换/删除重建、mtime 不变、watch 缺 filename/报错/漏事件、symlink 逃逸、无读权限。
- 生命周期：并发读和多次 reload、慢读取不覆盖新快照、有效→无效→有效、watcher 关闭与停机无泄漏。
- 集成：旧 API TTL 保持；旧 webhook 无目录行为；启用文件后实际 `publishSummary` 原生 @；
  新旧 generation、动态配置预览/发布、目录故障时报告仍发送、split 消息同快照、发送恢复不换人。
- 平台验收：使用管理员确认的真实测试成员，确认客户端收到 @；文件更新后下一次新发布读取新目录，
  Windows 与 Linux 本地盘测试之外，容器/网络挂载另记验证环境和观察到的延迟。

上述测试在实施时新增；本轮只有文档与草案引用检查，不声称热加载已运行。
