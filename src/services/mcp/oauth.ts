import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { platform } from "node:os";

import type { McpOAuthConfig } from "./config";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type OAuthMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  revocation_endpoint?: string;
  revocation_endpoint_auth_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
};

export type OAuthLogoutResult = {
  localCredentialsRemoved: boolean;
  serverRevocation: "revoked" | "unsupported" | "failed" | "no_credentials";
  errors?: string[];
};

type StoredOAuth = {
  version: 1;
  servers: Record<string, OAuthRecord>;
};

type OAuthRecord = {
  serverName: string;
  serverUrl: string;
  authorizationServerUrl: string;
  clientId: string;
  clientSecret?: string;
  redirectUri?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

export class McpOAuthClient {
  private refreshInProgress: Promise<string> | undefined;

  constructor(private readonly options: {
    serverName: string;
    serverUrl: string;
    config: McpOAuthConfig;
    storagePath: string;
    fetch?: FetchLike;
  }) {}

  async accessToken(): Promise<string> {
    const record = await this.record();
    if (!record) {
      throw new Error(`MCP server ${this.options.serverName} requires authentication; run tnb mcp auth ${this.options.serverName}`);
    }
    if (record.expiresAt - Date.now() > 300_000) return record.accessToken;
    if (!record.refreshToken) {
      throw new Error(`MCP OAuth token for ${this.options.serverName} expired; run tnb mcp auth ${this.options.serverName}`);
    }
    if (!this.refreshInProgress) {
      this.refreshInProgress = this.refresh(record).finally(() => {
        this.refreshInProgress = undefined;
      });
    }
    return this.refreshInProgress;
  }

  async authorize(options?: {
    onAuthorizationUrl?(url: string): void;
    openBrowser?: boolean;
    timeoutMs?: number;
  }): Promise<void> {
    const callback = await createCallbackServer(this.options.config.callbackPort, options?.timeoutMs);
    try {
      const metadata = await this.discoverMetadata();
      assertPkceSupport(metadata);
      const client = await this.resolveClient(metadata, callback.redirectUri);
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const state = randomBytes(32).toString("base64url");
      const scopes = this.options.config.scopes ?? metadata.scopes_supported ?? [];
      const authorizationUrl = new URL(metadata.authorization_endpoint);
      assertSecureOAuthUrl(authorizationUrl);
      authorizationUrl.searchParams.set("response_type", "code");
      authorizationUrl.searchParams.set("client_id", client.clientId);
      authorizationUrl.searchParams.set("redirect_uri", callback.redirectUri);
      authorizationUrl.searchParams.set("state", state);
      authorizationUrl.searchParams.set("code_challenge", challenge);
      authorizationUrl.searchParams.set("code_challenge_method", "S256");
      authorizationUrl.searchParams.set("resource", this.options.serverUrl);
      if (scopes.length) authorizationUrl.searchParams.set("scope", scopes.join(" "));
      options?.onAuthorizationUrl?.(authorizationUrl.toString());
      if (options?.openBrowser !== false) openBrowser(authorizationUrl.toString());
      const authorizationCode = await callback.waitForCode(state, metadata.issuer);
      const tokens = await this.tokenRequest(metadata.token_endpoint, {
        grant_type: "authorization_code",
        code: authorizationCode,
        code_verifier: verifier,
        redirect_uri: callback.redirectUri,
        client_id: client.clientId,
        ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
        resource: this.options.serverUrl,
      });
      await this.save({
        serverName: this.options.serverName,
        serverUrl: this.options.serverUrl,
        authorizationServerUrl: metadata.issuer,
        clientId: client.clientId,
        ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
        redirectUri: callback.redirectUri,
        accessToken: tokens.access_token,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        expiresAt: Date.now() + (tokens.expires_in ?? 3_600) * 1_000,
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      });
    } finally {
      await callback.close();
    }
  }

  async clear(): Promise<OAuthLogoutResult> {
    const storage = await readStorage(this.options.storagePath);
    const key = this.key();
    const record = storage.servers[key];
    let serverRevocation: OAuthLogoutResult["serverRevocation"] = "no_credentials";
    const errors: string[] = [];
    if (record) {
      try {
        const metadata = await discoverAuthorizationMetadata(
          record.authorizationServerUrl,
          this.fetcher(),
        );
        if (!metadata.revocation_endpoint) {
          serverRevocation = "unsupported";
        } else {
          assertSecureOAuthUrl(new URL(metadata.revocation_endpoint));
          const authenticationMethod = selectRevocationAuthenticationMethod(metadata);
          for (const token of [
            ...(record.refreshToken
              ? [{ value: record.refreshToken, type: "refresh_token" as const }]
              : []),
            { value: record.accessToken, type: "access_token" as const },
          ]) {
            try {
              await this.revokeToken(
                metadata.revocation_endpoint,
                token.value,
                token.type,
                record,
                authenticationMethod,
              );
            } catch (error) {
              errors.push(`${token.type}: ${errorMessage(error)}`);
            }
          }
          serverRevocation = errors.length ? "failed" : "revoked";
        }
      } catch (error) {
        serverRevocation = "failed";
        errors.push(errorMessage(error));
      }
    }
    delete storage.servers[key];
    await writeStorage(this.options.storagePath, storage);
    return {
      localCredentialsRemoved: record !== undefined,
      serverRevocation,
      ...(errors.length ? { errors } : {}),
    };
  }

  private async refresh(record: OAuthRecord): Promise<string> {
    const metadata = await discoverAuthorizationMetadata(
      record.authorizationServerUrl,
      this.fetcher(),
    );
    const tokens = await this.tokenRequest(metadata.token_endpoint, {
      grant_type: "refresh_token",
      refresh_token: record.refreshToken!,
      client_id: record.clientId,
      ...(record.clientSecret ? { client_secret: record.clientSecret } : {}),
      resource: this.options.serverUrl,
    });
    const refreshToken = tokens.refresh_token ?? record.refreshToken;
    const scope = tokens.scope ?? record.scope;
    await this.save({
      ...record,
      accessToken: tokens.access_token,
      ...(refreshToken ? { refreshToken } : {}),
      expiresAt: Date.now() + (tokens.expires_in ?? 3_600) * 1_000,
      ...(scope ? { scope } : {}),
    });
    return tokens.access_token;
  }

  private async discoverMetadata(): Promise<OAuthMetadata> {
    const issuer = this.options.config.authorizationServerUrl ??
      await discoverAuthorizationServer(this.options.serverUrl, this.fetcher());
    return discoverAuthorizationMetadata(issuer, this.fetcher());
  }

  private async resolveClient(
    metadata: OAuthMetadata,
    redirectUri: string,
  ): Promise<{ clientId: string; clientSecret?: string }> {
    if (this.options.config.clientId) {
      return {
        clientId: this.options.config.clientId,
        ...(this.options.config.clientSecret ? { clientSecret: this.options.config.clientSecret } : {}),
      };
    }
    const stored = await this.record();
    if (
      stored?.clientId &&
      stored.authorizationServerUrl === metadata.issuer &&
      stored.redirectUri === redirectUri
    ) {
      return {
        clientId: stored.clientId,
        ...(stored.clientSecret ? { clientSecret: stored.clientSecret } : {}),
      };
    }
    if (!metadata.registration_endpoint) {
      throw new Error(`OAuth server for ${this.options.serverName} requires oauth.clientId because it does not advertise dynamic client registration`);
    }
    assertSecureOAuthUrl(new URL(metadata.registration_endpoint));
    const response = await this.fetcher()(metadata.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: `tnb (${this.options.serverName})`,
        application_type: "native",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok || typeof body.client_id !== "string") {
      throw new Error(`MCP OAuth dynamic client registration failed (${response.status})`);
    }
    return {
      clientId: body.client_id,
      ...(typeof body.client_secret === "string" ? { clientSecret: body.client_secret } : {}),
    };
  }

  private async tokenRequest(endpoint: string, fields: Record<string, string>): Promise<TokenResponse> {
    assertSecureOAuthUrl(new URL(endpoint));
    const response = await this.fetcher()(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(fields),
    });
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok || typeof body.access_token !== "string") {
      const detail = typeof body.error_description === "string" ? `: ${body.error_description}` : "";
      throw new Error(`MCP OAuth token request failed (${response.status})${detail}`);
    }
    return {
      access_token: body.access_token,
      ...(typeof body.refresh_token === "string" ? { refresh_token: body.refresh_token } : {}),
      ...(typeof body.expires_in === "number" ? { expires_in: body.expires_in } : {}),
      ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
    };
  }

  private async revokeToken(
    endpoint: string,
    token: string,
    tokenType: "refresh_token" | "access_token",
    record: OAuthRecord,
    authenticationMethod: "client_secret_basic" | "client_secret_post",
  ): Promise<void> {
    const fields = new URLSearchParams({ token, token_type_hint: tokenType });
    const headers = new Headers({
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    });
    if (record.clientSecret) {
      if (authenticationMethod === "client_secret_post") {
        fields.set("client_id", record.clientId);
        fields.set("client_secret", record.clientSecret);
      } else {
        headers.set(
          "authorization",
          `Basic ${Buffer.from(`${encodeURIComponent(record.clientId)}:${encodeURIComponent(record.clientSecret)}`).toString("base64")}`,
        );
      }
    } else {
      fields.set("client_id", record.clientId);
    }
    let response = await this.fetcher()(endpoint, {
      method: "POST",
      headers,
      body: fields,
    });
    if (response.status === 401 && record.accessToken) {
      // Compatibility path used by deployed MCP servers that protect revocation
      // with the resource bearer token instead of RFC 7009 client authentication.
      fields.delete("client_id");
      fields.delete("client_secret");
      headers.set("authorization", `Bearer ${record.accessToken}`);
      await response.body?.cancel().catch(() => undefined);
      response = await this.fetcher()(endpoint, {
        method: "POST",
        headers,
        body: fields,
      });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`OAuth token revocation failed (${response.status})${detail ? `: ${detail}` : ""}`);
    }
    await response.body?.cancel().catch(() => undefined);
  }

  private async record(): Promise<OAuthRecord | undefined> {
    return (await readStorage(this.options.storagePath)).servers[this.key()];
  }

  private save(record: OAuthRecord): Promise<void> {
    return updateStorage(this.options.storagePath, this.key(), record);
  }

  private key(): string {
    return createHash("sha256").update(`${this.options.serverName}\0${this.options.serverUrl}`).digest("hex");
  }

  private fetcher(): FetchLike {
    return this.options.fetch ?? globalThis.fetch;
  }
}

