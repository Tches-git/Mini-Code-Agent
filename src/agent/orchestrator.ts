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
  MODIFYING_TOOLS,
  PARALLELIZABLE_TOOLS,
  READ_ONLY_TOOLS,
} from "./orchestrator-config.js";
import {
  getExecutionBudget,
  getExecutionMode,
  getModeStrategyPrompt,
  shouldPreferProjectMap,
} from "./orchestrator-intent.js";
import {
  clearPersistedSession,
  persistSession,
  restorePersistedSessionById,
} from "./orchestrator-session.js";
import { OrchestratorState } from "./orchestrator-state.js";
import { executeToolCall } from "./orchestrator-tools.js";
import type {
  ExecutionState,
  ToolExecutionResult,
} from "./orchestrator-types.js";
import { runAutoValidation } from "./orchestrator-validation.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { setActiveTaskGraph } from "./task-context.js";
import { AgentTaskGraph } from "./task-graph.js";
import {
  captureUndoSnapshots,
  restoreUndoSnapshots,
  type UndoSnapshot,
} from "./undo.js";

export function mergeParallelToolResults(
  initialState: ExecutionState,
  results: PromiseSettledResult<ToolExecutionResult>[],
): ExecutionState & { pendingFixPrompt?: string } {
  let hasModifiedFiles = initialState.hasModifiedFiles;
  let hasValidated = initialState.hasValidated;
  let autoFixRounds = initialState.autoFixRounds;
  let pendingFixPrompt: string | undefined;

  for (const result of results) {
    if (result.status !== "fulfilled") {
      continue;
    }

    hasModifiedFiles ||= result.value.hasModifiedFiles;
    hasValidated ||= result.value.hasValidated;
    autoFixRounds = Math.max(autoFixRounds, result.value.autoFixRounds);
    if (!pendingFixPrompt && result.value.pendingFixPrompt) {
      pendingFixPrompt = result.value.pendingFixPrompt;
    }
  }

  if (hasModifiedFiles || pendingFixPrompt) {
    hasValidated = false;
  }

  return {
    hasModifiedFiles,
    hasValidated,
    autoFixRounds,
    pendingFixPrompt,
  };
}

