# IM 与 Slack、Discord、Telegram 接入计划

本计划仅保留未完成项与验收出口；已完成记录见 [M38](docs/ai/milestones/M38.md)。

## Slack、Discord、Telegram（待实施）

2026-10-12 确认范围：发送审查结果及命令触发审查，不含按钮交互。
本轮只制定计划；以下字段、适配器和测试尚未实现，不代表当前产品支持。

- [接入规范](docs/design/slack-discord-telegram.md)：当前源码证据、方案取舍、配置、协议、授权和恢复边界
- [详细执行步骤](docs/design/slack-discord-telegram-execution.md)：依赖、逐文件任务、验证和最终使用文档交付
- [验收矩阵](docs/design/slack-discord-telegram-acceptance.md)：编号断言、故障注入、真实后端和平台验收
- [官方来源记录](docs/ai/sources/slack-discord-telegram.md)：本次查阅的接口及事实边界
- [配置草案](example/slack-discord-telegram-design.md)：拟新增字段，不能作为当前运行配置加载

| 任务 | 执行范围 | 验收出口 |
| --- | --- | --- |
| SDC-00 | 核对并完成命令所依赖的原 IM-11/14/17 缺口；保留下方其余旧任务 | C01、A04、R05；readiness、当前授权、交接恢复可验证 |
| SDC-01 | 三平台类型/schema/capability、身份、secret、配置引用 | C01–C05；旧配置兼容，新字段有消费者 |
| SDC-02 | 平台发送结果、journal、outbox 原子接收与 sending/unknown 恢复 | O04–O07、R01–R08；不盲重发，不重复分析 |
| SDC-03 | Slack 主动输出、格式、bootstrap 接线 | O01–O07、G01–G02 的 Slack 用例 |
| SDC-04 | Discord 主动输出、格式、bootstrap 接线 | O01–O07、G01–G02 的 Discord 用例 |
| SDC-05 | Telegram 主动输出、格式、bootstrap 接线 | O01–O07、G01–G02 的 Telegram 用例 |
| SDC-06 | 三种 HTTP 协议、help/chat-id/review/status、持久执行及回复 | S01–S09、A01–A06、R02–R06；原 IM 前置项通过后启用 |
| SDC-07 | 管理 UI、预览/发布、热配置、旧平台回归 | C02–C05、G01–G04、R06；实际发送与预览一致 |
| SDC-08 | crash/重复/限流/撤权测试及真实 SQLite/PG/必要 Redis | R01–R08、G03–G04；fresh runtime 和独立连接证据 |
| SDC-09 | 双语三平台使用指南、可运行配置、平台注册资料和主题文档 | D01–D03；实际样例经 compiler/bootstrap 验证 |
| SDC-10 | 完整门禁、逐平台真实账户验收、保留限制后归档 | D04、L01–L03；跳过/未验收不得标完成 |

执行顺序及每步读哪些文件见详细步骤。全部新增项仍未完成；本地实现与真实平台验收分开记录。

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
| IM-11、IM-17 | 接收端仍可写入 `file-only` 请求；worker 未按当前授权复查排队及发布阶段。补 capability readiness 与当前策略校验，执行配置仍固定原 snapshot | A08、X01、X03；禁用/撤权后不调用 VCS、模型或新的发布 POST |
| IM-14 | 当前 scan 每轮默认领取 1 条并等待执行；dispatch 每次准备都增加序号；次数主要记录崩溃恢复。补同次交接身份恢复、忙 workspace 公平性、执行窗口与阶段尝试计数/暂时 IO 退避 | R10–R13；实际尝试计一次，等待不占许可；其他 workspace 可继续执行 |
| IM-13、IM-19 | 核验家族 provider、P4 depot 范围、SVN 作者及真实重启/多连接竞争 | V03–V05、R05、R16、X01–X10；用实际 adapter、fresh runtime 或独立连接证明边界 |
| IM-20、IM-22 | 逐行建立其余验收断言的代码、测试与执行证据映射，完成适用门禁 | 缺失断言保持未完成；全部验收完成后再退役本计划 |
