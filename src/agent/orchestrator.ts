import { LlmClient } from "../llm/client.js";
import { getToolMap, tools } from "../tools/index.js";
import type {
  AgentEvent,
  AgentRunResult,
  ApprovalRequest,
  ChatMessage,
  DiffEntry,
} from "../types/agent.js";
import { ApprovalManager } from "./approval.js";
import {
  ANALYSIS_EXECUTION_ROUND_LIMIT,
  EXTERNAL_ANALYSIS_EXECUTION_ROUND_LIMIT,
  MAX_AUTO_FIX_ROUNDS,
  PARALLELIZABLE_TOOLS,
  READ_ONLY_TOOLS,
} from "./orchestrator-config.js";
import { getExecutionBudget, shouldPreferProjectMap } from "./orchestrator-intent.js";
import { OrchestratorState } from "./orchestrator-state.js";
import { clearPersistedSession, persistSession, restorePersistedSessionById } from "./orchestrator-session.js";
import { executeToolCall } from "./orchestrator-tools.js";
import type { ExecutionState } from "./orchestrator-types.js";
import { runAutoValidation } from "./orchestrator-validation.js";
import { SYSTEM_PROMPT } from "./prompts.js";

export class AgentOrchestrator {
  private llm = new LlmClient();
  private toolMap = getToolMap();
  private state = new OrchestratorState(SYSTEM_PROMPT);
  private onEvent?: (event: AgentEvent) => void;
  private approvalManager: ApprovalManager;

  constructor(options?: {
    onEvent?: (event: AgentEvent) => void;
    onConfirmCommand?: (request: ApprovalRequest) => Promise<boolean>;
  }) {
    this.onEvent = options?.onEvent;
    this.approvalManager = new ApprovalManager(options?.onConfirmCommand);
  }

  private emit(event: AgentEvent) {
    this.onEvent?.(event);
  }

  clearHistory() {
    this.state.clear(SYSTEM_PROMPT);
    clearPersistedSession().catch(() => {});
  }

  async restoreSession(id?: string): Promise<boolean> {
    return restorePersistedSessionById(this.state, id);
  }

  get turnCount(): number {
    return this.state.turnCount;
  }

  private rememberMessageFocus(message: ChatMessage) {
    this.state.rememberMessageFocus(message);
  }

  private rememberPathFocus(paths: Iterable<string>) {
    this.state.rememberPathFocus(paths);
  }

  private trimContextIfNeeded() {
    this.state.trimContextIfNeeded((event) => this.emit(event));
  }

