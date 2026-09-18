import { describe, expect, it } from "vitest";

import {
  CONFIG_SECRETS_KEY_ENV,
  CONFIG_SECRETS_KEY_PREVIOUS_ENV,
  containsSealableSecrets,
  containsSealedSecrets,
  createConfigSecretSealing,
  isSealedSecretValue,
  openConfigSecretLiterals,
  parseConfigSecretsKeyMaterial,
  resolveConfigSecretSealing,
  sealConfigSecretLiterals,
} from "../src/config-secret-sealing.js";
import { ConfigError } from "../src/config-format.js";

const KEY_A = Buffer.alloc(32, 0xa).toString("base64");
const KEY_B = Buffer.alloc(32, 0xb).toString("base64");

function sealing(hex?: string) {
  return createConfigSecretSealing(parseConfigSecretsKeyMaterial(hex ?? KEY_A));
}

describe("parseConfigSecretsKeyMaterial", () => {
  it("accepts base64, base64url and hex 32-byte keys", () => {
    expect(parseConfigSecretsKeyMaterial(KEY_A)).toHaveLength(32);
    const hex = Buffer.alloc(32, 0xc).toString("hex");
    expect(parseConfigSecretsKeyMaterial(hex)).toHaveLength(32);
    const b64url = Buffer.alloc(32, 0xd).toString("base64url");
    expect(parseConfigSecretsKeyMaterial(b64url)).toHaveLength(32);
  });

  it("rejects malformed key material with remediation guidance", () => {
    expect(() => parseConfigSecretsKeyMaterial("short")).toThrow(/32-byte key/);
    expect(() => parseConfigSecretsKeyMaterial("z".repeat(64))).toThrow(/32-byte key/);
  });
});

describe("envelope round-trip", () => {
  it("exempts only document maps, retaining credential sealing on similarly named extensions", () => {
    const source = {
      outputs: { templates: { token: "Example text" } },
      prompts: { system: { api_key: "Example instructions" } },
      llm: { providers: [{ id: "p", outputs: { templates: { token: "real-token" } } }] },
    };
    const sealed = sealConfigSecretLiterals(source, sealing());
    expect(sealed.outputs.templates.token).toBe("Example text");
    expect(sealed.prompts.system.api_key).toBe("Example instructions");
    expect(isSealedSecretValue(sealed.llm.providers[0]!.outputs.templates.token)).toBe(true);
    expect(openConfigSecretLiterals(sealed, sealing())).toEqual(source);
  });

  it("seals and opens a literal, binding ciphertext to the field name", () => {
    const service = sealing();
    const sealed = service.seal("sk-live-123", "api_key");
    expect(sealed.startsWith("enc:v1.")).toBe(true);
    expect(sealed).toContain(service.keyId);
    expect(service.open(sealed, "api_key")).toBe("sk-live-123");
    expect(() => service.open(sealed, "token")).toThrow(/failed authentication/);
  });

  it("seal is idempotent and open passes plaintext through", () => {
    const service = sealing();
    const sealed = service.seal("value", "token");
    expect(service.seal(sealed, "token")).toBe(sealed);
    expect(service.open("plain", "token")).toBe("plain");
    expect(service.isSealed(sealed)).toBe(true);
    expect(service.isSealed("plain")).toBe(false);
  });

  it("opens values sealed with a retired key but never seals with it", () => {
    const retired = createConfigSecretSealing(parseConfigSecretsKeyMaterial(KEY_B));
    const sealed = retired.seal("old-secret", "api_key");
    const rotated = createConfigSecretSealing(parseConfigSecretsKeyMaterial(KEY_A), [parseConfigSecretsKeyMaterial(KEY_B)]);
    expect(rotated.open(sealed, "api_key")).toBe("old-secret");
    expect(rotated.seal("new-secret", "api_key")).toContain(rotated.keyId);
  });

  it("fails closed on an unknown key id and on tampering", () => {
    const service = sealing();
    const foreign = sealing(KEY_B).seal("secret", "api_key");
    expect(() => service.open(foreign, "api_key")).toThrow(ConfigError);
    expect(() => service.open(foreign, "api_key")).toThrow(/not configured/);
    const tampered = service.seal("secret", "api_key");
    const parts = tampered.split(".");
    parts[3] = parts[3]!.slice(0, -2) + (parts[3]!.endsWith("a") ? "b" : "a") + "=";
    expect(() => service.open(parts.join("."), "api_key")).toThrow();
  });
});

