# IM 集成开发计划

本计划仅保留未完成项与验收出口；已完成记录见 [M38](docs/ai/milestones/M38.md)。

设计与接口依据（长期保留）：

- [实施规范](docs/design/im-implementation-spec.md)：配置/模块/存储原子操作、状态机、默认值和恢复边界
- [验收矩阵](docs/design/im-acceptance.md)：编号断言、测试位置、故障注入和真实平台证据
- [集成、回调与重新评审](docs/design/im-integrations.md)
- [外部成员目录格式与热加载](docs/design/member-directory.md)
- [配置与目录草案示例](example/im-integrations-design.md)，不能作为当前运行配置加载
- [官方接口核查记录](docs/ai/sources/im-integrations.md)

## 本地剩余执行项

| 任务 | 当前证据与下一步 | 验收出口 |
| --- | --- | --- |
| IM-11、IM-17 | 接收端仍可写入 `file-only` 请求；worker 未按当前授权复查排队及发布阶段。补 capability readiness 与当前策略校验，执行配置仍固定原 snapshot | A08、X01、X03；禁用/撤权后不调用 VCS、模型或新的发布 POST |
| IM-14 | 当前 scan 每轮默认领取 1 条并等待执行；dispatch 每次准备都增加序号；次数主要记录崩溃恢复。补同次交接身份恢复、忙 workspace 公平性、执行窗口与阶段尝试计数/暂时 IO 退避 | R10–R13；实际尝试计一次，等待不占许可；其他 workspace 可继续执行 |
| IM-13、IM-19 | 核验家族 provider、P4 depot 范围、SVN 作者及真实重启/多连接竞争 | V03–V05、R05、R16、X01–X10；用实际 adapter、fresh runtime 或独立连接证明边界 |
| IM-20、IM-22 | 逐行建立其余验收断言的代码、测试与执行证据映射，完成适用门禁 | 缺失断言保持未完成；全部验收完成后再退役本计划 |
