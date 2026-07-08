import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const JWT_SKEW_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 540;
const TOKEN_REFRESH_LEAD_MS = 5 * 60 * 1000;

export interface GithubAppTokenServiceOptions {
  readonly appId?: string;
  readonly clientId?: string;
  readonly privateKey: string;
  readonly installationId?: number;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export class GithubAppTokenService {
  private readonly issuer: string;
  private readonly privateKey: string;
  private readonly installationId: number | undefined;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly tokenCache = new Map<number, CachedToken>();
  private readonly installationCache = new Map<string, number>();
  private readonly inflightTokens = new Map<number, Promise<string>>();
  private readonly inflightInstallations = new Map<string, Promise<number>>();

  constructor(options: GithubAppTokenServiceOptions) {
    const issuer = options.appId ?? options.clientId;
    if (!issuer) {
      throw new TypeError("GithubAppTokenService requires appId or clientId.");
    }
    if (!options.privateKey) {
      throw new TypeError("GithubAppTokenService requires a private key.");
    }

    this.issuer = String(issuer);
    this.privateKey = options.privateKey;
    this.installationId = options.installationId;
    this.apiBaseUrl = resolveGithubApiBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async getInstallationToken(installationId: number): Promise<string> {
    const cached = this.tokenCache.get(installationId);
    if (cached && cached.expiresAt.getTime() - this.now().getTime() > TOKEN_REFRESH_LEAD_MS) {
      return cached.token;
    }

    const inflight = this.inflightTokens.get(installationId);
    if (inflight) {
      return inflight;
    }

    const promise = this.fetchInstallationToken(installationId);
    this.inflightTokens.set(installationId, promise);
    try {
      const token = await promise;
      return token;
    } finally {
      this.inflightTokens.delete(installationId);
    }
  }

  async resolveInstallationId(owner: string, repo: string): Promise<number> {
    const cacheKey = `${owner}/${repo}`;
    const cached = this.installationCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const inflight = this.inflightInstallations.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    const promise = this.fetchInstallationId(owner, repo);
    this.inflightInstallations.set(cacheKey, promise);
    try {
      const id = await promise;
      this.installationCache.set(cacheKey, id);
      return id;
    } finally {
      this.inflightInstallations.delete(cacheKey);
    }
  }

  async getInstallationTokenForRepo(owner: string, repo: string): Promise<string> {
    const installationId = this.installationId !== undefined && Number.isFinite(this.installationId)
      ? this.installationId
      : await this.resolveInstallationId(owner, repo);
    return this.getInstallationToken(installationId);
  }

  evict(installationId?: number): void {
    if (installationId !== undefined) {
      this.tokenCache.delete(installationId);
    } else {
      this.tokenCache.clear();
      this.installationCache.clear();
    }
  }

  private signAppJwt(): string {
    const now = this.now();
    const iat = Math.floor(now.getTime() / 1000) - JWT_SKEW_SECONDS;
    const exp = iat + JWT_LIFETIME_SECONDS;

    const header = { alg: "RS256", typ: "JWT" };
    const payload = { iat, exp, iss: this.issuer };

    const encodedHeader = base64urlJson(header);
    const encodedPayload = base64urlJson(payload);
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const sign = createSign("RSA-SHA256");
    sign.update(signingInput);
    sign.end();

    let signature: Buffer;
    try {
      signature = sign.sign(this.privateKey);
    } catch (error) {
      throw new Error(
        `Failed to sign GitHub App JWT with the configured private key: ${error instanceof Error ? error.message : String(error)}. Verify the PEM is valid and matches the App's key pair.`,
      );
    }

    return `${signingInput}.${bufferToBase64url(signature)}`;
  }

  private async fetchInstallationToken(installationId: number): Promise<string> {
    const jwt = this.signAppJwt();
    const url = `${this.apiBaseUrl}/app/installations/${installationId}/access_tokens`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
    });

    if (!response.ok) {
      throw mapGithubAppError(response.status, installationId);
    }

    const body = (await response.json()) as { token?: string; expires_at?: string };
    if (!body.token) {
      throw new Error(`GitHub App installation token response missing token field for installation ${installationId}.`);
    }

    const expiresAt = body.expires_at ? new Date(body.expires_at) : undefined;
    if (expiresAt) {
      this.tokenCache.set(installationId, { token: body.token, expiresAt });
    }

    return body.token;
  }

  private async fetchInstallationId(owner: string, repo: string): Promise<number> {
    const jwt = this.signAppJwt();
    const url = `${this.apiBaseUrl}/repos/${owner}/${repo}/installation`;
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
    });

    if (!response.ok) {
      throw mapGithubAppError(response.status, undefined, owner, repo);
    }

    const body = (await response.json()) as { id?: number };
    if (typeof body.id !== "number") {
      throw new Error(`GitHub App installation lookup for ${owner}/${repo} returned no installation id.`);
    }

    return body.id;
  }
}