async function discoverAuthorizationServer(serverUrl: string, fetcher: FetchLike): Promise<string> {
  const server = new URL(serverUrl);
  const candidates = [
    new URL(`/.well-known/oauth-protected-resource${server.pathname === "/" ? "" : server.pathname}`, server.origin),
    new URL("/.well-known/oauth-protected-resource", server.origin),
  ];
  for (const candidate of candidates) {
    const response = await fetcher(candidate, { headers: { accept: "application/json" } });
    if (!response.ok) continue;
    const body = await response.json() as Record<string, unknown>;
    if (Array.isArray(body.authorization_servers) && typeof body.authorization_servers[0] === "string") {
      return body.authorization_servers[0];
    }
  }
  throw new Error("MCP OAuth protected-resource discovery failed; configure oauth.authorizationServerUrl");
}

async function discoverAuthorizationMetadata(
  issuerValue: string,
  fetcher: FetchLike,
): Promise<OAuthMetadata> {
  const issuer = new URL(issuerValue);
  assertSecureOAuthUrl(issuer);
  const candidates = [
    new URL(`/.well-known/oauth-authorization-server${issuer.pathname === "/" ? "" : issuer.pathname}`, issuer.origin),
    new URL(`/.well-known/openid-configuration${issuer.pathname === "/" ? "" : issuer.pathname}`, issuer.origin),
  ];
  for (const candidate of candidates) {
    const response = await fetcher(candidate, { headers: { accept: "application/json" } });
    if (!response.ok) continue;
    const body = await response.json() as Record<string, unknown>;
    if (typeof body.authorization_endpoint !== "string" || typeof body.token_endpoint !== "string") continue;
    if (typeof body.issuer === "string" && new URL(body.issuer).toString() !== issuer.toString()) {
      throw new Error("OAuth authorization-server metadata issuer mismatch");
    }
    return {
      issuer: typeof body.issuer === "string" ? body.issuer : issuer.toString(),
      authorization_endpoint: body.authorization_endpoint,
      token_endpoint: body.token_endpoint,
      ...(typeof body.registration_endpoint === "string" ? { registration_endpoint: body.registration_endpoint } : {}),
      ...(Array.isArray(body.scopes_supported) && body.scopes_supported.every((item) => typeof item === "string")
        ? { scopes_supported: body.scopes_supported as string[] }
        : {}),
      ...(Array.isArray(body.code_challenge_methods_supported) && body.code_challenge_methods_supported.every((item) => typeof item === "string")
        ? { code_challenge_methods_supported: body.code_challenge_methods_supported as string[] }
        : {}),
      ...(typeof body.revocation_endpoint === "string"
        ? { revocation_endpoint: body.revocation_endpoint }
        : {}),
      ...(isStringArray(body.revocation_endpoint_auth_methods_supported)
        ? { revocation_endpoint_auth_methods_supported: body.revocation_endpoint_auth_methods_supported }
        : {}),
      ...(isStringArray(body.token_endpoint_auth_methods_supported)
        ? { token_endpoint_auth_methods_supported: body.token_endpoint_auth_methods_supported }
        : {}),
    };
  }
  throw new Error(`OAuth authorization-server metadata discovery failed for ${issuerValue}`);
}

