import type { AgentKind, AgentWebSearchOptions } from "./types.js";

/**
 * Which `agent.web_search` fields an adapter can actually consume. Adapters with a
 * smaller surface than oh-my-pi (single-engine search CLIs, or CLIs whose only
 * control is a command-line kill switch) use this to warn about configured fields
 * they must ignore, instead of silently dropping them or hard-failing a global
 * config that also serves other agents in other workspaces.
 */
export interface WebSearchFieldSupport {
  readonly providers: boolean;
  /** Provider ids this adapter can select when `providers` is supported. */
  readonly providerIds?: readonly string[];
  readonly exclude: boolean;
  readonly timeout: boolean;
  /** Credential provider ids whose native env name this adapter can inject. */
  readonly credentials: readonly string[];
  readonly searxng: boolean;
}

export function warnUnsupportedWebSearchFields(
  kind: AgentKind,
  webSearch: AgentWebSearchOptions | undefined,
  support: WebSearchFieldSupport,
): void {
  if (!webSearch) return;
  const ignored: string[] = [];
  if (webSearch.providers !== undefined && webSearch.providers.length > 0) {
    if (!support.providers) {
      ignored.push("providers");
    } else if (support.providerIds) {
      const supportedProviderIds = support.providerIds;
      const unsupportedProviders = webSearch.providers.filter(
        (provider) => !supportedProviderIds.includes(provider),
      );
      if (unsupportedProviders.length > 0) {
        ignored.push(`providers.${unsupportedProviders.join(", providers.")}`);
      }
    }
  }
  if (!support.exclude && webSearch.exclude !== undefined && webSearch.exclude.length > 0) {
    ignored.push("exclude");
  }
  if (!support.timeout && webSearch.timeoutSeconds !== undefined) {
    ignored.push("timeout_seconds");
  }
  if (!support.searxng && webSearch.searxng !== undefined) {
    ignored.push("searxng");
  }
  const unsupportedCredentials = Object.keys(webSearch.credentials ?? {}).filter(
    (provider) => !support.credentials.includes(provider),
  );
  if (unsupportedCredentials.length > 0) {
    ignored.push(`credentials.${unsupportedCredentials.join(", credentials.")}`);
  }
  if (ignored.length === 0) return;
  console.warn(JSON.stringify({
    level: "warn",
    msg: "agent web_search fields not supported by this agent kind; ignoring",
    agent: kind,
    fields: ignored,
  }));
}

/**
 * Maps AICR-side credential env names onto an adapter's native env names as
 * `${VAR}` references (resolved by the orchestrator at spawn time). Credential
 * providers outside `envByProvider` are skipped — the caller is expected to have
 * warned about them via {@link warnUnsupportedWebSearchFields}.
 */
export function buildWebSearchCredentialEnvVars(
  webSearch: AgentWebSearchOptions | undefined,
  envByProvider: Readonly<Record<string, string>>,
): Record<string, string> {
  if (!webSearch?.enabled) return {};
  const credentials = webSearch?.credentials;
  if (!credentials) return {};
  const envVars: Record<string, string> = {};
  for (const [provider, envName] of Object.entries(credentials)) {
    const nativeEnvName = envByProvider[provider];
    if (!nativeEnvName) continue;
    envVars[nativeEnvName] = `\${${envName}}`;
  }
  return envVars;
}
