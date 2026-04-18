import { getRunCommandPolicy } from "../tools/command.js";
import type {
  ApprovalRequest,
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
  read_file: "read",
  create_file: "write",
  write_file: "write",
  append_text: "write",
  insert_after: "write",
  replace_text: "write",
  search_text: "search",
  project_map: "read",
};

export class ApprovalManager {
  constructor(
    private onConfirmCommand?: (request: ApprovalRequest) => Promise<boolean>,
  ) {}

  async confirmCommand(
    command: string,
    steps: string[],
    source: CommandConfirmationRequest["source"] = "tool",
  ): Promise<boolean> {
    const policy = await getRunCommandPolicy(command);
    if (policy.decision !== "confirm") return true;

    steps.push(`命令需要确认: ${command} (${policy.reason})`);
    if (!this.onConfirmCommand) {
      steps.push(`命令已拒绝: ${command}`);
      await appendCommandAudit({
        timestamp: new Date().toISOString(),
        command,
        reason: policy.reason,
        decision: "rejected",
        source,
      });
      return false;
    }

    const approved = await this.onConfirmCommand({
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
      approved ? `用户已确认命令: ${command}` : `用户拒绝命令: ${command}`,
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

    if (!this.onConfirmCommand) {
      steps.push(
        action === "write"
          ? `工作区外文件已拒绝修改: ${targetPath}`
          : action === "search"
            ? `工作区外目录已拒绝搜索: ${targetPath}`
            : `工作区外路径已拒绝打开: ${targetPath}`,
      );
      await appendCommandAudit({
        timestamp: new Date().toISOString(),
        command: auditCommand,
        reason,
        decision: "rejected",
        source: "tool",
      });
      return false;
    }

    const approved = await this.onConfirmCommand({
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

    if (!this.onConfirmCommand) {
      steps.push(`工作区外文件已拒绝打开: ${sourcePath}`);
      await appendCommandAudit({
        timestamp: new Date().toISOString(),
        command: auditCommand,
        reason,
        decision: "rejected",
        source: "tool",
      });
      return false;
    }

    const approved = await this.onConfirmCommand({
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
