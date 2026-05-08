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

      if (model.reasoningEffort) {
        config.reasoningEffort = model.reasoningEffort;
      }

      if (model.thinkingLevel) {
        config.thinkingLevel = model.thinkingLevel;
      }

      if (model.thinkingBudgetTokens !== undefined) {
        config.thinkingBudgetTokens = model.thinkingBudgetTokens;
      }

      if (model.thinking) {
        config.thinking = model.thinking;
      }

      if (model.responseFormat) {
        config.responseFormat = model.responseFormat;
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

export function createAnthropicTranslator(
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

      const envVars: Record<string, string> = {};

      const apiKeyEnv = model.apiKeyEnv ?? options?.apiKeyEnv ?? "ANTHROPIC_API_KEY";
      envVars.ANTHROPIC_API_KEY = `\${${apiKeyEnv}}`;

      const baseUrl = model.baseUrl ?? options?.baseUrl;
      if (baseUrl) {
        envVars.ANTHROPIC_BASE_URL = baseUrl;
      }

      if (model.anthropicVersion) {
        envVars.ANTHROPIC_VERSION = model.anthropicVersion;
      }

      if (model.anthropicBeta && model.anthropicBeta.length > 0) {
        envVars.ANTHROPIC_BETA = model.anthropicBeta.join(",");
      }

      if (model.extraParams?.max_tokens !== undefined) {
        envVars.ANTHROPIC_MAX_TOKENS = String(model.extraParams.max_tokens);
      }

      if (model.thinking?.enabled && model.thinking.budgetTokens !== undefined) {
        envVars.ANTHROPIC_THINKING_BUDGET_TOKENS = String(model.thinking.budgetTokens);
      }

      if (model.extraParams) {
        Object.assign(config, model.extraParams);
      }

      const cliFlags = ["--model", model.modelId];
      if (model.thinking?.enabled) {
        cliFlags.push("--thinking");
      }

      return {
        providerId: providerLabel,
        modelId: model.modelId,
        configJson: JSON.stringify(config),
        envVars,
        cliFlags,
      };
    },
  };
}

export function createVertexAiTranslator(
  providerLabel: string,
): ModelTranslator {
  return {
    translate(model: ModelSpec): ModelConfigTranslation {
      const config: Record<string, unknown> = {
        id: providerLabel,
        kind: model.providerKind,
      };

      const envVars: Record<string, string> = {};

      const credentialsEnv = model.googleApplicationCredentialsEnv ?? "GOOGLE_APPLICATION_CREDENTIALS";
      envVars.GOOGLE_APPLICATION_CREDENTIALS = `\${${credentialsEnv}}`;

      if (model.vertexProject) {
        envVars.GOOGLE_CLOUD_PROJECT = model.vertexProject;
      }

      if (model.vertexLocation) {
        envVars.GOOGLE_CLOUD_LOCATION = model.vertexLocation;
      }

      if (model.extraParams) {
        Object.assign(config, model.extraParams);
      }

      const cliFlags = ["--provider", providerLabel, "--model", model.modelId];
      if (model.vertexProject) {
        cliFlags.push("--project", model.vertexProject);
      }
      if (model.vertexLocation) {
        cliFlags.push("--location", model.vertexLocation);
      }

      return {
        providerId: providerLabel,
        modelId: model.modelId,
        configJson: JSON.stringify(config),
        envVars,
        cliFlags,
      };
    },
  };
}

export function createBedrockTranslator(
  providerLabel: string,
): ModelTranslator {
  return {
    translate(model: ModelSpec): ModelConfigTranslation {
      const config: Record<string, unknown> = {
        id: providerLabel,
        kind: model.providerKind,
      };

      const envVars: Record<string, string> = {};

      if (model.awsRegion) {
        envVars.AWS_REGION = model.awsRegion;
      }

      if (model.awsAccessKeyEnv) {
        envVars.AWS_ACCESS_KEY_ID = `\${${model.awsAccessKeyEnv}}`;
      }

      if (model.awsSecretKeyEnv) {
        envVars.AWS_SECRET_ACCESS_KEY = `\${${model.awsSecretKeyEnv}}`;
      }

      if (model.awsSessionTokenEnv) {
        envVars.AWS_SESSION_TOKEN = `\${${model.awsSessionTokenEnv}}`;
      }

      if (model.awsProfile) {
        envVars.AWS_PROFILE = model.awsProfile;
      }

      if (model.baseUrl) {
        envVars.AWS_ENDPOINT_URL = model.baseUrl;
      }

      if (model.extraParams) {
        Object.assign(config, model.extraParams);
      }

      const cliFlags = ["--provider", providerLabel, "--model", model.modelId];
      if (model.awsRegion) {
        cliFlags.push("--region", model.awsRegion);
      }

      return {
        providerId: providerLabel,
        modelId: model.modelId,
        configJson: JSON.stringify(config),
        envVars,
        cliFlags,
      };
    },
  };
}
