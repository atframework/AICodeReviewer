import type { AgentAdapter, AgentKind } from "./types.js";
import { createKiloAdapter } from "./kilo.js";

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

    case "opencode":
    case "roo":
    case "copilot-cli":
    case "claude-code":
      throw new TypeError(`Agent kind "${options.kind}" is not yet implemented.`);
  }
}

export { createKiloAdapter } from "./kilo.js";
export type { KiloAdapterOptions } from "./kilo.js";
export { createOpenAICompatibleTranslator } from "./model-translator.js";
