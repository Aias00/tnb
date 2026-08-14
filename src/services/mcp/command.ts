import { homedir } from "node:os";
import { join } from "node:path";

import {
  loadMcpConfig,
  loadRawMcpConfig,
  updateMcpConfig,
  validateMcpServerConfig,
  type McpHttpServerConfig,
  type McpServerConfig,
  type McpSseServerConfig,
} from "./config";
import type { McpClient } from "./client";
import { connectMcpServers } from "./manager";
import { McpOAuthClient } from "./oauth";

export async function runMcpCommand(options: {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  configDir?: string;
  cwd?: string;
  signal?: AbortSignal;
}): Promise<number> {
  try {
    const action = options.argv[1] ?? "list";
    const configDir = options.configDir ?? options.env.TNB_HOME ?? join(homedir(), ".tnb");
    const configPath = options.env.TNB_MCP_CONFIG ?? (
      options.argv.includes("--project")
        ? join(options.cwd ?? process.cwd(), ".tnb", "mcp.json")
        : join(configDir, "mcp.json")
    );
    if (action === "help" || action === "--help" || action === "-h") {
      options.stdout.write(`Usage: tnb mcp <command> [options]

Commands:
  list                         List configured servers
  get <name>                   Print one server definition
  add <name> [options] <target> [args...]
                               Add a stdio command or HTTP/SSE URL
  remove <name>                Remove a server definition
  enable <name>                Enable a configured server
  disable <name>               Disable a configured server
  resources|templates|prompts <name>
  read|watch|prompt|complete <name> ...
  auth|logout <name>

Add options:
  --transport <stdio|http|sse> Select transport (auto-detected when omitted)
  --env <NAME=value>           Set a stdio environment value (repeatable)
  --header <NAME=value>        Set an HTTP header (repeatable)
  --protocol <mode>            legacy|auto|2026-07-28
  --project                    Use <workspace>/.tnb/mcp.json

Use -- before command arguments that begin with a dash.
`);
      return 0;
    }
    if (action === "list") {
      const config = await loadRawMcpConfig(configPath);
      for (const [name, server] of Object.entries(config.mcpServers)) {
        const target = "command" in server
          ? `${server.command} ${(server.args ?? []).join(" ")}`.trim()
          : server.url;
        options.stdout.write(`${name}\t${server.enabled === false ? "disabled" : "enabled"}\t${server.type ?? "stdio"}\t${target}\n`);
      }
      return 0;
    }
    const serverName = options.argv[2];
    if (!serverName) throw new Error(`mcp ${action} requires a server name`);
    if (action === "get") {
      const server = (await loadRawMcpConfig(configPath)).mcpServers[serverName];
      if (!server) throw new Error(`Unknown MCP server: ${serverName}`);
      writeJson(options.stdout, server);
      return 0;
    }
    if (action === "add") {
      const server = parseMcpAdd(options.argv.slice(3), options.env);
      await updateMcpConfig(configPath, (servers) => {
        if (servers[serverName]) throw new Error(`MCP server already exists: ${serverName}`);
        servers[serverName] = server;
      });
      options.stdout.write(`Added MCP server ${serverName} to ${configPath}\n`);
      return 0;
    }
    if (action === "remove") {
      await updateMcpConfig(configPath, (servers) => {
        if (!servers[serverName]) throw new Error(`Unknown MCP server: ${serverName}`);
        delete servers[serverName];
      });
      options.stdout.write(`Removed MCP server ${serverName} from ${configPath}\n`);
      return 0;
    }
    if (action === "enable" || action === "disable") {
      await updateMcpConfig(configPath, (servers) => {
        const server = servers[serverName];
        if (!server) throw new Error(`Unknown MCP server: ${serverName}`);
        server.enabled = action === "enable";
      });
      options.stdout.write(`${action === "enable" ? "Enabled" : "Disabled"} MCP server ${serverName}\n`);
      return 0;
    }
    const config = await loadMcpConfig(configPath, options.env);
    const server = config.mcpServers[serverName];
    if (!server) throw new Error(`Unknown MCP server: ${serverName}`);
    if (
      action === "resources" || action === "templates" || action === "read" ||
      action === "watch" || action === "prompts" || action === "prompt" ||
      action === "complete"
    ) {
      const connections = await connectMcpServers(config, {
        cwd: options.cwd ?? process.cwd(),
        configDir,
        only: [serverName],
      });
      try {
        const client = connections.clients[serverName];
        if (!client) throw new Error(`MCP server did not connect: ${serverName}`);
        if (action === "resources") {
          writeJson(options.stdout, await client.listResources());
          return 0;
        }
        if (action === "templates") {
          writeJson(options.stdout, await client.listResourceTemplates());
          return 0;
        }
        if (action === "read") {
          const uri = options.argv[3];
          if (!uri) throw new Error("mcp read requires a resource URI");
          writeJson(options.stdout, await client.readResource(uri));
          return 0;
        }
        if (action === "watch") {
          const uri = options.argv[3];
          if (!uri) throw new Error("mcp watch requires a resource URI");
          await watchResource(client, serverName, uri, options.stdout, options.signal);
          return 0;
        }
        if (action === "prompts") {
          writeJson(options.stdout, await client.listPrompts());
          return 0;
        }
        if (action === "complete") {
          const referenceType = options.argv[3];
          const reference = options.argv[4];
          const argumentName = options.argv[5];
          const value = options.argv[6] ?? "";
          if (referenceType !== "prompt" && referenceType !== "resource") {
            throw new Error("mcp complete reference type must be prompt or resource");
          }
          if (!reference) throw new Error("mcp complete requires a prompt name or resource template URI");
          if (!argumentName) throw new Error("mcp complete requires an argument name");
          writeJson(
            options.stdout,
            await client.completeArgument(
              referenceType === "prompt"
                ? { type: "ref/prompt", name: reference }
                : { type: "ref/resource", uri: reference },
              { name: argumentName, value },
              parseStringArguments(options.argv[7], "mcp complete context"),
            ),
          );
          return 0;
        }
        const promptName = options.argv[3];
        if (!promptName) throw new Error("mcp prompt requires a prompt name");
        writeJson(
          options.stdout,
          await client.getPrompt(
            promptName,
            parseStringArguments(options.argv[4], "mcp prompt arguments"),
          ),
        );
        return 0;
      } finally {
        await connections.close();
      }
    }
    if (!isOAuthServer(server)) {
      throw new Error(`MCP server ${serverName} is not an HTTP/SSE server with oauth configuration`);
    }
    const oauth = new McpOAuthClient({
      serverName,
      serverUrl: server.url,
      config: server.oauth,
      storagePath: join(configDir, "mcp-oauth.json"),
    });
    if (action === "logout") {
      const result = await oauth.clear();
      if (result.serverRevocation === "failed") {
        options.stderr.write(
          `tnb: OAuth server revocation failed for ${serverName}; local credentials were removed${
            result.errors?.length ? `: ${result.errors.join("; ")}` : ""
          }\n`,
        );
      }
      const suffix = result.serverRevocation === "revoked"
        ? " and revoked server tokens"
        : result.serverRevocation === "unsupported"
          ? "; server does not advertise token revocation"
          : "";
      options.stdout.write(`Removed OAuth credentials for ${serverName}${suffix}\n`);
      return 0;
    }
    if (action !== "auth") throw new Error(`Unknown MCP command: ${action}`);
    await oauth.authorize({
      onAuthorizationUrl(url) {
        options.stdout.write(`Open this URL to authorize ${serverName}:\n${url}\n`);
      },
    });
    options.stdout.write(`Authorized MCP server ${serverName}\n`);
    return 0;
  } catch (error) {
    options.stderr.write(`tnb: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parseMcpAdd(
  argv: string[],
  env: Record<string, string | undefined>,
): McpServerConfig {
  let transport: "stdio" | "http" | "sse" | undefined;
  let protocol: "legacy" | "auto" | "2026-07-28" | undefined;
  const environment: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const positional: string[] = [];
  let commandArguments = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--") {
      commandArguments = true;
      continue;
    }
    if (!commandArguments && value === "--project") continue;
    if (!commandArguments && (value === "--transport" || value === "--protocol" || value === "--env" || value === "--header")) {
      const option = argv[++index];
      if (!option) throw new Error(`${value} requires a value`);
      if (value === "--transport") {
        if (option !== "stdio" && option !== "http" && option !== "sse") throw new Error("--transport must be stdio, http, or sse");
        transport = option;
      } else if (value === "--protocol") {
        if (option !== "legacy" && option !== "auto" && option !== "2026-07-28") throw new Error("--protocol must be legacy, auto, or 2026-07-28");
        protocol = option;
      } else {
        const [name, entry] = splitAssignment(option, value);
        (value === "--env" ? environment : headers)[name] = entry;
      }
      continue;
    }
    positional.push(value);
  }
  const target = positional[0];
  if (!target) throw new Error("mcp add requires a command or URL");
  const selectedTransport = transport ?? (isHttpTarget(target) ? "http" : "stdio");
  let server: McpServerConfig;
  if (selectedTransport === "stdio") {
    server = {
      command: target,
      ...(positional.length > 1 ? { args: positional.slice(1) } : {}),
      ...(Object.keys(environment).length ? { env: environment } : {}),
      ...(protocol ? { protocol } : {}),
    };
    if (Object.keys(headers).length) throw new Error("--header is only valid for HTTP and SSE servers");
  } else {
    if (positional.length > 1) throw new Error(`${selectedTransport} MCP servers accept one URL target`);
    if (Object.keys(environment).length) throw new Error("--env is only valid for stdio servers");
    if (selectedTransport === "sse" && protocol && protocol !== "legacy") {
      throw new Error("SSE transport only supports the legacy protocol");
    }
    const remote = {
      url: target,
      ...(Object.keys(headers).length ? { headers } : {}),
    };
    server = selectedTransport === "sse"
      ? { type: "sse", ...remote, ...(protocol ? { protocol: "legacy" as const } : {}) }
      : { type: "http", ...remote, ...(protocol ? { protocol } : {}) };
  }
  return validateMcpServerConfig(server, env);
}

function splitAssignment(value: string, option: string): [string, string] {
  const separator = value.indexOf("=");
  if (separator < 1) throw new Error(`${option} must use NAME=value`);
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function isHttpTarget(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

async function watchResource(
  client: McpClient,
  serverName: string,
  uri: string,
  stdout: { write(text: string): unknown },
  signal?: AbortSignal,
): Promise<void> {
  const controller = signal ?? new AbortController().signal;
  controller.throwIfAborted();
  const stop = client.onResourceUpdated((updatedUri) => {
    stdout.write(`${JSON.stringify({ server: serverName, uri: updatedUri })}\n`);
  });
  try {
    await client.subscribeResource(uri, controller);
    stdout.write(`${JSON.stringify({ server: serverName, subscribed: uri })}\n`);
    await new Promise<void>((resolve) => {
      if (controller.aborted) resolve();
      else controller.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    stop();
    if (!controller.aborted) await client.unsubscribeResource(uri);
  }
}

function writeJson(stdout: { write(text: string): unknown }, value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseStringArguments(value: string | undefined, label: string): Record<string, string> {
  if (value === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  for (const [name, argument] of Object.entries(parsed)) {
    if (typeof argument !== "string") {
      throw new Error(`${label} value ${name} must be a string`);
    }
  }
  return parsed as Record<string, string>;
}

function isOAuthServer(
  server: unknown,
): server is (McpHttpServerConfig | McpSseServerConfig) & { oauth: NonNullable<McpHttpServerConfig["oauth"]> } {
  return (
    typeof server === "object" &&
    server !== null &&
    ((server as { type?: unknown }).type === "http" || (server as { type?: unknown }).type === "sse") &&
    typeof (server as { oauth?: unknown }).oauth === "object" &&
    (server as { oauth?: unknown }).oauth !== null
  );
}
