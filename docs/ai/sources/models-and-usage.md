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