/**
 * Resolves the GitHub REST API base URL from a trigger/channel `base_url`.
 *
 * The App token service and VCS layer treat a GitHub trigger `base_url` as the
 * host (`https://github.com` or a GHE host). Output dispatchers need the REST
 * API base. This derives it consistently while staying backward compatible with
 * configs that already point `base_url` at the API URL:
 * - `https://github.com` → `https://api.github.com`
 * - `https://api.github.com` → unchanged
 * - `https://ghe.example.com` → `https://ghe.example.com/api/v3`
 * - `https://ghe.example.com/api/v3` → unchanged (already an API URL)
 */
export function resolveGithubApiBaseUrl(baseUrl: string | undefined): string {
  if (!baseUrl) {
    return GITHUB_API_BASE;
  }

  const normalized = baseUrl.replace(/\/+$/u, "");
  if (normalized === "https://github.com" || normalized === "http://github.com") {
    return GITHUB_API_BASE;
  }
  if (normalized === GITHUB_API_BASE) {
    return GITHUB_API_BASE;
  }
  if (/\/api\/v3$/u.test(normalized)) {
    return normalized;
  }

  return `${normalized}/api/v3`;
}

function base64urlJson(value: unknown): string {
  return bufferToBase64url(Buffer.from(JSON.stringify(value), "utf8"));
}

function bufferToBase64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function mapGithubAppError(
  status: number,
  installationId: number | undefined,
  owner?: string,
  repo?: string,
): Error {
  const target = owner && repo ? `${owner}/${repo}` : `installation ${installationId}`;
  switch (status) {
    case 401:
      return new Error(
        `GitHub App JWT rejected (401). Verify app_id/client_id and private_key are correct and the key has not been rotated.`,
      );
    case 403:
      return new Error(
        `GitHub App request forbidden (403) for ${target}. Ensure the App is installed and has required permissions (Contents Read, Pull requests Read/Write, Issues Read/Write, Metadata Read).`,
      );
    case 404:
      return new Error(
        `GitHub App installation not found (404) for ${target}. Verify the App is installed to the repository.`,
      );
    default:
      return new Error(`GitHub App API request failed (${status}) for ${target}.`);
  }
}

export function decodePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("-----BEGIN")) {
    return trimmed;
  }

  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
    if (decoded.startsWith("-----BEGIN")) {
      return decoded;
    }
  } catch {
    // fall through to return raw value — sign() will surface the error
  }

  return trimmed;
}

export async function resolvePrivateKey(
  privateKeyEnv: string | undefined,
  privateKeyPath: string | undefined,
  resolveEnv: (name: string) => string | undefined,
): Promise<string> {
  if (privateKeyEnv) {
    const raw = resolveEnv(privateKeyEnv);
    if (!raw) {
      throw new Error(`GitHub App private_key_env "${privateKeyEnv}" is not set in the environment.`);
    }
    return decodePrivateKey(raw);
  }

  if (privateKeyPath) {
    try {
      const raw = await readFile(privateKeyPath, "utf8");
      return decodePrivateKey(raw);
    } catch (error) {
      throw new Error(
        `Failed to read GitHub App private_key_path "${privateKeyPath}": ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  }

  throw new Error("GitHub App auth requires private_key_env or private_key_path.");
}

export interface GithubAppTriggerAuth {
  readonly appId?: string;
  readonly clientId?: string;
  readonly privateKey: string;
  readonly installationId?: number;
  readonly baseUrl?: string;
}

export async function resolveGithubAppTriggerAuth(
  triggerConfig: Record<string, unknown>,
  resolveEnvFn: (name: string) => string | undefined,
): Promise<GithubAppTriggerAuth> {
  const appConfig = triggerConfig.app;
  if (!appConfig || typeof appConfig !== "object") {
    throw new Error("GitHub App trigger has no app config.");
  }

  const app = appConfig as Record<string, unknown>;
  const appId = app.app_id !== undefined ? String(app.app_id) : undefined;
  const clientId = typeof app.client_id === "string" ? app.client_id : undefined;
  const privateKeyEnv = typeof app.private_key_env === "string" ? app.private_key_env : undefined;
  const privateKeyPath = typeof app.private_key_path === "string" ? app.private_key_path : undefined;
  const installationIdRaw = app.installation_id !== undefined ? Number(app.installation_id) : undefined;
  const installationId = installationIdRaw !== undefined && Number.isFinite(installationIdRaw)
    ? installationIdRaw
    : undefined;
  const baseUrl = typeof triggerConfig.base_url === "string" ? triggerConfig.base_url : undefined;

  const privateKey = await resolvePrivateKey(privateKeyEnv, privateKeyPath, resolveEnvFn);

  return {
    ...(appId !== undefined ? { appId } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
    privateKey,
    ...(installationId !== undefined ? { installationId } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}

export function createGithubAppTokenService(auth: GithubAppTriggerAuth): GithubAppTokenService {
  return new GithubAppTokenService({
    ...(auth.appId !== undefined ? { appId: auth.appId } : {}),
    ...(auth.clientId !== undefined ? { clientId: auth.clientId } : {}),
    privateKey: auth.privateKey,
    ...(auth.installationId !== undefined ? { installationId: auth.installationId } : {}),
    ...(auth.baseUrl !== undefined ? { baseUrl: auth.baseUrl } : {}),
  });
}
