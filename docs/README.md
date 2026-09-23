# 文档目录

本目录集中保存设计、用户说明和交付记录。按下面的入口阅读当前文档；
前瞻扩展与外部验收边界见 [AI 维护导航](ai/index.md)。

## 用户文档

公开用户文档的源码位于 `site/src/content/docs/`，中文与英文同步维护。

| 主题 | 中文 | English |
| --- | --- | --- |
| 安装与首次运行 | [快速开始](site/src/content/docs/zh-cn/start/quick-start.md) | [Quick start](site/src/content/docs/en/start/quick-start.md) |
| 配置与多工程 Workspace | [配置总览](site/src/content/docs/zh-cn/configuration/overview.md) | [Configuration overview](site/src/content/docs/en/configuration/overview.md) |
| 配置管理、暂存、预览与版本恢复 | [管理面板](site/src/content/docs/zh-cn/start/dashboard.md) | [Dashboard](site/src/content/docs/en/start/dashboard.md) |
| 数据库、缓存与升级 | [存储](site/src/content/docs/zh-cn/configuration/storage.md) | [Storage](site/src/content/docs/en/configuration/storage.md) |
| 路由与输出 | [输出配置](site/src/content/docs/zh-cn/configuration/outputs.md) | [Outputs](site/src/content/docs/en/configuration/outputs.md) |
| 配置字段 | [字段参考](site/src/content/docs/zh-cn/reference/config-fields.md) | [Config fields](site/src/content/docs/en/reference/config-fields.md) |
| Workspace 路径变量 | [模板变量](site/src/content/docs/zh-cn/reference/template-variables.md) | [Template variables](site/src/content/docs/en/reference/template-variables.md) |
| 命令与迁移操作 | [CLI](site/src/content/docs/zh-cn/reference/cli.md) | [CLI](site/src/content/docs/en/reference/cli.md) |
| 部署维护 | [运维](site/src/content/docs/zh-cn/deployment/operations.md) | [Operations](site/src/content/docs/en/deployment/operations.md) |

可运行配置与容器文件位于 [example/](../example/README.md)。
文档站开发、校验和构建方式见 [site/README.md](site/README.md)。

## 设计与实现

| 文档 | 内容 |
| --- | --- |
| [架构](ai/architecture.md) | 当前模块边界与稳定合同；Workspace 见 §3.10，存储迁移见 §3.14，来源合并与发布见 §3.15，运行时版本与管理 API 见 §3.16 |
| [设计决策](ai/decisions.md) | 方案取舍；Workspace 与动态配置相关合同见 D37–D47 |
| [输出合同](output-channels.md) | 输出渠道、模板、目标选择及发布语义 |
| [评审提示词设计依据](prompt-research.md) | 默认评审提示词的目标、约束和参考依据 |
| [AI 维护导航](ai/index.md) | 从代码主题定位设计章节、易错点和维护技能 |

稳定设计继续维护在上述文档中。已完成任务的临时设计、执行计划和测试计划退役后，
不再作为实施入口；历史结论按下面的交付记录追溯。

## 交付记录与验收边界

- [里程碑索引](ai/index.md#里程碑归档)：各阶段的实现、测试和验收证据。
- [M24 跨版本迁移与排空](ai/milestones/M24.md)：指定历史版本对和真实服务验收范围。
- [M26 Workspace 与动态配置复审](ai/milestones/M26.md)：本轮修复、回归及最终门禁。
- [前瞻扩展](ai/index.md#前瞻扩展未纳入当前交付)：尚未纳入当前交付的预留项与验收边界。
- [本地临时服务](testing-services.md)：WSL/Podman 的资源、复现与清理要求。
