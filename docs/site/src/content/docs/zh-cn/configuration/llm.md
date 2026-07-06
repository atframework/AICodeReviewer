---
title: LLM 提供方与模型
description: 配置 LLM 提供方、fallback 链、重试/退避、费用预算，以及可选开启的 models.dev 元数据目录。
---

`llm` 命名空间是 AICodeReviewer 的核心——没有提供方和至少一条 fallback 链条目，
评审无法运行。本页覆盖 `llm.providers`、`llm.fallback_chain`、`llm.retry`、
`llm.budget`，以及 M10 模型元数据目录（`llm.model_catalog`）。

一个完整的最小示例：

```yaml
llm:
  providers:
    - id: my-llm
      kind: openai_compatible
      base_url: https://api.openai.com/v1
      api_key_env: AICR_LLM_API_KEY

  fallback_chain:
    - provider: my-llm
      model: gpt-4o-mini
      role: any

  retry:
    max_attempts: 3
    backoff:
      kind: exponential
      base_ms: 1000
      max_ms: 30000
      jitter: true

  budget:
    per_run_usd: 0.10
    per_repo_daily_usd: 1.0
```

## `llm.providers[]` —— 连接定义

每个 provider 条目描述一个 LLM 端点。`id` 是其他 section（fallback 链、模型目录）
引用它时使用的名字，仅在你的配置内有效。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | :---: | --- |
| `id` | string | ✓ | 唯一的 provider id，供 `fallback_chain` 与目录引用。 |
| `kind` | enum | ✓ | 提供方协议。取值：`openai_compatible`、`azure_openai`、`anthropic`、`vertex_ai`、`bedrock`、`google_ai_studio`、`ollama`、`copilot`。 |
| `base_url` | string (URL) | – | API 基础 URL，部分托管类型可省略。 |
| `api_key_env` | string | – | 存放 API key 的环境变量名。绝不内联 key。 |
| `api_version` | string | – | API 版本（`azure_openai` 等使用）。 |
| `catalog_provider` | string | – | 将自定义 provider 映射到 models.dev 的 provider id（例如 `openai`）。 |
| `catalog_id` | string | – | 显式 models.dev 查找 id（例如 `openai/gpt-4o-mini`），用于自定义别名。 |

:::tip[把自定义网关映射到目录]
自定义的 OpenAI 兼容网关同样可以用上 models.dev 目录：在 provider 上设置
`catalog_provider: openai`（按 `openai/<modelId>` 解析），或用
`catalog_id: openai/gpt-4o-mini` 固定到具体条目。
:::

## `llm.fallback_chain[]` —— 哪个模型干什么活

fallback 链是一个有序的 `(provider, model, role)` 三元组列表。通过 role 可以把
工作拆分到快速便宜的 "light" 模型（用于 diff 压缩和逐文件摘要）和 "heavy" 模型
（主评审器）之间；未指定 role 时使用 `any`。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | :---: | --- |
| `provider` | string | ✓ | 必须匹配某个 `providers[].id`。 |
| `model` | string | ✓ | 传给 provider 的 model id。 |
| `role` | enum | ✓ | `light`、`heavy` 或 `any`。 |

```yaml
llm:
  fallback_chain:
    - provider: my-llm
      model: gpt-4o-mini
      role: light          # diff 压缩、逐文件摘要
    - provider: my-llm
      model: gpt-4o
      role: heavy          # 主评审器
    - provider: my-llm
      model: gpt-4o-mini
      role: any            # 任意 role 的兜底
```

## `llm.retry` —— 瞬时失败处理