  async run(userTask: string): Promise<AgentRunResult> {
    const userMessage: ChatMessage = { role: "user", content: userTask };
    this.state.messages.push(userMessage);
    this.rememberMessageFocus(userMessage);
    const steps: string[] = [];
    const diffs: DiffEntry[] = [];
    if (shouldPreferProjectMap(userTask)) {
      const projectMapHint: ChatMessage = {
        role: "assistant",
        content:
          "分析项目结构、关键模块或代码入口时，优先考虑先调用 project_map，再按需结合 search_text/read_file 深入查看。",
      };
      this.state.messages.push(projectMapHint);
      this.rememberMessageFocus(projectMapHint);
      steps.push("已提示模型优先使用 project_map 理解项目结构");
    }
    const modifiedPaths = new Set<string>();
    let hasModifiedFiles = false;
    let hasValidated = false;
    let autoFixRounds = 0;
    let pendingFixPrompt: string | null = null;

    const executionBudget = getExecutionBudget(userTask);
    let maxIterations = executionBudget.limit;
    let budgetReason = executionBudget.reason;
    let hasExpandedReadOnlyBudget = false;
    steps.push(`执行预算: ${maxIterations} 轮（${budgetReason}）`);

    for (let i = 0; i < maxIterations; i++) {
      if (pendingFixPrompt) {
        const retryMessage: ChatMessage = {
          role: "user",
          content: pendingFixPrompt,
        };
        this.state.messages.push(retryMessage);
        this.rememberMessageFocus(retryMessage);
        pendingFixPrompt = null;
      }

      this.trimContextIfNeeded();

      this.emit({ type: "thinking" });
      const response = await this.llm.chatStream(
        this.state.messages,
        tools,
        (event) => {
          if (event.type === "text_delta") {
            this.emit({ type: "text_delta", text: event.text });
          }
        },
      );

      const toolNames = response.toolCalls.map((call) => call.name);
      const isReadOnlyExplorationTurn =
        toolNames.length > 0 &&
        toolNames.every((name) => READ_ONLY_TOOLS.has(name));
      if (
        isReadOnlyExplorationTurn &&
        !hasModifiedFiles &&
        maxIterations < EXTERNAL_ANALYSIS_EXECUTION_ROUND_LIMIT
      ) {
        const upgradedBudget =
          toolNames.includes("import_external_file") ||
          toolNames.includes("list_files")
            ? EXTERNAL_ANALYSIS_EXECUTION_ROUND_LIMIT
            : ANALYSIS_EXECUTION_ROUND_LIMIT;
        if (upgradedBudget > maxIterations) {
          maxIterations = upgradedBudget;
          budgetReason =
            toolNames.includes("import_external_file") ||
            toolNames.includes("list_files")
              ? "检测到外部项目或文档的只读探索，自动放宽执行预算"
              : "检测到持续只读探索，自动放宽执行预算";
          if (!hasExpandedReadOnlyBudget) {
            steps.push(
              `执行预算已调整为 ${maxIterations} 轮（${budgetReason}）`,
            );
            hasExpandedReadOnlyBudget = true;
          }
        }
      }

      if (response.toolCalls.length === 0) {
        if (hasModifiedFiles && !hasValidated) {
          const validationResult = await runAutoValidation(
            {
              toolMap: this.toolMap,
              approvalManager: this.approvalManager,
              messages: this.state.messages,
              rememberMessageFocus: (message) => this.rememberMessageFocus(message),
              emit: (event) => this.emit(event),
            },
            i,
            steps,
            Array.from(modifiedPaths),
          );
          hasValidated = !validationResult.failedPrompt;
          if (validationResult.validated) {
            modifiedPaths.clear();
          }

          if (
            validationResult.failedPrompt &&
            autoFixRounds < MAX_AUTO_FIX_ROUNDS
          ) {
            autoFixRounds += 1;
            hasValidated = false;
            steps.push(`自动修复第 ${autoFixRounds} 轮`);
            this.emit({ type: "auto_fix", round: autoFixRounds });
            const autoFixMessage: ChatMessage = {
              role: "user",
              content: validationResult.failedPrompt,
            };
            this.state.messages.push(autoFixMessage);
            this.rememberMessageFocus(autoFixMessage);
            continue;
          }

          if (validationResult.failedPrompt) {
            await persistSession(this.state);
            return {
              finalText:
                "自动验证失败，且已达到最大自动修复轮数，请根据最后一次报错继续处理。",
              steps,
              diffs,
            };
          }

          continue;
        }

        await persistSession(this.state);
        return {
          finalText: response.text || "任务完成，但模型没有返回文本。",
          steps,
          diffs,
        };
      }

      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: response.text || null,
        tool_calls: response.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.argumentsText },
        })),
      };
      this.state.messages.push(assistantMessage);
      this.rememberMessageFocus(assistantMessage);

      const canParallelize =
        response.toolCalls.length > 1 &&
        response.toolCalls.every((tc) => PARALLELIZABLE_TOOLS.has(tc.name));

      if (canParallelize) {
        const results = await Promise.allSettled(
          response.toolCalls.map((call) =>
            executeToolCall(
              {
                toolMap: this.toolMap,
                approvalManager: this.approvalManager,
                rememberPathFocus: (paths) => this.rememberPathFocus(paths),
                emit: (event) => this.emit(event),
              },
              call,
              steps,
              diffs,
              modifiedPaths,
              {
                hasModifiedFiles,
                hasValidated,
                autoFixRounds,
              },
            ),
          ),
        );
        for (const [idx, result] of results.entries()) {
          const call = response.toolCalls[idx];
          const resultMsg =
            result.status === "fulfilled"
              ? result.value.message
              : `工具执行失败: ${(result as PromiseRejectedResult).reason}`;
          const toolMessage: ChatMessage = {
            role: "tool",
            tool_call_id: call.id,
            name: call.name,
            content: resultMsg,
          };
          this.state.messages.push(toolMessage);
          this.rememberMessageFocus(toolMessage);
          this.emit({
            type: "tool_result",
            name: call.name,
            result: resultMsg.slice(0, 200),
          });
          if (result.status === "fulfilled") {
            hasModifiedFiles = result.value.hasModifiedFiles;
            hasValidated = result.value.hasValidated;
            autoFixRounds = result.value.autoFixRounds;
            if (result.value.pendingFixPrompt)
              pendingFixPrompt = result.value.pendingFixPrompt;
          }
        }
      } else {
        for (const call of response.toolCalls) {
          const result = await executeToolCall(
            {
              toolMap: this.toolMap,
              approvalManager: this.approvalManager,
              rememberPathFocus: (paths) => this.rememberPathFocus(paths),
              emit: (event) => this.emit(event),
            },
            call,
            steps,
            diffs,
            modifiedPaths,
            { hasModifiedFiles, hasValidated, autoFixRounds },
          );
          const toolMessage: ChatMessage = {
            role: "tool",
            tool_call_id: call.id,
            name: call.name,
            content: result.message,
          };
          this.state.messages.push(toolMessage);
          this.rememberMessageFocus(toolMessage);
          this.emit({
            type: "tool_result",
            name: call.name,
            result: result.message.slice(0, 200),
          });
          hasModifiedFiles = result.hasModifiedFiles;
          hasValidated = result.hasValidated;
          autoFixRounds = result.autoFixRounds;
          if (result.pendingFixPrompt)
            pendingFixPrompt = result.pendingFixPrompt;
        }
      }
    }

    await persistSession(this.state);
    return {
      finalText: `达到当前任务的最大执行轮数（${maxIterations} 轮，${budgetReason}），请缩小任务范围后重试。`,
      steps,
      diffs,
    };
  }
}
