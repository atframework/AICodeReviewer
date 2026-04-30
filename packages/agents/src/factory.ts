import type { AgentAdapter, AgentKind } from "./types.js";
import { createClaudeCodeAdapter } from "./claude-code.js";
import { createCopilotCliAdapter } from "./copilot-cli.js";
import { createKiloAdapter } from "./kilo.js";
import { createOpencodeAdapter } from "./opencode.js";
import { createRooAdapter } from "./roo.js";

export interface CreateAgentOptions {
  readonly kind: AgentKind;
  readonly binary?: string;
}

export function createAgentAdapter(options: CreateAgentOptions): AgentAdapter {
  switch (options.kind) {
    case "kilo": {
      const kiloOpts = options.binary ? { binary: options.binary } : {};
      return createKiloAdapter(kiloOpts);
    }

    case "opencode": {
      const opencodeOpts = options.binary ? { binary: options.binary } : {};
      return createOpencodeAdapter(opencodeOpts);
    }

    case "roo": {
      const rooOpts = options.binary ? { binary: options.binary } : {};
      return createRooAdapter(rooOpts);
    }

    case "copilot-cli": {
      const copilotOpts = options.binary ? { binary: options.binary } : {};
      return createCopilotCliAdapter(copilotOpts);
    }

    case "claude-code": {
      const claudeOpts = options.binary ? { binary: options.binary } : {};
      return createClaudeCodeAdapter(claudeOpts);
    }
  }
}

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
export { createOpenAICompatibleTranslator } from "./model-translator.js";
