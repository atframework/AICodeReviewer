export const agentPackageName = "@aicr/agents";

export type {
  AgentKind,
  AgentDetectResult,
  AgentMaterializeResult,
  AgentSpawnResult,
  AgentAdapter,
  AgentSpawnOptions,
  AgentProfileConfig,
  ModelConfigTranslation,
  ModelTranslator,
} from "./types.js";

export { createKiloAdapter } from "./kilo.js";
export type { KiloAdapterOptions } from "./kilo.js";
export { createClaudeCodeAdapter } from "./claude-code.js";
export type { ClaudeCodeAdapterOptions } from "./claude-code.js";
export { createCopilotCliAdapter } from "./copilot-cli.js";
export type { CopilotCliAdapterOptions } from "./copilot-cli.js";
export { createOpencodeAdapter } from "./opencode.js";
export type { OpencodeAdapterOptions } from "./opencode.js";
export { createRooAdapter } from "./roo.js";
export type { RooAdapterOptions } from "./roo.js";
export { createOpenAICompatibleTranslator, createAnthropicTranslator, createVertexAiTranslator, createBedrockTranslator } from "./model-translator.js";
export { createAgentAdapter } from "./factory.js";
export type { CreateAgentOptions } from "./factory.js";
export {
  materializeRuntimeBundle,
} from "./runtime-bundle.js";
export type {
  RuntimeBundleInstruction,
  RuntimeBundleSkill,
  RuntimeBundleMcpTool,
  RuntimeBundleMcpServer,
  RuntimeBundleInput,
  RuntimeBundleManifest,
  RuntimeBundleResult,
} from "./runtime-bundle.js";
