import path from "node:path";
import { getRunCommandPolicy } from "../tools/command.js";
import type {
  ApprovalRequest,
  ApprovalResponse,
  ApprovalScope,
  CommandConfirmationRequest,
  ExternalPathConfirmationRequest,
  FileImportConfirmationRequest,
} from "../types/agent.js";
import { appendCommandAudit } from "../utils/command-audit.js";
import { isPathOutsideWorkspace } from "../utils/path.js";

const EXTERNAL_PATH_TOOL_ACTIONS: Partial<
  Record<string, ExternalPathConfirmationRequest["action"]>
> = {
  list_files: "list",
  tree_files: "list",
  read_file: "read",
  inspect_file: "read",
  glob_files: "list",
  create_file: "write",
  write_file: "write",
  append_text: "write",
  insert_after: "write",
  replace_range: "write",
  replace_text: "write",
  search_text: "search",
  project_map: "read",
};

export function getApprovalExactCacheKey(request: ApprovalRequest): string {
  if (request.kind === "command") return `command:${request.command}`;
  if (request.kind === "external_file") {
    return `external_file:${request.mode}:${request.path}`;
  }
  return `external_path:${request.action}:${request.path}`;
}

function getCommandKind(command: string): string {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  const executable = parts[0] || "";
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
    return `command:${parts.slice(0, 2).join(" ") || executable}`;
  }
  if (["npx", "tsx", "node"].includes(executable)) {
    return `command:${parts.slice(0, 2).join(" ") || executable}`;
  }
  return `command:${command.trim()}`;
}

export function getApprovalKindCacheKey(request: ApprovalRequest): string {
  if (request.kind === "command") return getCommandKind(request.command);
  if (request.kind === "external_file") {
    return `external_file:${request.mode}:${path.dirname(request.path)}`;
  }
  return `external_path:${request.action}:${path.dirname(request.path)}`;
}

function normalizeApprovalResponse(response: ApprovalResponse): {
  approved: boolean;
  scope: ApprovalScope;
} {
  return typeof response === "boolean"
    ? { approved: response, scope: "once" }
    : { approved: response.approved, scope: response.scope || "once" };
}

export class ApprovalManager {
  private taskApprovals = new Set<string>();
  private taskRejections = new Set<string>();

  constructor(
    private onConfirmCommand?: (
      request: ApprovalRequest,
    ) => Promise<ApprovalResponse>,
  ) {}

  resetTaskApprovals() {
    this.taskApprovals.clear();
    this.taskRejections.clear();
  }

  getActiveTaskApprovalKeys(): string[] {
    return Array.from(this.taskApprovals).sort();
  }

  getActiveTaskRejectionKeys(): string[] {
    return Array.from(this.taskRejections).sort();
  }

  clearActiveTaskDecisions() {
    this.resetTaskApprovals();
  }

  private async requestApproval(request: ApprovalRequest): Promise<boolean> {
    const exactKey = getApprovalExactCacheKey(request);
    const kindKey = getApprovalKindCacheKey(request);
    if (this.taskRejections.has(exactKey) || this.taskRejections.has(kindKey)) {
      return false;
    }
    if (this.taskApprovals.has(exactKey) || this.taskApprovals.has(kindKey)) {
      return true;
    }
    if (!this.onConfirmCommand) return false;
    const response = normalizeApprovalResponse(
      await this.onConfirmCommand(request),
    );
    if (response.scope !== "once") {
      const key = response.scope === "task_kind" ? kindKey : exactKey;
      if (response.approved) {
        this.taskApprovals.add(key);
      } else {
        this.taskRejections.add(key);
      }
    }
    return response.approved;
  }

  async confirmCommand(
    command: string,
    steps: string[],
    source: CommandConfirmationRequest["source"] = "tool",
  ): Promise<boolean> {
    const policy = await getRunCommandPolicy(command);
    if (policy.decision !== "confirm") return true;

    steps.push(`命令需要确认: ${command} (${policy.reason})`);
    const approved = await this.requestApproval({
      kind: "command",
      command,
      reason: policy.reason,
      policy: "guarded",
      source,
    });
    await appendCommandAudit({
      timestamp: new Date().toISOString(),
      command,
      reason: policy.reason,
      decision: approved ? "approved" : "rejected",
      source,
    });
    steps.push(
      approved ? `用户已确认命令: ${command}` : `命令已拒绝: ${command}`,
    );
    return approved;
  }

  async confirmExternalPathAccess(
    toolName: string,
    targetPath: string,
    steps: string[],
  ): Promise<boolean> {
    const action = EXTERNAL_PATH_TOOL_ACTIONS[toolName];
    if (!action || !isPathOutsideWorkspace(targetPath)) return true;

    const reason =
      action === "write"
        ? "访问并修改工作区外文件可能影响当前项目外的数据，需要用户确认"
        : action === "search"
          ? "搜索工作区外目录会读取该目录下的文本内容，需要用户确认"
          : "访问工作区外路径需要用户确认";
    const auditCommand = `file_access ${toolName} ${targetPath}`;
    steps.push(
      action === "write"
        ? `工作区外文件需要确认修改: ${targetPath} (${reason})`
        : action === "search"
          ? `工作区外目录需要确认搜索: ${targetPath} (${reason})`
          : `工作区外路径需要确认打开: ${targetPath} (${reason})`,
    );

    const approved = await this.requestApproval({
      kind: "external_path",
      path: targetPath,
      action,
      reason,
    } satisfies ExternalPathConfirmationRequest);
    await appendCommandAudit({
      timestamp: new Date().toISOString(),
      command: auditCommand,
      reason,
      decision: approved ? "approved" : "rejected",
      source: "tool",
    });
    steps.push(
      approved
        ? action === "write"
          ? `用户已确认修改工作区外文件: ${targetPath}`
          : action === "search"
            ? `用户已确认搜索工作区外目录: ${targetPath}`
            : `用户已确认打开工作区外路径: ${targetPath}`
        : action === "write"
          ? `用户拒绝修改工作区外文件: ${targetPath}`
          : action === "search"
            ? `用户拒绝搜索工作区外目录: ${targetPath}`
            : `用户拒绝打开工作区外路径: ${targetPath}`,
    );
    return approved;
  }

  async confirmExternalFileImport(
    sourcePath: string,
    destinationPath: string | undefined,
    mode: "copy" | "extract_text",
    steps: string[],
  ): Promise<boolean> {
    const reason =
      "打开工作区外文件时，会先把内容缓存到工作区内再分析，需要用户确认";
    const auditCommand = `import_external_file ${sourcePath}${destinationPath ? ` -> ${destinationPath}` : ""}`;
    steps.push(`工作区外文件需要确认打开: ${sourcePath} (${reason})`);

    const approved = await this.requestApproval({
      kind: "external_file",
      path: sourcePath,
      destinationPath: destinationPath || ".imports/<auto>",
      mode,
      reason,
    } satisfies FileImportConfirmationRequest);
    await appendCommandAudit({
      timestamp: new Date().toISOString(),
      command: auditCommand,
      reason,
      decision: approved ? "approved" : "rejected",
      source: "tool",
    });
    steps.push(
      approved
        ? `用户已确认打开工作区外文件: ${sourcePath}`
        : `用户拒绝打开工作区外文件: ${sourcePath}`,
    );
    return approved;
  }
}