作用于因瞬时错误（限流、5xx、网络）失败的 LLM 调用。可通过
`llm.per_provider_overrides`（provider id → `{ max_attempts,
give_up_after_seconds }` 的映射）按 provider 覆盖。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `max_attempts` | int > 0 | – | 总尝试次数（含首次调用）。 |
| `respect_retry_after` | bool | – | 出现 `Retry-After` 头时遵循它。 |
| `give_up_after_seconds` | number > 0 | – | 硬性的挂钟时间上限。 |
| `backoff.kind` | enum | – | `exponential`、`linear` 或 `constant`。 |
| `backoff.base_ms` | number > 0 | – | 首次/基础退避延迟（毫秒）。 |
| `backoff.max_ms` | number > 0 | – | 单次退避延迟上限。 |
| `backoff.jitter` | bool | – | 是否加入随机抖动以避免惊群。 |

```yaml
llm:
  retry:
    max_attempts: 3
    backoff:
      kind: exponential
      base_ms: 1000
      max_ms: 30000
      jitter: true
```

## `llm.budget` —— 费用上限

软上限，超出时中止或告警。费用核算在模型目录启用时使用目录价格，否则退回到旧的
固定估算。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `per_run_usd` | number ≥ 0 | 单次评审运行的上限。 |
| `per_repo_daily_usd` | number ≥ 0 | 每个仓库滚动每日上限。 |

```yaml
llm:
  budget:
    per_run_usd: 0.10
    per_repo_daily_usd: 1.0
```

## `llm.model_catalog` —— models.dev 元数据（M10，可选开启）

