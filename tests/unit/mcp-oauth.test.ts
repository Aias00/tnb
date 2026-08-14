import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpOAuthClient } from "../../src/services/mcp/oauth";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("MCP OAuth logout", () => {
  test("revokes the refresh token before the access token using discovered client auth", async () => {
    const fixture = await oauthFixture({ refreshToken: "refresh-secret", clientSecret: "client-secret" });
    const revocations: Array<{ authorization: string | null; fields: URLSearchParams }> = [];
    const client = fixture.client(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes(".well-known")) {
        return Response.json(metadata({ revocation_endpoint: "https://auth.example.test/revoke" }));
      }
      revocations.push({
        authorization: request.headers.get("authorization"),
        fields: new URLSearchParams(await request.text()),
      });
      return new Response(null, { status: 200 });
    });

    expect(await client.clear()).toEqual({
      localCredentialsRemoved: true,
      serverRevocation: "revoked",
    });
    expect(revocations.map(({ fields }) => [
      fields.get("token_type_hint"),
      fields.get("token"),
    ])).toEqual([
      ["refresh_token", "refresh-secret"],
      ["access_token", "access-secret"],
    ]);
    expect(revocations[0]?.authorization).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
    expect(revocations[0]?.fields.has("client_secret")).toBe(false);
    expect(await storedServers(fixture.storagePath)).toEqual({});
  });

  test("uses client_secret_post when the revocation endpoint advertises only that method", async () => {
    const fixture = await oauthFixture({ clientSecret: "client-secret" });
    let request: Request | undefined;
    const client = fixture.client(async (input, init) => {
      const candidate = new Request(input, init);
      if (candidate.url.includes(".well-known")) {
        return Response.json(metadata({
          revocation_endpoint: "https://auth.example.test/revoke",
          revocation_endpoint_auth_methods_supported: ["client_secret_post"],
        }));
      }
      request = candidate;
      return new Response(null, { status: 200 });
    });

    expect((await client.clear()).serverRevocation).toBe("revoked");
    const fields = new URLSearchParams(await request!.text());
    expect(request!.headers.get("authorization")).toBeNull();
    expect(fields.get("client_id")).toBe("client-id");
    expect(fields.get("client_secret")).toBe("client-secret");
  });

  test("retries a 401 with bearer auth for deployed MCP revocation endpoints", async () => {
    const fixture = await oauthFixture({});
    const attempts: Array<{ authorization: string | null; fields: URLSearchParams }> = [];
    const client = fixture.client(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes(".well-known")) {
        return Response.json(metadata({ revocation_endpoint: "https://auth.example.test/revoke" }));
      }
      attempts.push({
        authorization: request.headers.get("authorization"),
        fields: new URLSearchParams(await request.text()),
      });
      return new Response(null, { status: attempts.length === 1 ? 401 : 200 });
    });

    expect((await client.clear()).serverRevocation).toBe("revoked");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.fields.get("client_id")).toBe("client-id");
    expect(attempts[1]?.authorization).toBe("Bearer access-secret");
    expect(attempts[1]?.fields.has("client_id")).toBe(false);
  });

  test("always clears local credentials when discovery or revocation fails", async () => {
    const fixture = await oauthFixture({ refreshToken: "refresh-secret" });
    const client = fixture.client(async () => {
      throw new Error("authorization server unavailable");
    });

    expect(await client.clear()).toEqual({
      localCredentialsRemoved: true,
      serverRevocation: "failed",
      errors: ["authorization server unavailable"],
    });
    expect(await storedServers(fixture.storagePath)).toEqual({});
  });

  test("reports unsupported revocation while still removing local credentials", async () => {
    const fixture = await oauthFixture({});
    const client = fixture.client(async () => Response.json(metadata({})));

    expect(await client.clear()).toEqual({
      localCredentialsRemoved: true,
      serverRevocation: "unsupported",
    });
    expect(await storedServers(fixture.storagePath)).toEqual({});
  });

  test("rejects authorization metadata from a different issuer", async () => {
    const fixture = await oauthFixture({});
    const client = fixture.client(async () => Response.json(metadata({
      issuer: "https://attacker.example.test",
    })));

    expect(await client.clear()).toEqual({
      localCredentialsRemoved: true,
      serverRevocation: "failed",
      errors: ["OAuth authorization-server metadata issuer mismatch"],
    });
    expect(await storedServers(fixture.storagePath)).toEqual({});
  });
});

async function oauthFixture(options: { refreshToken?: string; clientSecret?: string }): Promise<{
  storagePath: string;
  client(fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): McpOAuthClient;
}> {
  const directory = await mkdtemp(join(tmpdir(), "tnb-mcp-oauth-"));
  directories.push(directory);
  const storagePath = join(directory, "oauth.json");
  const serverName = "fixture";
  const serverUrl = "https://mcp.example.test/rpc";
  const key = createHash("sha256").update(`${serverName}\0${serverUrl}`).digest("hex");
  await writeFile(storagePath, JSON.stringify({
    version: 1,
    servers: {
      [key]: {
        serverName,
        serverUrl,
        authorizationServerUrl: "https://auth.example.test",
        clientId: "client-id",
        ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
        accessToken: "access-secret",
        ...(options.refreshToken ? { refreshToken: options.refreshToken } : {}),
        expiresAt: Date.now() + 60_000,
      },
    },
  }));
  return {
    storagePath,
    client: (fetch) => new McpOAuthClient({
      serverName,
      serverUrl,
      config: { clientId: "client-id" },
      storagePath,
      fetch,
    }),
  };
}

function metadata(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    issuer: "https://auth.example.test",
    authorization_endpoint: "https://auth.example.test/authorize",
    token_endpoint: "https://auth.example.test/token",
    ...extra,
  };
}

async function storedServers(path: string): Promise<Record<string, unknown>> {
  return (JSON.parse(await readFile(path, "utf8")) as { servers: Record<string, unknown> }).servers;
}
