import { LlmClient } from "../llm/client.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { getToolMap, tools } from "../tools/index.js";
import type {
  AgentRunResult,
  AgentEvent,
  ChatMessage,
  DiffEntry,
  ToolResult,
  ApprovalRequest
} from "../types/agent.js";
import {
  compactSummaryLines,
  deriveFocusFromMessage,
  deriveFocusFromPaths,
  mergeSummaryFocus,
  summarizeRemovedMessage,
  type SummaryFocus
} from "./summary.js";
import {
  buildFailurePrompt,
  getValidationPlan,
  isValidationCommand,
  parseCommandResult
} from "./validation.js";
import { trimMessagesWithMetadata, estimateTotalTokens, SUMMARY_MESSAGE_PREFIX, isSummaryMessage } from "../utils/token.js";
import { isPathOutsideWorkspace } from "../utils/path.js";
import { ApprovalManager } from "./approval.js";
import { saveSession, loadSession, clearSession } from "./session.js";

const MODIFYING_TOOLS = new Set([
  "create_file",
  "write_file",
  "append_text",
  "insert_after",
  "replace_text",
  "import_external_file"
]);

const MAX_AUTO_FIX_ROUNDS = 2;
const MAX_CONTEXT_TOKENS = parseInt(process.env.MAX_CONTEXT_TOKENS || "100000", 10);
const MAX_SUMMARY_LINES = 18;
const DEFAULT_EXECUTION_ROUND_LIMIT = parseInt(process.env.MAX_EXECUTION_ROUNDS || "12", 10);
const MIXED_EXECUTION_ROUND_LIMIT = Math.max(DEFAULT_EXECUTION_ROUND_LIMIT, parseInt(process.env.MAX_MIXED_EXECUTION_ROUNDS || "16", 10));
const ANALYSIS_EXECUTION_ROUND_LIMIT = Math.max(MIXED_EXECUTION_ROUND_LIMIT, parseInt(process.env.MAX_ANALYSIS_EXECUTION_ROUNDS || "20", 10));
const EXTERNAL_ANALYSIS_EXECUTION_ROUND_LIMIT = Math.max(ANALYSIS_EXECUTION_ROUND_LIMIT, parseInt(process.env.MAX_EXTERNAL_ANALYSIS_EXECUTION_ROUNDS || "24", 10));
const READ_ONLY_TOOLS = new Set(["list_files", "read_file", "search_text", "import_external_file"]);
const PARALLELIZABLE_TOOLS = new Set(["list_files", "read_file", "search_text"]);

function normalizeToolResult(raw: string | ToolResult): { message: string; diff?: DiffEntry } {
  if (typeof raw === "string") return { message: raw };
  return { message: raw.message, diff: raw.diff };
}