自 M10 起可用，**默认关闭**。开启后，AICodeReviewer 从
[models.dev](https://models.dev/) 读取模型参数，这样你就不必逐 provider 手工维护
context window、输出上限、能力标志和价格。这些值会喂给 diff 压缩阈值、
`llm.budget` 费用核算，以及传给外部 agent CLI（Kilo、Zoo、opencode、Claude Code）
的模型配置。

```yaml
llm:
  model_catalog:
    enabled: true                       # 可选开启；默认关闭
    source_url: https://models.dev/api.json
    refresh_interval_hours: 24          # 源级刷新节奏（默认每日）
    fetch_timeout_ms: 10000
    offline: false                      # true = 仅用内置快照，绝不联网
    apply_to_model_spec: true           # 用目录数据填补 ModelSpec 空缺
    cache:
      backend: sqlite                   # sqlite（默认）| memory（测试/开发）| redis
    overrides:                          # 手工按模型覆盖，优先级高于目录
      "my-llm/gpt-4o-mini":
        catalog_id: openai/gpt-4o-mini
        context_window: 128000
        max_output_tokens: 16384
        supports_tool_call: true
        supports_vision: true
        supports_cache_prompt: true
        cost_input_per_mtok: 0.15
        cost_output_per_mtok: 0.6
        display_name: "GPT-4o mini (via gateway)"
```

### 目录顶层字段

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | bool | `false` | 总开关。 |
| `source_url` | string (URL) | `https://models.dev/api.json` | 目录源。 |
| `refresh_interval_hours` | int > 0 | `24` | 源级刷新节奏。仅当源级元数据缺失或早于该时长时才拉取远程 `api.json`；区间内未知 model id 不会反复触发拉取。 |
| `fetch_timeout_ms` | int > 0 | `10000` | 联网拉取超时。 |
| `offline` | bool | `false` | 绝不联网，只服务内置快照。 |
| `apply_to_model_spec` | bool | `true` | 用目录数据填补解析得到的 `ModelSpec` 中的空缺。 |
| `cache.backend` | enum | `sqlite` | `sqlite`、`memory` 或 `redis`。 |
| `overrides` | map | `{}` | 按模型的手工覆盖。键为 `"<providerId>/<modelId>"`。 |

### 缓存后端

| 后端 | 存储 | 说明 |
| --- | --- | --- |
| `sqlite`（默认） | 复用 `storage.database`（带键的 `model_catalog` 表）。 | 仅做点查询；完整 `api.json` 仅在刷新时解析一次并逐行 upsert，读取时不再解析。 |
| `memory` | 进程内。 | 面向测试与本地开发，重启即丢失。 |
| `redis` | 复用 `storage.cache.redis`。 | **要求** `storage.cache.kind: redis` **且** `storage.cache.redis.url_env` 可解析。跨环境共享 Redis 时请使用唯一的 `key_prefix`。见 [/zh-cn/configuration/storage/](/zh-cn/configuration/storage/)。 |

### 解析顺序

查找某个模型时，AICodeReviewer 按以下顺序解析：

1. **带键的刷新缓存**（默认 SQLite）。仅当源级刷新元数据缺失或早于
   `refresh_interval_hours` 时才拉取远程源；区间内未知 model id **不会**反复拉取。
2. **过期的缓存行** —— 远程拉取失败时的兜底。
3. **只读内置快照** —— 最后兜底，在打包时从 `github.com/anomalyco/models.dev`
   构建，按需种入后端。

### `overrides` —— 你的配置永远优先

`model_catalog.overrides` 下按模型（键为 `"<providerId>/<modelId>"`）的覆盖
**始终优先于目录数据**，而 `llm.providers[]` 的字段优先级高于这两者。缺失字段
**绝不凭空捏造**：你与目录都没给的值会保持未设置。

最常用的覆盖字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `catalog_id` | string | 为自定义别名指定可选的 models.dev 查找 id。 |
| `context_window` | int > 0 | 模型上下文窗口（token 数）。 |
| `max_input_tokens` | int > 0 | 最大输入 token。 |
| `max_output_tokens` | int > 0 | 最大输出 token。 |
| `cost_input_per_mtok` | number ≥ 0 | 每 1M 输入 token 美元价。 |
| `cost_output_per_mtok` | number ≥ 0 | 每 1M 输出 token 美元价。 |
| `cost_cache_read_per_mtok` | number ≥ 0 | 每 1M 缓存读 token 美元价。 |
| `cost_cache_write_per_mtok` | number ≥ 0 | 每 1M 缓存写 token 美元价。 |
| `supports_tool_call` | bool | 工具/函数调用。 |
| `supports_vision` | bool | 图像输入。 |
| `supports_cache_prompt` | bool | 提示词缓存。 |
| `supports_reasoning` | bool | 推理模型。 |
| `supports_structured_output` | bool | 结构化/JSON 输出。 |
| `display_name` | string | 友好显示名。 |
| `family` | string | 模型家族。 |

schema 还接受更多可选字段（模态、推理强度档位、延迟等级、限流等级、知识截止时间
等）。完整列表见 `packages/core/src/config.ts` 中的 `modelCatalogOverrideSchema`。

:::caution[Redis 缓存前置条件]
选择 `cache.backend: redis` 会在加载配置时触发两处校验：

- `storage.cache.kind` 必须为 `redis`。
- `storage.cache.redis.url_env` 必须可解析。

任一缺失，配置会被拒绝并指向出错字段。请按
[/zh-cn/configuration/storage/](/zh-cn/configuration/storage/) 所述配置这两项。
:::

## 目录如何反哺其他子系统

解析得到的元数据会被三个子系统消费：

1. **diff 压缩** —— 当省略 `compression` section 时，`compression.trigger_tokens`
   与 `max_input_ratio` 会根据模型的 `context_window` 推导默认值。窗口越大，
   压缩阈值自动提高。
2. **`llm.budget` 核算** —— 目录价格取代旧的固定估算，费用上限反映真实的每 token
   价格。
3. **agent 配置注入** —— context window、最大输出 token、视觉标志和价格会被注入到
   agent CLI 的配置中，让每个运行时知道模型的限制。这也正是**agent 上下文自动压缩
   依赖已知 context window** 的原因——`context_compaction` 设置及 Kilo 要求窗口已知
   （开启目录或在 `overrides` 里设置 `context_window`），见
   [/zh-cn/configuration/agent/](/zh-cn/configuration/agent/)。