export class AgentOrchestrator {
  private llm = new LlmClient();
  private toolMap = getToolMap();
  private state = new OrchestratorState(SYSTEM_PROMPT);
  private onEvent?: (event: AgentEvent) => void;
  private approvalManager: ApprovalManager;
  private undoStack: UndoSnapshot[][] = [];
  private taskGraph = new AgentTaskGraph();

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
    this.taskGraph.reset();
    clearPersistedSession().catch(() => {});
  }

  async restoreSession(id?: string): Promise<boolean> {
    return restorePersistedSessionById(this.state, id);
  }

  get turnCount(): number {
    return this.state.turnCount;
  }

  get canUndoLastRun(): boolean {
    return this.undoStack.length > 0;
  }

  get undoStackDepth(): number {
    return this.undoStack.length;
  }

  get taskItems() {
    return this.taskGraph.list();
  }

  get formattedTasks() {
    return this.taskGraph.format();
  }

  private rememberUndoSnapshots(snapshots: Iterable<UndoSnapshot>) {
    const snapshotList = Array.from(snapshots);
    if (snapshotList.length > 0) {
      this.undoStack.push(snapshotList);
    }
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

  async undoLastRun(): Promise<AgentRunResult> {
    const snapshots = this.undoStack.pop();
    if (!snapshots || snapshots.length === 0) {
      return {
        finalText: "没有可撤销的上一轮文件修改。",
        steps: [],
        diffs: [],
        tasks: this.taskGraph.list(),
      };
    }

    const diffs = await restoreUndoSnapshots(snapshots);
    const restoredPaths = snapshots.map((snapshot) => snapshot.path);
    return {
      finalText: `已撤销上一轮修改: ${restoredPaths.join(", ")}`,
      steps: ["已根据上一轮修改前快照恢复文件"],
      diffs,
      tasks: this.taskGraph.list(),
    };
  }

  async plan(userTask: string): Promise<AgentRunResult> {
    const planMessage: ChatMessage = {
      role: "user",
      content: [
        "请先为下面的开发任务制定执行计划，不要修改任何文件，不要运行写入或提交类命令。",
        "你可以使用只读工具理解项目；最终请输出简洁、分步骤、可执行的计划，并说明建议先验证什么。",
        `任务: ${userTask}`,
      ].join("\n"),
    };
    this.state.messages.push(planMessage);
    this.rememberMessageFocus(planMessage);
    this.taskGraph.reset(`计划：${userTask}`);
    setActiveTaskGraph(this.taskGraph);
    const steps: string[] = ["进入计划模式：仅允许只读探索，不执行文件修改"];
    const diffs: DiffEntry[] = [];
    const readOnlyTools = tools.filter(
      (tool) =>
        READ_ONLY_TOOLS.has(tool.name) && tool.name !== "import_external_file",
    );
    const readOnlyToolMap = new Map(
      readOnlyTools.map((tool) => [tool.name, tool]),
    );
    const maxIterations = ANALYSIS_EXECUTION_ROUND_LIMIT;

    for (let i = 0; i < maxIterations; i++) {
      this.trimContextIfNeeded();
      this.emit({ type: "thinking" });
      const response = await this.llm.chatStream(
        this.state.messages,
        readOnlyTools,
        (event) => {
          if (event.type === "text_delta") {
            this.emit({ type: "text_delta", text: event.text });
          }
        },
      );

      if (response.toolCalls.length === 0) {
        this.taskGraph.completeActive();
        await persistSession(this.state);
        return {
          finalText: response.text || "已进入计划模式，但模型没有返回计划。",
          steps,
          diffs,
          tasks: this.taskGraph.list(),
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

      for (const call of response.toolCalls) {
        const result = await executeToolCall(
          {
            toolMap: readOnlyToolMap,
            approvalManager: this.approvalManager,
            rememberPathFocus: (paths) => this.rememberPathFocus(paths),
            emit: (event) => this.emit(event),
          },
          call,
          steps,
          diffs,
          new Set<string>(),
          { hasModifiedFiles: false, hasValidated: false, autoFixRounds: 0 },
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
      }
    }

    this.taskGraph.blockActive();
    await persistSession(this.state);
    return {
      finalText: `计划模式达到最大只读探索轮数（${maxIterations} 轮），请缩小任务范围后重试。`,
      steps,
      diffs,
      tasks: this.taskGraph.list(),
    };
  }

  async run(userTask: string): Promise<AgentRunResult> {
    const userMessage: ChatMessage = { role: "user", content: userTask };
    this.state.messages.push(userMessage);
    this.rememberMessageFocus(userMessage);
    this.taskGraph.reset(userTask);
    setActiveTaskGraph(this.taskGraph);
    const steps: string[] = [];
    const diffs: DiffEntry[] = [];
    const executionMode = getExecutionMode(userTask);
    const modeHint: ChatMessage = {
      role: "assistant",
      content: getModeStrategyPrompt(executionMode),
    };
    this.state.messages.push(modeHint);
    this.rememberMessageFocus(modeHint);
    steps.push(`执行模式: ${executionMode}`);
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
    const undoSnapshots = new Map<string, UndoSnapshot>();
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

      for (const call of response.toolCalls) {
        this.taskGraph.add(`调用工具 ${call.name}`, "todo");
      }
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
              rememberMessageFocus: (message) =>
                this.rememberMessageFocus(message),
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
            if (hasModifiedFiles) {
              this.rememberUndoSnapshots(undoSnapshots.values());
            }
            this.taskGraph.blockActive();
            await persistSession(this.state);
            return {
              finalText:
                "自动验证失败，且已达到最大自动修复轮数，请根据最后一次报错继续处理。",
              steps,
              diffs,
              tasks: this.taskGraph.list(),
            };
          }

          continue;
        }

        if (hasModifiedFiles) {
          this.rememberUndoSnapshots(undoSnapshots.values());
        }
        this.taskGraph.completeActive();
        await persistSession(this.state);
        return {
          finalText: response.text || "任务完成，但模型没有返回文本。",
          steps,
          diffs,
          tasks: this.taskGraph.list(),
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

      const pathsToSnapshot = response.toolCalls
        .filter((call) => MODIFYING_TOOLS.has(call.name))
        .flatMap((call) => {
          try {
            const args = JSON.parse(call.argumentsText || "{}");
            return typeof args.path === "string" &&
              !undoSnapshots.has(args.path)
              ? [args.path]
              : [];
          } catch {
            return [];
          }
        });
      for (const snapshot of await captureUndoSnapshots(pathsToSnapshot)) {
        undoSnapshots.set(snapshot.path, snapshot);
      }

      if (canParallelize) {
        const initialExecutionState: ExecutionState = {
          hasModifiedFiles,
          hasValidated,
          autoFixRounds,
        };
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
              initialExecutionState,
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
        }
        const mergedState = mergeParallelToolResults(
          initialExecutionState,
          results,
        );
        hasModifiedFiles = mergedState.hasModifiedFiles;
        hasValidated = mergedState.hasValidated;
        autoFixRounds = mergedState.autoFixRounds;
        if (mergedState.pendingFixPrompt) {
          pendingFixPrompt = mergedState.pendingFixPrompt;
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

    if (hasModifiedFiles) {
      this.rememberUndoSnapshots(undoSnapshots.values());
    }
    this.taskGraph.blockActive();
    await persistSession(this.state);
    return {
      finalText: `达到当前任务的最大执行轮数（${maxIterations} 轮，${budgetReason}），请缩小任务范围后重试。`,
      steps,
      diffs,
      tasks: this.taskGraph.list(),
    };
  }
}
