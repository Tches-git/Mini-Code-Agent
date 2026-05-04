import type { ChatMessage, ToolDefinition } from "../types/agent.js";
import type { AutoValidationResult } from "./orchestrator-types.js";
import {
  buildFailurePrompt,
  type CommandResult,
  getDiagnosticsForValidationCommand,
  getValidationPlan,
  getValidationReplayCommand,
  parseCommandResult,
  shouldRetryValidationWithFallback,
} from "./validation.js";

function normalizeToolResult(raw: string | { message: string }): {
  message: string;
} {
  return typeof raw === "string" ? { message: raw } : { message: raw.message };
}

export async function runAutoValidation(
  dependencies: {
    toolMap: Map<string, ToolDefinition>;
    approvalManager: {
      confirmCommand: (
        command: string,
        steps: string[],
        source: "tool" | "auto_validate",
      ) => Promise<boolean>;
    };
    messages: ChatMessage[];
    rememberMessageFocus: (message: ChatMessage) => void;
    emit: (
      event:
        | { type: "auto_validate"; command: string }
        | { type: "auto_validate_skipped"; reason: string },
    ) => void;
  },
  iteration: number,
  steps: string[],
  changedPaths: string[],
): Promise<AutoValidationResult> {
  const runCommandTool = dependencies.toolMap.get("run_command");
  if (!runCommandTool) {
    return {};
  }

  const plan = await getValidationPlan(changedPaths);
  if (plan.commands.length === 0) {
    steps.push(`自动验证跳过: ${plan.reason}`);
    dependencies.emit({ type: "auto_validate_skipped", reason: plan.reason });
    return { skipped: true, validated: true };
  }

  steps.push(`自动验证计划: ${plan.reason}`);
  for (const [index, step] of plan.steps.entries()) {
    const runValidationCommand = async (
      command: string,
      attemptLabel?: string,
    ): Promise<CommandResult | null> => {
      const approved = await dependencies.approvalManager.confirmCommand(
        command,
        steps,
        "auto_validate",
      );
      if (!approved) {
        steps.push(`自动验证已取消: ${command}`);
        return null;
      }

      steps.push(
        attemptLabel
          ? `自动验证${attemptLabel}: ${command}`
          : `自动验证: ${command}`,
      );
      dependencies.emit({ type: "auto_validate", command });
      const rawResult = await runCommandTool.execute({
        command,
        confirmed: true,
      });
      const { message: validateMsg } = normalizeToolResult(rawResult);
      const autoValidateCallId = `auto-validate-${iteration}-${index}${attemptLabel ? "-fallback" : ""}`;

      const autoValidateMessage: ChatMessage = {
        role: "assistant",
        content: `代码已修改，系统自动补充执行验证命令：${command}`,
        tool_calls: [
          {
            id: autoValidateCallId,
            type: "function" as const,
            function: {
              name: "run_command",
              arguments: JSON.stringify({ command, confirmed: true }),
            },
          },
        ],
      };
      dependencies.messages.push(autoValidateMessage);
      dependencies.rememberMessageFocus(autoValidateMessage);
      const autoValidateToolMessage: ChatMessage = {
        role: "tool",
        tool_call_id: autoValidateCallId,
        name: "run_command",
        content: validateMsg,
      };
      dependencies.messages.push(autoValidateToolMessage);
      dependencies.rememberMessageFocus(autoValidateToolMessage);
      return parseCommandResult(validateMsg);
    };

    const primaryResult = await runValidationCommand(step.command);
    if (!primaryResult) {
      return { skipped: true, validated: true };
    }
    if (
      shouldRetryValidationWithFallback(
        step.command,
        primaryResult,
        step.fallbackCommand,
      )
    ) {
      steps.push(
        `定向测试命令疑似不受支持，回退到完整测试: ${step.fallbackCommand}`,
      );
      const fallbackResult = await runValidationCommand(
        step.fallbackCommand as string,
        "（回退）",
      );
      if (!fallbackResult) {
        return { skipped: true, validated: true };
      }
      if (fallbackResult.exitCode && fallbackResult.exitCode !== 0) {
        const diagnostics = await getDiagnosticsForValidationCommand(
          step.fallbackCommand as string,
        );
        return {
          failedPrompt: buildFailurePrompt(fallbackResult, diagnostics),
        };
      }
      continue;
    }

    if (primaryResult.exitCode && primaryResult.exitCode !== 0) {
      const replayCommand = getValidationReplayCommand(step, primaryResult);
      if (replayCommand && replayCommand !== step.command) {
        steps.push(`根据失败输出重放受影响测试: ${replayCommand}`);
        const replayResult = await runValidationCommand(
          replayCommand,
          "（失败重放）",
        );
        if (!replayResult) {
          return { skipped: true, validated: true };
        }
        if (!replayResult.exitCode || replayResult.exitCode === 0) {
          continue;
        }
        const diagnostics =
          await getDiagnosticsForValidationCommand(replayCommand);
        return { failedPrompt: buildFailurePrompt(replayResult, diagnostics) };
      }
      const diagnostics = await getDiagnosticsForValidationCommand(
        step.command,
      );
      return { failedPrompt: buildFailurePrompt(primaryResult, diagnostics) };
    }
  }

  return { validated: true };
}