describe("document walkers", () => {
  const document = {
    entities: {
      providers: {
        "record-1": {
          id: "record-1",
          name: "llm",
          enabled: true,
          value: { id: "llm", kind: "openai_compatible", api_key: "sk-live", api_key_env: undefined },
        },
      },
      triggers: {
        "record-2": {
          id: "record-2",
          name: "gitea",
          enabled: true,
          value: { name: "gitea", kind: "gitea", token: "gtok", webhook_secret: "whsec", user: "p4user" },
        },
      },
    },
    globals: {
      agent: { web_search: { enabled: true, credentials: { exa: { value: "exa-key" }, tavily: "AICR_SEARCH_TAVILY_KEY" } } },
      review: { max_files: 50 },
    },
  };

  it("seals registered fields everywhere, leaving env refs and plain fields alone", () => {
    const service = sealing();
    const sealed = sealConfigSecretLiterals(document, service) as typeof document;
    const provider = sealed.entities.providers["record-1"]!.value as Record<string, unknown>;
    expect(isSealedSecretValue(provider.api_key)).toBe(true);
    expect(provider.api_key_env).toBeUndefined();
    const trigger = sealed.entities.triggers["record-2"]!.value as Record<string, unknown>;
    expect(isSealedSecretValue(trigger.token)).toBe(true);
    expect(isSealedSecretValue(trigger.webhook_secret)).toBe(true);
    // `user` is an identifier, not sealed.
    expect(trigger.user).toBe("p4user");
    const credentials = (sealed.globals.agent as { web_search: { credentials: Record<string, unknown> } }).web_search.credentials;
    expect(isSealedSecretValue((credentials.exa as { value: unknown }).value)).toBe(true);
    // A plain string credential stays an env var name reference.
    expect(credentials.tavily).toBe("AICR_SEARCH_TAVILY_KEY");
    // The input document is never mutated.
    expect((document.entities.providers["record-1"]!.value as { api_key: string }).api_key).toBe("sk-live");
  });

  it("opens a sealed document back to plaintext", () => {
    const service = sealing();
    const sealed = sealConfigSecretLiterals(document, service);
    expect(containsSealedSecrets(sealed)).toBe(true);
    expect(containsSealableSecrets(sealed)).toBe(false);
    const opened = openConfigSecretLiterals(sealed, service);
    expect(opened).toEqual(document);
    expect(containsSealableSecrets(document)).toBe(true);
    expect(containsSealedSecrets(document)).toBe(false);
  });

  it("re-sealing after a rotation preserves decryptability", () => {
    const old = sealing();
    const sealed = sealConfigSecretLiterals(document, old);
    const rotated = createConfigSecretSealing(parseConfigSecretsKeyMaterial(KEY_B), [parseConfigSecretsKeyMaterial(KEY_A)]);
    const opened = openConfigSecretLiterals(sealed, rotated);
    const resealed = sealConfigSecretLiterals(opened, rotated);
    expect(openConfigSecretLiterals(resealed, rotated)).toEqual(document);
    expect(() => openConfigSecretLiterals(resealed, old)).toThrow(/not configured/);
  });
});

describe("resolveConfigSecretSealing", () => {
  it("returns undefined without the key env and parses primary plus previous keys", () => {
    expect(resolveConfigSecretSealing(() => undefined)).toBeUndefined();
    const service = resolveConfigSecretSealing((name) =>
      name === CONFIG_SECRETS_KEY_ENV ? KEY_A : name === CONFIG_SECRETS_KEY_PREVIOUS_ENV ? ` ${KEY_B} ,` : undefined);
    expect(service).toBeDefined();
    const legacy = createConfigSecretSealing(parseConfigSecretsKeyMaterial(KEY_B));
    expect(service!.open(legacy.seal("s", "token"), "token")).toBe("s");
  });

  it("rejects invalid key material from the environment", () => {
    expect(() => resolveConfigSecretSealing((name) => (name === CONFIG_SECRETS_KEY_ENV ? "not-a-key" : undefined))).toThrow(/32-byte key/);
  });
});
