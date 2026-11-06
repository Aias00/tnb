import type { WorkspaceRootSource } from "../../core/workspace-state";
import { createReadTool, createWriteTool, createEditTool, createGrepTool, createGlobTool } from "../../tools/builtins";
import { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } from "../../utils/file-state-cache";

export type WorkspaceToolOptions = {
  workspace: WorkspaceRootSource;
  allowWrite: boolean;
  media: { supportsVision: boolean; supportsPdf: boolean };
  fileRoots?: () => string[];
  searchRoots?: () => string[];
};

/** One host's read receipts are shared by its file tools, never by another host. */
export function createWorkspaceFileTools(options: WorkspaceToolOptions) {
  const reads = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE);
  return {
    read: createReadTool(options.workspace, options.media, options.fileRoots, reads),
    ...(options.allowWrite ? {
      write: createWriteTool(options.workspace, options.fileRoots, reads),
      edit: createEditTool(options.workspace, options.fileRoots, reads),
    } : {}),
    grep: createGrepTool(options.workspace, {}, options.searchRoots),
    glob: createGlobTool(options.workspace, {}, options.searchRoots),
  };
}
