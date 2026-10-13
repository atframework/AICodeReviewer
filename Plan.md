# IM 与 Slack、Discord、Telegram 接入计划

本计划仅保留未完成项与验收出口；完成记录见 [M38](docs/ai/milestones/M38.md)、[M39](docs/ai/milestones/M39.md)。

## Slack、Discord、Telegram（真实平台验收）

2026-10-12 确认范围：发送审查结果及命令触发审查，不含按钮交互。
三种 Bot API 输出、HTTP 四命令、持久回复恢复、配置管理和双语指南已实现。
本地测试与真实平台验收分开记录，不能把 HTTP 替身视为真实平台通过。

- [接入规范](docs/design/slack-discord-telegram.md)：当前源码证据、方案取舍、配置、协议、授权和恢复边界
- [详细执行步骤](docs/design/slack-discord-telegram-execution.md)：依赖、逐文件任务、验证和最终使用文档交付
- [验收矩阵](docs/design/slack-discord-telegram-acceptance.md)：编号断言、故障注入、真实后端和平台验收
- [官方来源记录](docs/ai/sources/slack-discord-telegram.md)：本次查阅的接口及事实边界
- 可运行输出样例：[Slack](example/slack-app.yaml)、[Discord](example/discord-bot.yaml)、[Telegram](example/telegram-bot.yaml)

| 任务 | 执行范围 | 验收出口 |
| --- | --- | --- |
| SDC-10-live | 在专用 workspace/guild/Bot、公开 HTTPS 回调上逐平台验证安装、注册、实际四命令、报告显示、长任务终态与回滚；跨 readiness 刷新周期验证命令接收，无回复时取得客户端原始错误及回调状态 | L01–L03；Slack 按 HTTP/Socket Mode 核对命令投递、ACK 和应用开关；分别核验实际 slash 调用、命令定义与 inline 初始回复；元数据/readiness 和其他平台通过不能替代本平台命令验收 |
| SDC-13-live | Slack Socket Mode 跨 readiness 周期命令 ACK；核验应用开关回切到 HTTP | SM05-live；验证刷新期间与之后的实际 help/chat-id 回复、HTTP URL 与接收器模式一致；真实 review/report 验收继续保留 |
| SDC-11-live | 指定群/频道使用 conversation_users 批量授权；核验成员变化无需配置变更、错会话拒绝、status 归属和配置撤权 | A07、本地完整门禁及 L01–L03；平台认证上下文不等于当前成员目录，退群不自动取消已接受任务 |
| SDC-12-live | 按既有 config.yaml 的仓库映射核验精确 repo_ref 报告路由；部署并由用户验证，不扩展组织仓库清单或 GitHub 安装权限 | 配置内目标仓库映射明确；原有渠道保留；其他组织报告不进入新渠道；缺 Bot 权限或 chat_id 时保留未完成项 |

真实账户通过前保留执行步骤和验收矩阵。各断言当前代码、测试和证据限制见验收矩阵。

## 既有 IM 任务（继续保留）

设计与接口依据（长期保留）：

- [实施规范](docs/design/im-implementation-spec.md)：配置/模块/存储原子操作、状态机、默认值和恢复边界
- [验收矩阵](docs/design/im-acceptance.md)：编号断言、测试位置、故障注入和真实平台证据
- [集成、回调与重新评审](docs/design/im-integrations.md)
- [外部成员目录格式与热加载](docs/design/member-directory.md)
- [配置与目录草案示例](example/im-integrations-design.md)，不能作为当前运行配置加载
- [官方接口核查记录](docs/ai/sources/im-integrations.md)

### 本地剩余执行项

| 任务 | 当前证据与下一步 | 验收出口 |
| --- | --- | --- |
| IM-11、IM-17 | 命令持久 readiness、当前授权复查与固定 snapshot 已实现；补齐原 IM 动作/目录策略在真实重启组合中的逐项证据 | A08、X01、X03；不能用新三平台精确 actor 用例替代旧平台范围目录/按钮验收 |
| IM-14 | 已实现 queued 交接 ID 复用、忙 workspace 排除、执行窗口、实际阶段计数和暂时 IO 退避；保留原队列多进程交接/共享并发许可的组合验收 | R10–R13；本地 worker/store 断言与真实跨进程证据分列 |
| IM-13、IM-19 | 核验家族 provider、P4 depot 范围、SVN 作者及真实重启/多连接竞争 | V03–V05、R05、R16、X01–X10；用实际 adapter、fresh runtime 或独立连接证明边界 |
| IM-20、IM-22 | 逐行建立其余验收断言的代码、测试与执行证据映射，完成适用门禁 | 缺失断言保持未完成；全部验收完成后再退役本计划 |
