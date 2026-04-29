import type { ModelSpec } from "@aicr/llm";

import type { ModelConfigTranslation, ModelTranslator } from "./types.js";

export function createOpenAICompatibleTranslator(
  providerLabel: string,
  options?: {
    readonly baseUrl?: string;
    readonly apiKeyEnv?: string;
  },
): ModelTranslator {
  return {
    translate(model: ModelSpec): ModelConfigTranslation {
      const config: Record<string, unknown> = {
        id: providerLabel,
        kind: model.providerKind,
      };

      if (model.baseUrl) {
        config.baseUrl = model.baseUrl;
      } else if (options?.baseUrl) {
        config.baseUrl = options.baseUrl;
      }

      if (model.organization) {
        config.organization = model.organization;
      }

      if (model.extraParams) {
        Object.assign(config, model.extraParams);
      }

      const envVars: Record<string, string> = {};
      const apiKeyEnv = model.apiKeyEnv ?? options?.apiKeyEnv;
      if (apiKeyEnv) {
        envVars[apiKeyEnv] = `\${${apiKeyEnv}}`;
      }

      return {
        providerId: providerLabel,
        modelId: model.modelId,
        configJson: JSON.stringify(config),
        envVars,
        cliFlags: ["--provider", providerLabel, "--model", model.modelId],
      };
    },
  };
}
