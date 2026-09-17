# Model, Quota and Usage Sources

Read only the record for the external contract being changed. Dates describe the
last evidence check, not guaranteed current behavior. Retained records were not
revalidated by the 2026-09-12 layout change unless explicitly marked below.

## Completed-turn usage for the Live dashboard

- Sources:
  - <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/run.ts>
  - <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/json.md>
  - <https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/print-mode.ts>
- Evidence: Completed CLI steps/messages are authoritative for usage; ignore cumulative deltas and replace the live preview on final accounting. Kilo upstream was not refreshed in that pass.
- `last_checked`: 2026-09-12
- `next_review`: 2026-12-12
- `update_trigger`: Agent CLI output-mode changes or live usage parser changes.

## LLM quota exhaustion and transient throttling

- Sources:
  - <https://developers.openai.com/api/docs/guides/error-codes>
  - <https://platform.claude.com/docs/en/api/errors>
  - <https://platform.claude.com/docs/en/api/rate-limits>
  - <https://ai.google.dev/gemini-api/docs/api-errors>
  - <https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/quota>
  - <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deploy/error-code-429>
  - <https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html>
  - <https://docs.bigmodel.cn/cn/api/api-code>
  - <https://api-docs.deepseek.com/zh-cn/quick_start/error_codes/>
  - <https://help.aliyun.com/en/model-studio/coding-plan-faq>
  - <https://docs.github.com/en/copilot/concepts/usage-limits>
- Evidence: Quota exhaustion needs durable provider codes/messages; HTTP 429 alone also means transient pressure. Agent stream/process errors require classification outside the direct gateway.
- `last_checked`: 2026-09-03
- `next_review`: 2026-12-03
- `update_trigger`: Re-check when a provider changes quota error codes/messages, when
  adding a provider kind, or before broadening `isLlmQuotaExhaustedError` to match a
  generic status or phrase.

## models.dev model metadata catalog

- Sources:
  - <https://models.dev/>
  - <https://github.com/anomalyco/models.dev>
  - <https://opencode.ai/docs/providers/>
  - <https://github.com/Zoo-Code-Org/Zoo-Code/blob/8d4ed32f0606a4c7f45aac959540508aeac0b0e2/packages/types/src/provider-settings.ts>
- Evidence: models.dev supplies provider/model metadata. Verify schema and provider IDs on refresh; do not infer stable search capabilities or current endpoint availability from a catalog row. Adapter injection must honor complete native model shapes and explicit user overrides.
- `last_checked`: 2026-08-09
- `next_review`: 2026-11-09
- `update_trigger`: Re-check before changing the model-catalog fetch URL, the api.json field mapping into `ModelSpec`, the per-tool config-injection strategy, or the build-time fallback snapshot source.

## China platform endpoints (config UI provider presets)

- Sources:
  - <https://www.kimi.com/code/docs/> (Coding dual-protocol endpoints and current model IDs)
  - <https://platform.kimi.com/docs/api/overview> and <https://platform.kimi.ai/docs/api/overview> (China/global Open Platform)
  - <https://docs.bigmodel.cn/cn/guide/develop/claude/introduction> (Anthropic root and x-api-key)
  - <https://zcode.z.ai/en/docs/configuration> (BigModel/Z.AI general versus Coding endpoints; prepaid Anthropic account allowlisting)
  - <https://docs.z.ai/devpack/tool/claude> and <https://docs.z.ai/devpack/overview> (Coding endpoint and current GLM models)
  - <https://help.aliyun.com/zh/model-studio/base-url> (regional shared/workspace URLs, protocol roots and workload restrictions)
  - <https://help.aliyun.com/zh/model-studio/token-plan-overview> and <https://www.alibabacloud.com/help/en/model-studio/token-plan-overview> (Token Plan replaces new Coding Plan recommendations)
  - <https://help.aliyun.com/zh/model-studio/token-plan-personal-quick-start> and <https://www.alibabacloud.com/help/en/model-studio/token-plan-personal-quick-start> (Beijing/Singapore Token Plan protocols and isolated credentials)
  - <https://cloud.tencent.com/document/product/1823/130092> (Coding endpoint; only Auto remains a recommendation after excluding GLM-5 scheduled retirement)
  - <https://cloud.tencent.cn/document/product/1823/130060> (Token Plan dual-protocol endpoints)
  - <https://cloud.tencent.com/document/product/1823/135874> (TokenHub /v1/messages and x-api-key)
  - <https://api-docs.deepseek.com/guides/anthropic_api/> (Anthropic root and supported headers)
- Evidence: Official platform docs determine preset endpoints and account eligibility. models.dev validates catalog IDs and metadata, not current availability or billing. BigModel/Z.AI general prepaid accounts use OpenAI; Anthropic balance use needs a never-subscribed allowlisted account. Alibaba Coding Plan is omitted from new presets. Tencent Coding Plan omits retired models and GLM-5 scheduled to retire on 2026-10-09. Alibaba/Tencent Token Plan and TokenHub have Anthropic variants. Subscription compatibility does not authorize automated backend use; check the account's workload terms.
- Local contract: AICR Anthropic roots omit /v1. Direct/Claude/pi-family use that root; OpenCode/Kilo add /v1 for AI SDK. Protocol choice wins over catalog npm. Tests in llm/agents provider-presets and the browser suite exercise these paths without contacting providers. No live credential/billing acceptance is implied.
- `last_checked`: 2026-09-17
- `next_review`: 2026-10-09
- `update_trigger`: Endpoint, region, account restrictions, model retirement, catalog changes or SDK URL/auth behavior changes.
