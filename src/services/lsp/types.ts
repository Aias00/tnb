import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type TnbJsonRpcId = number | string;

export type TnbJsonRpcRequest = {
  jsonrpc: "2.0";
  id: TnbJsonRpcId;
  method: string;
  params?: unknown;
};

export type TnbJsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type TnbJsonRpcSuccess = {
  jsonrpc: "2.0";
  id: TnbJsonRpcId;
  result: unknown;
};

export type TnbJsonRpcFailure = {
  jsonrpc: "2.0";
  id: TnbJsonRpcId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type TnbJsonRpcMessage =
  | TnbJsonRpcRequest
  | TnbJsonRpcNotification
  | TnbJsonRpcSuccess
  | TnbJsonRpcFailure;

export type TnbLspSelector = {
  languageId: string;
  extensions: string[];
};

export type TnbLspServerConfig = {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  selectors: TnbLspSelector[];
  initializationOptions?: unknown;
  traceStderr?: boolean;
};

export type TnbLspServerState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error";

export type TnbLspDiagnostic = {
  message: string;
  severity: number;
  code?: string;
  source?: string;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
};

export type TnbLspFileDiagnostics = {
  serverName: string;
  filePath: string;
  uri: string;
  version?: number;
  diagnostics: TnbLspDiagnostic[];
  updatedAt: number;
  sequence: number;
};

export type TnbLspLocation = {
  filePath: string;
  uri: string;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
};

export type TnbLspSymbol = {
  name: string;
  kind: number;
  detail?: string;
  containerName?: string;
  location: TnbLspLocation;
};

export type TnbLspHover = {
  contents: string;
  range?: Omit<TnbLspLocation, "filePath" | "uri">;
};

export type TnbLspResolvedSelector = {
  config: TnbLspServerConfig;
  languageId: string;
};

export type TnbLspOpenDocument = {
  uri: string;
  languageId: string;
  version: number;
  text: string;
};

export type TnbLspSpawnHandle = {
  child: ChildProcessWithoutNullStreams;
  pid: number;
};
