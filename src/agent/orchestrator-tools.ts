import type { ToolDefinition } from "../types/agent.js";
import { isPathOutsideWorkspace } from "../utils/path.js";
import {
  buildFailurePrompt,
  getDiagnosticsForValidationCommand,
  isValidationCommand,
  parseCommandResult,
} from "./validation.js";
import { MAX_AUTO_FIX_ROUNDS, MODIFYING_TOOLS } from "./orchestrator-config.js";
import type { ExecutionState, ToolExecutionResult } from "./orchestrator-types.js";
import type { ApprovalManager } from "./approval.js";
import type { DiffEntry, ToolResult } from "../types/agent.js";

function normalizeToolResult(raw: string | ToolResult): {
  message: string;
  diff?: DiffEntry;
} {
  if (typeof raw === "string") return { message: raw };
  return { message: raw.message, diff: raw.diff };
}

export async function executeToolCall(
  dependencies: {
    toolMap: Map<string, ToolDefinition>;
    approvalManager: ApprovalManager;
    rememberPathFocus: (paths: Iterable<string>) => void;
    emit: (event:
      | { type: "tool_call"; name: string; args: string }
      | { type: "tool_error"; name: string; error: string }
      | { type: "file_modified"; diff?: DiffEntry }
      | { type: "auto_fix"; round: number }) => void;
  },
  call: { id: string; name: string; argumentsText: string },
  steps: string[],
  diffs: DiffEntry[],
  modifiedPaths: Set<string>,
  state: ExecutionState,
): Promise<ToolExecutionResult> {
  const tool = dependencies.toolMap.get(call.name);
  if (!tool) {
    throw new Error(`未知工具: ${call.name}`);
  }

  let { hasModifiedFiles, hasValidated, autoFixRounds } = state;
  let pendingFixPrompt: string | undefined;
  let resultMsg = "";

  try {
    const args = JSON.parse(call.argumentsText || "{}");
    steps.push(`调用工具 ${call.name}: ${call.argumentsText}`);
    dependencies.emit({ type: "tool_call", name: call.name, args: call.argumentsText });

    const externalPathArg =
      typeof args.path === "string"
        ? args.path
        : typeof args.sourcePath === "string"
          ? args.sourcePath
          : undefined;
    if (externalPathArg && call.name !== "import_external_file") {
      const approved = await dependencies.approvalManager.confirmExternalPathAccess(
        call.name,
        externalPathArg,
        steps,
      );
      if (!approved) {
        return {
          message: `工作区外路径未访问，用户拒绝确认: ${externalPathArg}`,
          hasModifiedFiles,
          hasValidated,
          autoFixRounds,
        };
      }
      if (isPathOutsideWorkspace(externalPathArg)) {
        args.confirmed = true;
      }
    }

    if (call.name === "run_command") {
      const command = typeof args.command === "string" ? args.command : "";
      if (command) {
        const approved = await dependencies.approvalManager.confirmCommand(
          command,
          steps,
          "tool",
        );
        if (!approved) {
          return {
            message: `命令未执行，用户拒绝确认: ${command}`,
            hasModifiedFiles,
            hasValidated,
            autoFixRounds,
          };
        }
        args.confirmed = true;
      }
    }

    if (call.name === "import_external_file") {
      const sourcePath = typeof args.sourcePath === "string" ? args.sourcePath : "";
      if (sourcePath) {
        const sourcePathLower = sourcePath.toLowerCase();
        const mode =
          args.mode === "copy"
            ? "copy"
            : args.mode === "extract_text"
              ? "extract_text"
              : /\.(doc|docx|odt|rtf|xls|xlsx|xlsm|xltx|xltm|ods|ppt|pptx|pptm|potx|potm|odp|pdf|numbers|pages|key)$/.test(
                    sourcePathLower,
                  )
                ? "extract_text"
                : "copy";
        const destinationPath =
          typeof args.destinationPath === "string" ? args.destinationPath : undefined;
        const approved = await dependencies.approvalManager.confirmExternalFileImport(
          sourcePath,
          destinationPath,
          mode,
          steps,
        );
        if (!approved) {
          return {
            message: `工作区外文件未打开，用户拒绝确认: ${sourcePath}`,
            hasModifiedFiles,
            hasValidated,
            autoFixRounds,
          };
        }
        args.confirmed = true;
        if (!args.mode) {
          args.mode = mode;
        }
      }
    }

    const rawResult = await tool.execute(args);
    const { message, diff } = normalizeToolResult(rawResult);
    resultMsg = message;
    if (diff) diffs.push(diff);
    if (MODIFYING_TOOLS.has(call.name)) {
      hasModifiedFiles = true;
      hasValidated = false;
      const modifiedPath =
        diff?.path || (typeof args.path === "string" ? args.path : undefined);
      if (modifiedPath) {
        modifiedPaths.add(modifiedPath);
        dependencies.rememberPathFocus([modifiedPath]);
      }
      dependencies.emit({ type: "file_modified", diff });
    }
    if (call.name === "run_command") {
      const command = typeof args.command === "string" ? args.command : "";
      const isValidationRun = isValidationCommand(command);
      if (isValidationRun) {
        hasValidated = true;
      }
      const parsed = parseCommandResult(resultMsg);
      if (isValidationRun && !parsed?.exitCode) {
        modifiedPaths.clear();
      }
      if (
        isValidationRun &&
        parsed?.exitCode &&
        parsed.exitCode !== 0 &&
        autoFixRounds < MAX_AUTO_FIX_ROUNDS
      ) {
        autoFixRounds += 1;
        hasValidated = false;
        steps.push(`自动修复第 ${autoFixRounds} 轮`);
        dependencies.emit({ type: "auto_fix", round: autoFixRounds });
        const diagnostics = await getDiagnosticsForValidationCommand(command);
        pendingFixPrompt = buildFailurePrompt(parsed, diagnostics);
      }
    }
  } catch (error) {
    resultMsg = `工具执行失败: ${error instanceof Error ? error.message : String(error)}`;
    steps.push(`${call.name} 执行失败`);
    dependencies.emit({ type: "tool_error", name: call.name, error: resultMsg });
  }

  return {
    message: resultMsg,
    hasModifiedFiles,
    hasValidated,
    autoFixRounds,
    pendingFixPrompt,
  };
}
