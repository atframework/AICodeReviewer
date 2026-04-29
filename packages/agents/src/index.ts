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
export { createOpenAICompatibleTranslator } from "./model-translator.js";
export { createAgentAdapter } from "./factory.js";
export type { CreateAgentOptions } from "./factory.js";