function selectRevocationAuthenticationMethod(
  metadata: OAuthMetadata,
): "client_secret_basic" | "client_secret_post" {
  const methods = metadata.revocation_endpoint_auth_methods_supported ??
    metadata.token_endpoint_auth_methods_supported;
  return methods && !methods.includes("client_secret_basic") && methods.includes("client_secret_post")
    ? "client_secret_post"
    : "client_secret_basic";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertPkceSupport(metadata: OAuthMetadata): void {
  if (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes("S256")) {
    throw new Error("MCP OAuth server does not support the required PKCE S256 method");
  }
}

function assertSecureOAuthUrl(url: URL): void {
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`OAuth endpoint must use HTTPS unless it is loopback: ${url.origin}`);
  }
}

async function createCallbackServer(port = 0, timeoutMs = 120_000): Promise<{
  redirectUri: string;
  waitForCode(state: string, issuer: string): Promise<string>;
  close(): Promise<void>;
}> {
  let accept: ((value: { code: string; state: string; issuer?: string }) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const callback = new Promise<{ code: string; state: string; issuer?: string }>((resolve, fail) => {
    accept = resolve;
    reject = fail;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/oauth/callback") {
      response.writeHead(404).end("Not found");
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const issuer = url.searchParams.get("iss");
    if (error) reject?.(new Error(`OAuth authorization failed: ${error}`));
    else if (!code || !state) reject?.(new Error("OAuth callback omitted code or state"));
    else accept?.({ code, state, ...(issuer === null ? {} : { issuer }) });
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<p>tnb authorization received. You may close this window.</p>");
  });
  await listen(server, port);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OAuth callback server has no TCP address");
  const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
  return {
    redirectUri,
    async waitForCode(expectedState, expectedIssuer) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          callback,
          new Promise<never>((_resolve, fail) => {
            timer = setTimeout(() => fail(new Error("MCP OAuth callback timed out")), timeoutMs);
          }),
        ]);
        if (result.state !== expectedState) throw new Error("OAuth state mismatch");
        if (result.issuer !== undefined && result.issuer !== expectedIssuer) {
          throw new Error("OAuth issuer mismatch");
        }
        return result.code;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    close: () => closeServer(server),
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function openBrowser(url: string): void {
  const command = platform() === "darwin"
    ? ["open", url]
    : platform() === "win32"
      ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url];
  const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: "ignore" });
  child.once("error", () => undefined);
  child.unref();
}

async function updateStorage(path: string, key: string, record: OAuthRecord): Promise<void> {
  const storage = await readStorage(path);
  storage.servers[key] = record;
  await writeStorage(path, storage);
}

async function readStorage(path: string): Promise<StoredOAuth> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<StoredOAuth>;
    if (value.version !== 1 || typeof value.servers !== "object" || value.servers === null) {
      throw new Error(`Invalid MCP OAuth storage: ${path}`);
    }
    return value as StoredOAuth;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, servers: {} };
    }
    throw error;
  }
}

async function writeStorage(path: string, storage: StoredOAuth): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(storage, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
