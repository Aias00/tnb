import { defineTool } from "../core/tool";
import { currentWorkspaceRoot, type WorkspaceRootSource } from "../core/workspace-state";
import { scanSecurity } from "../services/security/scanner";

export function createSecurityScanTool(workspaceRoot: WorkspaceRootSource) {
  return defineTool({
    name: "security_scan",
    description: "Run the enabled local SAST rules against workspace paths. Source stays local and scanned files are never executed.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Workspace-relative files or directories. Omit to scan current Git changes." },
        all: { type: "boolean", description: "Scan the whole workspace except generated/dependency directories." },
        staged: { type: "boolean", description: "Scan staged Git changes when paths and all are omitted." },
        base_commit: { type: "string", description: "Scan files changed since this commit or ref." },
        path_glob: { type: "string", description: "Only scan files whose workspace-relative path matches this glob." },
        exclude_paths: { type: "array", items: { type: "string" }, description: "Workspace-relative path prefixes to exclude from the scan." },
      },
      additionalProperties: false,
    },
    validate(input) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("security_scan input must be an object");
      const value = input as {
        paths?: unknown;
        all?: unknown;
        staged?: unknown;
        base_commit?: unknown;
        path_glob?: unknown;
        exclude_paths?: unknown;
      };
      if (value.paths !== undefined && (!Array.isArray(value.paths) || value.paths.some((path) => typeof path !== "string" || !path))) {
        throw new Error("security_scan paths must be non-empty strings");
      }
      if (value.all !== undefined && typeof value.all !== "boolean") throw new Error("security_scan all must be boolean");
      if (value.staged !== undefined && typeof value.staged !== "boolean") throw new Error("security_scan staged must be boolean");
      if (value.base_commit !== undefined && (typeof value.base_commit !== "string" || !value.base_commit.trim())) {
        throw new Error("security_scan base_commit must be a non-empty string");
      }
      if (value.path_glob !== undefined && (typeof value.path_glob !== "string" || !value.path_glob.trim())) {
        throw new Error("security_scan path_glob must be a non-empty string");
      }
      if (
        value.exclude_paths !== undefined &&
        (!Array.isArray(value.exclude_paths) || value.exclude_paths.some((path) => typeof path !== "string" || !path))
      ) {
        throw new Error("security_scan exclude_paths must be non-empty strings");
      }
      return {
        ...(value.paths === undefined ? {} : { paths: value.paths as string[] }),
        all: value.all === true,
        staged: value.staged === true,
        ...(value.base_commit === undefined ? {} : { baseCommit: (value.base_commit as string).trim() }),
        ...(value.path_glob === undefined ? {} : { pathGlob: (value.path_glob as string).trim() }),
        ...(value.exclude_paths === undefined ? {} : { excludePaths: value.exclude_paths as string[] }),
      };
    },
    async execute(input, signal) {
      const result = await scanSecurity({ cwd: currentWorkspaceRoot(workspaceRoot), ...input, signal });
      return JSON.stringify(result, null, 2);
    },
    access: "read",
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });
}