function getExecutionBudget(userTask: string): { limit: number; reason: string } {
  const normalized = userTask.toLowerCase();
  const hasWriteIntent = /(修改|编辑|修复|实现|新增|重构|更新|追加|替换|写入|生成|创建|删除|fix|edit|modify|write|append|replace|implement|create|refactor|update|generate|delete)/i.test(normalized);
  const hasAnalysisIntent = /(分析|总结|解释|查看|读取|搜索|查找|列出|浏览|打开|审查|analy[sz]e|summari[sz]e|explain|read|search|find|list|open|inspect|review)/i.test(normalized);
  const mentionsExternalPath = /(^|[\s"'`(])\/[^\s"'`)]+/.test(userTask)
    || /\.(doc|docx|odt|rtf|xls|xlsx|xlsm|xltx|xltm|ods|ppt|pptx|pptm|potx|potm|odp|pdf|txt|md|csv|json|yaml|yml)\b/i.test(normalized);
  const mentionsProjectScope = /(项目|工程|代码库|仓库|目录|文件夹|repo|repository|project|codebase|workspace|folder|directory)/i.test(normalized);

  if (hasWriteIntent) return { limit: DEFAULT_EXECUTION_ROUND_LIMIT, reason: "写入或修复类任务使用默认执行预算" };
  if (hasAnalysisIntent && mentionsExternalPath && mentionsProjectScope) return { limit: EXTERNAL_ANALYSIS_EXECUTION_ROUND_LIMIT, reason: "外部项目或目录分析任务使用扩展执行预算" };
  if (hasAnalysisIntent && mentionsExternalPath) return { limit: ANALYSIS_EXECUTION_ROUND_LIMIT, reason: "外部文件分析任务使用分析执行预算" };
  if (hasAnalysisIntent) return { limit: MIXED_EXECUTION_ROUND_LIMIT, reason: "只读分析任务使用放宽后的执行预算" };
  return { limit: DEFAULT_EXECUTION_ROUND_LIMIT, reason: "通用任务使用默认执行预算" };
}

export class AgentOrchestrator {
  private llm = new LlmClient();
  private toolMap = getToolMap();
  private messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  private onEvent?: (event: AgentEvent) => void;
  private approvalManager: ApprovalManager;
  private summaryLines: string[] = [];
  private summaryFocus: SummaryFocus = { files: [], keywords: [] };

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
    this.summaryLines = [];
    this.summaryFocus = { files: [], keywords: [] };
    this.messages = [{ role: "system", content: SYSTEM_PROMPT }];
    clearSession().catch(() => {});
  }

  async restoreSession(): Promise<boolean> {
    const data = await loadSession();
    if (!data || data.messages.length === 0) return false;
    this.messages = data.messages;
    this.summaryLines = data.summaryLines;
    this.summaryFocus = data.summaryFocus;
    return true;
  }

  get turnCount(): number {
    return this.messages.filter((m) => m.role === "user").length;
  }

  private syncSummaryMessage() {
    this.messages = this.messages.filter((message, index) => index === 0 || !isSummaryMessage(message));
    if (this.summaryLines.length === 0) return;

    this.messages.splice(1, 0, {
      role: "assistant",
      content: `${SUMMARY_MESSAGE_PREFIX}\n${this.summaryLines.map((line) => `- ${line}`).join("\n")}`
    });
  }

  private mergeSummary(removedMessages: ChatMessage[]) {
    const newLines = removedMessages.flatMap((message) => summarizeRemovedMessage(message));
    if (newLines.length === 0) return;

    this.summaryLines = compactSummaryLines([...this.summaryLines, ...newLines], this.summaryFocus, MAX_SUMMARY_LINES);
    this.syncSummaryMessage();
  }

  private rememberMessageFocus(message: ChatMessage) {
    this.summaryFocus = mergeSummaryFocus(this.summaryFocus, deriveFocusFromMessage(message));
  }

  private rememberPathFocus(paths: Iterable<string>) {
    this.summaryFocus = mergeSummaryFocus(this.summaryFocus, deriveFocusFromPaths(paths));
  }

  private trimContextIfNeeded() {
    let removedCount = 0;

    for (let attempt = 0; attempt < 3; attempt++) {
      const trimResult = trimMessagesWithMetadata(this.messages, MAX_CONTEXT_TOKENS);
      this.messages = trimResult.messages;
      removedCount += trimResult.removed.length;
      if (trimResult.removed.length === 0) break;
      this.mergeSummary(trimResult.removed);
    }

    if (removedCount > 0) {
      this.emit({
        type: "context_trimmed",
        removed: removedCount,
        totalTokens: estimateTotalTokens(this.messages)
      });
    }
  }


  private async executeToolCall(
    call: { id: string; name: string; argumentsText: string },
    steps: string[],
    diffs: DiffEntry[],
    modifiedPaths: Set<string>,
    state: { hasModifiedFiles: boolean; hasValidated: boolean; autoFixRounds: number }
  ): Promise<{ message: string; hasModifiedFiles: boolean; hasValidated: boolean; autoFixRounds: number; pendingFixPrompt?: string }> {
    const tool = this.toolMap.get(call.name);
    if (!tool) {
      throw new Error(`未知工具: ${call.name}`);
    }

    let { hasModifiedFiles, hasValidated, autoFixRounds } = state;
    let pendingFixPrompt: string | undefined;
    let resultMsg = "";

    try {
      const args = JSON.parse(call.argumentsText || "{}");
      steps.push(`调用工具 ${call.name}: ${call.argumentsText}`);
      this.emit({ type: "tool_call", name: call.name, args: call.argumentsText });

      const externalPathArg = typeof args.path === "string" ? args.path : typeof args.sourcePath === "string" ? args.sourcePath : undefined;
      if (externalPathArg && call.name !== "import_external_file") {
        const approved = await this.approvalManager.confirmExternalPathAccess(call.name, externalPathArg, steps);
        if (!approved) {
          return { message: `工作区外路径未访问，用户拒绝确认: ${externalPathArg}`, hasModifiedFiles, hasValidated, autoFixRounds };
        }
        if (isPathOutsideWorkspace(externalPathArg)) {
          args.confirmed = true;
        }
      }

      if (call.name === "run_command") {
        const command = typeof args.command === "string" ? args.command : "";
        if (command) {
          const approved = await this.approvalManager.confirmCommand(command, steps, "tool");
          if (!approved) {
            return { message: `命令未执行，用户拒绝确认: ${command}`, hasModifiedFiles, hasValidated, autoFixRounds };
          }
          args.confirmed = true;
        }
      }

      if (call.name === "import_external_file") {
        const sourcePath = typeof args.sourcePath === "string" ? args.sourcePath : "";
        if (sourcePath) {
          const sourcePathLower = sourcePath.toLowerCase();
          const mode = args.mode === "copy"
            ? "copy"
            : args.mode === "extract_text"
              ? "extract_text"
              : /\.(doc|docx|odt|rtf|xls|xlsx|xlsm|xltx|xltm|ods|ppt|pptx|pptm|potx|potm|odp|pdf|numbers|pages|key)$/.test(sourcePathLower)
                ? "extract_text"
                : "copy";
          const destinationPath = typeof args.destinationPath === "string" ? args.destinationPath : undefined;
          const approved = await this.approvalManager.confirmExternalFileImport(sourcePath, destinationPath, mode, steps);
          if (!approved) {
            return { message: `工作区外文件未打开，用户拒绝确认: ${sourcePath}`, hasModifiedFiles, hasValidated, autoFixRounds };
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
        const modifiedPath = diff?.path || (typeof args.path === "string" ? args.path : undefined);
        if (modifiedPath) {
          modifiedPaths.add(modifiedPath);
          this.rememberPathFocus([modifiedPath]);
        }
        this.emit({ type: "file_modified", diff });
      }
      if (call.name === "run_command") {
        const command = typeof args.command === "string" ? args.command : "";
        const isValidationRun = isValidationCommand(command);
        if (isValidationRun) {
          hasValidated = true;
        }
        const parsed = parseCommandResult(resultMsg);
        if (isValidationRun && (!parsed || !parsed.exitCode)) {
          modifiedPaths.clear();
        }
        if (isValidationRun && parsed && parsed.exitCode && parsed.exitCode !== 0 && autoFixRounds < MAX_AUTO_FIX_ROUNDS) {
          autoFixRounds += 1;
          hasValidated = false;
          steps.push(`自动修复第 ${autoFixRounds} 轮`);
          this.emit({ type: "auto_fix", round: autoFixRounds });
          pendingFixPrompt = buildFailurePrompt(parsed);
        }
      }
    } catch (error) {
      resultMsg = `工具执行失败: ${error instanceof Error ? error.message : String(error)}`;
      steps.push(`${call.name} 执行失败`);
      this.emit({ type: "tool_error", name: call.name, error: resultMsg });
    }

    return { message: resultMsg, hasModifiedFiles, hasValidated, autoFixRounds, pendingFixPrompt };
  }

  private async runAutoValidation(
    iteration: number,
    steps: string[],
    changedPaths: string[]
  ): Promise<{ failedPrompt?: string; skipped?: boolean; validated?: boolean }> {
    const runCommandTool = this.toolMap.get("run_command");
    if (!runCommandTool) {
      return {};
    }

    const plan = await getValidationPlan(changedPaths);
    if (plan.commands.length === 0) {
      steps.push(`自动验证跳过: ${plan.reason}`);
      this.emit({ type: "auto_validate_skipped", reason: plan.reason });
      return { skipped: true, validated: true };
    }

    steps.push(`自动验证计划: ${plan.reason}`);
    const commands = plan.commands;
    for (const [index, command] of commands.entries()) {
      const approved = await this.approvalManager.confirmCommand(command, steps, "auto_validate");
      if (!approved) {
        steps.push(`自动验证已取消: ${command}`);
        return { skipped: true, validated: true };
      }

      steps.push(`自动验证: ${command}`);
      this.emit({ type: "auto_validate", command });
      const rawResult = await runCommandTool.execute({ command, confirmed: true });
      const { message: validateMsg } = normalizeToolResult(rawResult);
      const autoValidateCallId = `auto-validate-${iteration}-${index}`;

      const autoValidateMessage: ChatMessage = {
        role: "assistant",
        content: `代码已修改，系统自动补充执行验证命令：${command}`,
        tool_calls: [{
          id: autoValidateCallId,
          type: "function" as const,
          function: { name: "run_command", arguments: JSON.stringify({ command, confirmed: true }) }
        }]
      };
      this.messages.push(autoValidateMessage);
      this.rememberMessageFocus(autoValidateMessage);
      const autoValidateToolMessage: ChatMessage = {
        role: "tool",
        tool_call_id: autoValidateCallId,
        name: "run_command",
        content: validateMsg
      };
      this.messages.push(autoValidateToolMessage);
      this.rememberMessageFocus(autoValidateToolMessage);

      const parsed = parseCommandResult(validateMsg);
      if (parsed && parsed.exitCode && parsed.exitCode !== 0) {
        return { failedPrompt: buildFailurePrompt(parsed) };
      }
    }

    return { validated: true };
  }

  private async persistSession(): Promise<void> {
    try {
      await saveSession({
        messages: this.messages,
        summaryLines: this.summaryLines,
        summaryFocus: this.summaryFocus
      });
    } catch {
      // 保存失败时静默忽略，不影响正常执行
    }
  }

  async run(userTask: string): Promise<AgentRunResult> {
    const userMessage: ChatMessage = { role: "user", content: userTask };
    this.messages.push(userMessage);
    this.rememberMessageFocus(userMessage);
    const steps: string[] = [];
    const diffs: DiffEntry[] = [];
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
        const retryMessage: ChatMessage = { role: "user", content: pendingFixPrompt };
        this.messages.push(retryMessage);
        this.rememberMessageFocus(retryMessage);
        pendingFixPrompt = null;
      }

      this.trimContextIfNeeded();

      this.emit({ type: "thinking" });
      const response = await this.llm.chatStream(this.messages, tools, (event) => {
        if (event.type === "text_delta") {
          this.emit({ type: "text_delta", text: event.text });
        }
      });

      const toolNames = response.toolCalls.map((call) => call.name);
      const isReadOnlyExplorationTurn = toolNames.length > 0 && toolNames.every((name) => READ_ONLY_TOOLS.has(name));
      if (isReadOnlyExplorationTurn && !hasModifiedFiles && maxIterations < EXTERNAL_ANALYSIS_EXECUTION_ROUND_LIMIT) {
        const upgradedBudget = toolNames.includes("import_external_file") || toolNames.includes("list_files")
          ? EXTERNAL_ANALYSIS_EXECUTION_ROUND_LIMIT
          : ANALYSIS_EXECUTION_ROUND_LIMIT;
        if (upgradedBudget > maxIterations) {
          maxIterations = upgradedBudget;
          budgetReason = toolNames.includes("import_external_file") || toolNames.includes("list_files")
            ? "检测到外部项目或文档的只读探索，自动放宽执行预算"
            : "检测到持续只读探索，自动放宽执行预算";
          if (!hasExpandedReadOnlyBudget) {
            steps.push(`执行预算已调整为 ${maxIterations} 轮（${budgetReason}）`);
            hasExpandedReadOnlyBudget = true;
          }
        }
      }

      if (response.toolCalls.length === 0) {
        if (hasModifiedFiles && !hasValidated) {
          const validationResult = await this.runAutoValidation(i, steps, Array.from(modifiedPaths));
          hasValidated = !validationResult.failedPrompt;
          if (validationResult.validated) {
            modifiedPaths.clear();
          }

          if (validationResult.failedPrompt && autoFixRounds < MAX_AUTO_FIX_ROUNDS) {
            autoFixRounds += 1;
            hasValidated = false;
            steps.push(`自动修复第 ${autoFixRounds} 轮`);
            this.emit({ type: "auto_fix", round: autoFixRounds });
            const autoFixMessage: ChatMessage = {
              role: "user",
              content: validationResult.failedPrompt
            };
            this.messages.push(autoFixMessage);
            this.rememberMessageFocus(autoFixMessage);
            continue;
          }

          if (validationResult.failedPrompt) {
            await this.persistSession();
            return {
              finalText: "自动验证失败，且已达到最大自动修复轮数，请根据最后一次报错继续处理。",
              steps,
              diffs
            };
          }

          continue;
        }

        await this.persistSession();
        return {
          finalText: response.text || "任务完成，但模型没有返回文本。",
          steps,
          diffs
        };
      }

      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: response.text || null,
        tool_calls: response.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.argumentsText }
        }))
      };
      this.messages.push(assistantMessage);
      this.rememberMessageFocus(assistantMessage);

      const canParallelize = response.toolCalls.length > 1
        && response.toolCalls.every((tc) => PARALLELIZABLE_TOOLS.has(tc.name));

      if (canParallelize) {
        const results = await Promise.allSettled(
          response.toolCalls.map((call) =>
            this.executeToolCall(call, steps, diffs, modifiedPaths, { hasModifiedFiles, hasValidated, autoFixRounds })
          )
        );
        for (const [idx, result] of results.entries()) {
          const call = response.toolCalls[idx];
          const resultMsg = result.status === "fulfilled" ? result.value.message : `工具执行失败: ${(result as PromiseRejectedResult).reason}`;
          const toolMessage: ChatMessage = { role: "tool", tool_call_id: call.id, name: call.name, content: resultMsg };
          this.messages.push(toolMessage);
          this.rememberMessageFocus(toolMessage);
          this.emit({ type: "tool_result", name: call.name, result: resultMsg.slice(0, 200) });
          if (result.status === "fulfilled") {
            hasModifiedFiles = result.value.hasModifiedFiles;
            hasValidated = result.value.hasValidated;
            autoFixRounds = result.value.autoFixRounds;
            if (result.value.pendingFixPrompt) pendingFixPrompt = result.value.pendingFixPrompt;
          }
        }
      } else {
        for (const call of response.toolCalls) {
          const result = await this.executeToolCall(call, steps, diffs, modifiedPaths, { hasModifiedFiles, hasValidated, autoFixRounds });
          const toolMessage: ChatMessage = { role: "tool", tool_call_id: call.id, name: call.name, content: result.message };
          this.messages.push(toolMessage);
          this.rememberMessageFocus(toolMessage);
          this.emit({ type: "tool_result", name: call.name, result: result.message.slice(0, 200) });
          hasModifiedFiles = result.hasModifiedFiles;
          hasValidated = result.hasValidated;
          autoFixRounds = result.autoFixRounds;
          if (result.pendingFixPrompt) pendingFixPrompt = result.pendingFixPrompt;
        }
      }
    }

    await this.persistSession();
    return {
      finalText: `达到当前任务的最大执行轮数（${maxIterations} 轮，${budgetReason}），请缩小任务范围后重试。`,
      steps,
      diffs
    };
  }
}
