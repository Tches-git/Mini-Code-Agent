import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import chalk from "chalk";
import { execa } from "execa";
import {
  getApprovalExactCacheKey,
  getApprovalKindCacheKey,
} from "../agent/approval.js";
import { AgentOrchestrator } from "../agent/orchestrator.js";
import { getRuntimeEnvInfo, loadWorkspaceEnv } from "../llm/env.js";
import {
  editProjectMemory,
  editProjectMemoryCandidateText,
  type ProjectMemoryReview,
  type ProjectMemoryReviewDecision,
  readProjectMemory,
  reviewProjectMemoryEdit,
  selectProjectMemoryCandidates,
} from "../tools/memory.js";
import type {
  AgentEvent,
  AgentRunResult,
  AgentTaskItem,
  ApprovalRequest,
  ApprovalResponse,
} from "../types/agent.js";
import {
  logAssistant,
  logAutoFix,
  logAutoValidate,
  logAutoValidateSkipped,
  logBanner,
  logCard,
  logCardList,
  logContextTrimmed,
  logDetailEntries,
  logDiffHeader,
  logDiffLine,
  logEmptyState,
  logError,
  logFileModified,
  logHint,
  logSection,
  logSuccess,
  logToolCall,
  logToolError,
  logToolResult,
  Spinner,
} from "../utils/logger.js";
import {
  detectPackageManager,
  getProjectToolingConfig,
  readWorkspacePackageJson,
} from "../utils/project-tooling.js";
import {
  getAppDataDir,
  getWorkspaceRoot,
  setWorkspaceRoot,
} from "../utils/runtime.js";
import { parseApprovalLogQueryText, printApprovalLog } from "./approval-log.js";
import { printRunReports } from "./reports.js";
import { printSessions } from "./sessions.js";

const SLASH_COMMANDS = {
  "/exit": "退出交互模式",
  "/clear": "清空对话上下文，开始新会话",
  "/help": "显示可用命令列表",
  "/plan <task>": "只制定执行计划，不修改文件",
  "/execute [task]": "执行最近一次计划，或直接执行指定任务",
  "/execute-task <id>": "恢复后继续执行指定任务树节点",
  "/retry-task": "自动重试第一个依赖已满足的阻塞任务",
  "/diff [--staged] [path]":
    "查看当前工作区 Git diff，可限定路径或 staged diff",
  "/status": "查看当前工作区、会话、撤销和 Git 状态",
  "/config": "查看模型、环境、验证和命令策略配置",
  "/review": "交互审查最近一次 Agent 修改，可按文件接受/回滚",
  "/undo": "撤销 Agent 最近一次文件修改",
  "/tasks [timeline]": "查看上一轮任务步骤，timeline 显示任务状态时间线",
  "/memory [review|clear|remove <id>|overview <text>]":
    "查看、预览、确认/拒绝或编辑项目长期记忆",
  "/approvals [active|clear]":
    "查看审批记录，或查看/清空当前任务临时审批；可用 decision:/action:/path:/after: 等过滤",
  "/reports [id]": "查看 Agent 运行报告列表或详情",
  "/sessions": "查看可恢复的历史会话",
  "/resume <id>": "恢复指定会话 ID 的上下文",
  "/init": "提示使用 init 子命令生成 .env 模板",
  "/doctor": "提示使用 doctor 子命令检查安装与环境配置",
};

function getSlashCommandName(input: string): string | null {
  if (!input.startsWith("/")) {
    return null;
  }

  const commandName = /^\/\S+/.exec(input)?.[0] ?? null;
  if (!commandName) {
    return null;
  }

  // 只有单段 /command 才按斜杠命令处理；绝对路径如 /Users/... 应继续当作普通任务。
  return commandName.includes("/", 1) ? null : commandName;
}

export function getSlashCommandSuggestions(inputText = "/"): string[] {
  const prefix = inputText.trim() || "/";
  return Object.entries(SLASH_COMMANDS)
    .filter(([cmd]) => cmd.split(/\s+/)[0]?.startsWith(prefix))
    .map(([cmd, desc]) => `**${cmd}** ${desc}`);
}

export function completeSlashCommand(line: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  const prefix = /^\/\S*/.exec(line)?.[0] || "/";
  const hits = Object.keys(SLASH_COMMANDS)
    .map((cmd) => cmd.split(/\s+/)[0] || cmd)
    .filter((cmd) => cmd.startsWith(prefix))
    .map((cmd) => `${cmd} `);
  return [hits.length ? hits : Object.keys(SLASH_COMMANDS), line];
}

function printSlashSuggestions(inputText = "/") {
  const suggestions = getSlashCommandSuggestions(inputText);
  logCardList(
    inputText.trim() === "/" ? "所有 slash 命令" : "匹配的 slash 命令",
    suggestions.length > 0
      ? suggestions
      : ["没有匹配的 slash 命令，输入 /help 查看全部。"],
  );
  console.log();
}

function printHelp() {
  logCardList("可用命令", getSlashCommandSuggestions("/"));
  logHint(
    '其他输入将作为任务发送给 Agent；输入 ``` 或 """ 可进入多行模式，再次输入相同标记结束。',
  );
  console.log();
}

export async function collectMultilineInput(
  rl: readline.Interface,
  firstLine: string,
  prompt: () => string,
): Promise<string> {
  const marker = firstLine.trim();
  if (marker === "```" || marker === '"""') {
    const lines: string[] = [];
    while (true) {
      const nextLine = await rl.question(chalk.gray("  ... "));
      if (nextLine.trim() === marker) break;
      lines.push(nextLine);
    }
    return lines.join("\n");
  }

  if (!firstLine.endsWith("\\")) {
    return firstLine;
  }

  const lines = [firstLine.slice(0, -1)];
  while (true) {
    const nextLine = await rl.question(prompt());
    if (nextLine.endsWith("\\")) {
      lines.push(nextLine.slice(0, -1));
      continue;
    }
    lines.push(nextLine);
    return lines.join("\n");
  }
}

function formatTaskTimeline(tasks: AgentTaskItem[]): string[] {
  const labels: Record<AgentTaskItem["status"], string> = {
    todo: "待办",
    doing: "进行中",
    done: "完成",
    blocked: "阻塞",
  };
  return tasks.flatMap((task) =>
    (task.history || []).map((entry, index) => {
      const details = [
        entry.note,
        entry.failureCount ? `失败次数: ${entry.failureCount}` : "",
        entry.retrySuggestion ? `重试建议: ${entry.retrySuggestion}` : "",
      ].filter(Boolean);
      const suffix = details.length ? ` — ${details.join("; ")}` : "";
      return `**${task.id}.${index + 1}.** ${entry.at} [${labels[entry.status]}] ${task.title}${suffix}`;
    }),
  );
}

export function printTaskSteps(
  steps: string[],
  tasks: AgentTaskItem[] = [],
  options: { timeline?: boolean } = {},
) {
  logSection("任务步骤");
  if (steps.length === 0 && tasks.length === 0) {
    logEmptyState("当前还没有可展示的任务步骤。");
    console.log();
    return;
  }
  if (tasks.length > 0) {
    const labels: Record<AgentTaskItem["status"], string> = {
      todo: "待办",
      doing: "进行中",
      done: "完成",
      blocked: "阻塞",
    };
    logCardList(
      "任务状态",
      tasks.map((task) => {
        const details = [
          task.dependsOn?.length ? `依赖: ${task.dependsOn.join(",")}` : "",
          task.blockedReason ? `阻塞: ${task.blockedReason}` : "",
          task.failureCount ? `失败次数: ${task.failureCount}` : "",
          task.retrySuggestion ? `重试建议: ${task.retrySuggestion}` : "",
          task.history?.length ? `历史: ${task.history.length} 条` : "",
        ].filter(Boolean);
        const suffix = details.length ? ` — ${details.join("; ")}` : "";
        return `**${task.id}.** [${labels[task.status]}] ${task.title}${suffix}`;
      }),
    );
  }
  if (options.timeline) {
    const timeline = formatTaskTimeline(tasks);
    timeline.length > 0
      ? logCardList("任务时间线", timeline)
      : logEmptyState("当前任务还没有历史时间线。");
  }
  if (steps.length > 0) {
    logCardList(
      "上一轮步骤",
      steps.map((step, index) => `**${index + 1}.** ${step}`),
    );
  }
  console.log();
}

export async function getWorkspaceDiffSummary(): Promise<string> {
  const status = await execa("git", ["status", "--short"], {
    cwd: getWorkspaceRoot(),
    reject: false,
  });
  if ((status.exitCode ?? 1) !== 0) {
    return `Git 状态不可用: ${status.stderr || "git status 执行失败"}`;
  }
  const changedFiles = status.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
  if (changedFiles === 0) {
    return "干净（无未提交变更）";
  }
  return `${changedFiles} 个变更文件`;
}

export async function printInteractiveStatus(options: {
  turnCount: number;
  taskStepCount: number;
  canUndo: boolean;
  undoStackDepth?: number;
}) {
  logCard("当前状态");
  logDetailEntries([
    { label: "工作区", value: getWorkspaceRoot() },
    { label: "用户数据目录", value: getAppDataDir() },
    { label: "会话轮数", value: String(options.turnCount) },
    { label: "上一轮步骤数", value: String(options.taskStepCount) },
    { label: "可撤销上一轮", value: options.canUndo ? "是" : "否" },
    {
      label: "可撤销轮数",
      value: String(options.undoStackDepth ?? (options.canUndo ? 1 : 0)),
    },
    { label: "Git", value: await getWorkspaceDiffSummary() },
  ]);
  console.log();
}

function parseMemorySelection(inputText: string, max: number): number[] {
  const trimmed = inputText.trim().toLowerCase();
  if (!trimmed || trimmed === "a" || trimmed === "all") {
    return Array.from({ length: max }, (_, index) => index + 1);
  }
  if (trimmed === "n" || trimmed === "none") return [];
  return Array.from(
    new Set(
      trimmed
        .split(/[,\s]+/)
        .map((item) => Number.parseInt(item, 10))
        .filter((item) => Number.isInteger(item) && item >= 1 && item <= max),
    ),
  );
}

async function reviewProjectMemoryInteractively(
  rl: readline.Interface,
  review: ProjectMemoryReview,
): Promise<ProjectMemoryReviewDecision> {
  logCard("项目长期记忆自动候选");
  const reviewItems = review.items || [];
  if (reviewItems.length > 0) {
    logCardList(
      "候选条目",
      reviewItems.map((item, index) => {
        const details = [
          item.confidence ? `置信度: ${item.confidence}` : "",
          item.expiresAt ? `过期: ${item.expiresAt}` : "",
          item.conflict || "",
        ].filter(Boolean);
        return `**${index + 1}.** ${item.label}${details.length ? ` — ${details.join("; ")}` : ""}`;
      }),
    );
  } else {
    const candidateLines = [
      ...(review.candidates?.preferences || []).map((item) => `偏好: ${item}`),
      ...(review.candidates?.commands || []).map((item) => `命令: ${item}`),
      ...(review.candidates?.facts || []).map((item) => `事实: ${item.text}`),
    ];
    if (candidateLines.length > 0) {
      logCardList("候选条目", candidateLines);
    }
  }
  logDetailEntries([{ label: "Diff", value: review.diff }]);
  const answer = await rl.question(
    chalk.cyan.bold("  保存这次记忆？[y/N/e/s] "),
  );
  const normalized = answer.trim().toLowerCase();
  if (normalized === "y" || normalized === "yes") return "accept";
  if (normalized === "e" || normalized === "edit") {
    const overview = await rl.question(chalk.cyan.bold("  编辑项目画像: "));
    return { update: { overview } };
  }
  if (
    (normalized === "s" || normalized === "select") &&
    review.candidates &&
    reviewItems.length > 0
  ) {
    let candidates = review.candidates;
    const selectedText = await rl.question(
      chalk.cyan.bold("  选择要保存的条目编号（逗号分隔，all/none）: "),
    );
    const selectedIndexes = parseMemorySelection(
      selectedText,
      reviewItems.length,
    );
    if (selectedIndexes.length === 0) return "reject";
    const editText = await rl.question(
      chalk.cyan.bold("  可选：输入 <编号>:<新文本> 逐条编辑，留空跳过: "),
    );
    const editMatch = /^(\d+)\s*[:：]\s*(.+)$/.exec(editText.trim());
    if (editMatch) {
      const editIndex = Number.parseInt(editMatch[1], 10);
      const item = reviewItems[editIndex - 1];
      if (item && selectedIndexes.includes(editIndex)) {
        candidates = editProjectMemoryCandidateText(
          candidates,
          item.key,
          editMatch[2],
        );
      }
    }
    return {
      update: selectProjectMemoryCandidates(
        candidates,
        selectedIndexes
          .map((index) => reviewItems[index - 1]?.key)
          .filter(Boolean),
      ),
    };
  }
  return "reject";
}

export async function printProjectMemory(commandText = "") {
  const trimmed = commandText.trim();
  if (trimmed === "review") {
    const review = await reviewProjectMemoryEdit({});
    logCard("项目长期记忆拟议变更");
    logDetailEntries([{ label: "Diff", value: review.diff }]);
    console.log();
    return;
  }
  if (trimmed === "clear") {
    await editProjectMemory({ clear: true });
    logSuccess("项目长期记忆已清空。");
    console.log();
    return;
  }
  const removeMatch = /^(?:review\s+)?remove\s+(.+)$/.exec(trimmed);
  if (removeMatch) {
    const ids = removeMatch[1]
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (trimmed.startsWith("review remove")) {
      const review = await reviewProjectMemoryEdit({ removeFactIds: ids });
      logCard("项目长期记忆拟议变更");
      logDetailEntries([{ label: "Diff", value: review.diff }]);
      console.log();
      return;
    }
    const memory = await editProjectMemory({ removeFactIds: ids });
    logSuccess(`已删除 ${ids.length} 条记忆事实。`);
    logCardList(
      "剩余事实",
      (memory.facts || []).map((fact) => `**${fact.id}.** ${fact.text}`),
    );
    console.log();
    return;
  }
  const overviewMatch = /^(?:review\s+)?overview\s+(.+)$/.exec(trimmed);
  if (overviewMatch) {
    const overview = overviewMatch[1].trim();
    if (trimmed.startsWith("review overview")) {
      const review = await reviewProjectMemoryEdit({ overview });
      logCard("项目长期记忆拟议变更");
      logDetailEntries([{ label: "Diff", value: review.diff }]);
      console.log();
      return;
    }
    await editProjectMemory({ overview });
    logSuccess("项目画像已更新。");
    console.log();
    return;
  }

  const memory = await readProjectMemory();
  logCard("项目长期记忆");
  logDetailEntries([
    { label: "项目画像", value: memory.overview || "无" },
    { label: "偏好", value: memory.preferences.join("; ") || "无" },
    { label: "常用命令", value: memory.commands.join("; ") || "无" },
  ]);
  if (memory.facts?.length) {
    logCardList(
      "事实",
      memory.facts.map(
        (fact) =>
          `**${fact.id}.** ${fact.text} (${fact.source}, ${fact.confidence})`,
      ),
    );
  }
  console.log();
}

export async function printInteractiveConfig() {
  const env = getRuntimeEnvInfo();
  const packageJson = await readWorkspacePackageJson();
  const tooling = getProjectToolingConfig(packageJson);
  const packageManager = await detectPackageManager();

  logCard("当前配置");
  logDetailEntries([
    { label: "工作区", value: getWorkspaceRoot() },
    { label: "用户数据目录", value: getAppDataDir() },
    { label: ".env", value: env.hasEnvFile ? env.envFilePath : "未检测到" },
    {
      label: "OPENAI_API_KEY",
      value: env.openaiApiKeyConfigured ? "已配置" : "未配置",
    },
    { label: "OPENAI_BASE_URL", value: env.openaiBaseUrl || "默认" },
    { label: "MODEL_NAME", value: env.modelName },
    { label: "包管理器", value: packageManager },
    {
      label: "验证 lint scripts",
      value: tooling.validation.lintScripts.join(", ") || "无",
    },
    {
      label: "验证 test scripts",
      value: tooling.validation.testScripts.join(", ") || "无",
    },
    {
      label: "验证 build scripts",
      value: tooling.validation.buildScripts.join(", ") || "无",
    },
    {
      label: "diagnostics typecheck scripts",
      value: tooling.diagnostics.typecheckScripts.join(", ") || "无",
    },
    {
      label: "命令安全脚本",
      value: tooling.commandPolicy.safeScripts.join(", ") || "无",
    },
    {
      label: "命令需确认脚本",
      value: tooling.commandPolicy.guardedScripts.join(", ") || "无",
    },
  ]);
  if (!env.openaiApiKeyConfigured) {
    logHint(
      "可运行 `local-code-agent init` 生成 .env 模板，再运行 `local-code-agent doctor --ping` 检查配置。",
    );
  }
  console.log();
}

export function parseDiffCommandArgs(input: string): {
  staged: boolean;
  path?: string;
} {
  const args = input
    .replace(/^\/diff\b/, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const staged = args.includes("--staged") || args.includes("--cached");
  const pathArg = args.find((arg) => arg !== "--staged" && arg !== "--cached");
  return { staged, path: pathArg };
}

function parseReviewSelection(input: string, paths: string[]): string[] {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || trimmed === "a" || trimmed === "all") return [...paths];
  if (trimmed === "n" || trimmed === "none") return [];
  const selected = new Set<string>();
  for (const item of trimmed.split(/[\s,]+/).filter(Boolean)) {
    const index = Number.parseInt(item, 10);
    if (Number.isInteger(index) && paths[index - 1]) {
      selected.add(paths[index - 1]);
      continue;
    }
    const matched = paths.find((filePath) => filePath.toLowerCase() === item);
    if (matched) selected.add(matched);
  }
  return Array.from(selected);
}

async function reviewLastRunInteractively(
  rl: readline.Interface,
  agent: AgentOrchestrator,
): Promise<AgentRunResult | null> {
  const paths = agent.getLastRunModifiedPaths();
  if (paths.length === 0) {
    logEmptyState("没有可审查的上一轮 Agent 修改。");
    console.log();
    return null;
  }
  logCardList(
    "上一轮修改文件",
    paths.map((filePath, index) => `**${index + 1}.** ${filePath}`),
  );
  await printWorkspaceDiff();
  const answer = await rl.question(
    chalk.cyan.bold(
      "  接受哪些文件？输入编号/路径，all=全部接受，none=全部回滚: ",
    ),
  );
  const accepted = parseReviewSelection(answer, paths);
  const rejected = paths.filter((filePath) => !accepted.includes(filePath));
  if (rejected.length === 0) {
    logSuccess("已接受上一轮全部修改。");
    console.log();
    return null;
  }
  const result = await agent.undoLastRun({ paths: rejected });
  logCard("审查回滚完成");
  logCardList("已接受", accepted.length ? accepted : ["无"]);
  logCardList("已回滚", rejected);
  if (result.diffs.length > 0) {
    logSection("回滚预览");
    for (const d of result.diffs) {
      logDiffHeader(d.path, d.summary);
      for (const l of d.diff.split("\n")) logDiffLine(l);
    }
  }
  console.log();
  return result;
}

export async function printWorkspaceDiff(
  options: { staged?: boolean; path?: string } = {},
) {
  const args = [
    "diff",
    ...(options.staged ? ["--staged"] : []),
    "--",
    options.path || ".",
  ];
  const diff = await execa("git", args, {
    cwd: getWorkspaceRoot(),
    reject: false,
  });
  if ((diff.exitCode ?? 1) !== 0) {
    throw new Error(diff.stderr || "git diff 执行失败");
  }
  logSection(options.staged ? "当前暂存区 Diff" : "当前工作区 Diff");
  if (!diff.stdout.trim()) {
    logEmptyState(
      options.staged ? "当前没有已暂存差异。" : "当前没有未暂存差异。",
    );
    console.log();
    return;
  }
  for (const line of diff.stdout.split("\n")) {
    if (line.startsWith("diff --git")) {
      logDiffHeader(line.replace(/^diff --git\s+/, ""), "Git diff");
      continue;
    }
    logDiffLine(line);
  }
  console.log();
}

function handleEvent(event: AgentEvent, spinner: Spinner) {
  switch (event.type) {
    case "thinking":
      spinner.start("思考中…");
      break;
    case "tool_call":
      spinner.stop();
      logToolCall(event.name, event.args);
      spinner.start(`执行 ${event.name}…`);
      break;
    case "tool_result":
      spinner.stop();
      logToolResult(event.name, event.result);
      break;
    case "tool_error":
      spinner.stop();
      logToolError(event.name, event.error);
      break;
    case "file_modified":
      spinner.stop();
      logFileModified(event.diff?.path);
      break;
    case "auto_validate":
      spinner.stop();
      logAutoValidate(event.command);
      spinner.start("验证中…");
      break;
    case "auto_validate_skipped":
      spinner.stop();
      logAutoValidateSkipped(event.reason);
      break;
    case "auto_fix":
      spinner.stop();
      logAutoFix(event.round);
      break;
    case "context_trimmed":
      spinner.stop();
      logContextTrimmed(event.removed, event.totalTokens);
      break;
  }
}

function isHighRiskCommand(command: string): boolean {
  return /(^|\s)(rm|mv|chmod|chown|dd|sudo)\b|git\s+(reset|clean|push\s+--force|push\s+-f)\b|>\s*\S+/.test(
    command,
  );
}

export function describeApprovalRequest(request: ApprovalRequest): {
  title: string;
  primary: string;
  detailLines: Array<{ label: string; value: string }>;
  promptLabel: string;
  resultLabel: string;
  riskLevel: "低" | "中" | "高";
  defaultPolicy: string;
} {
  if (request.kind === "command") {
    return {
      title: "需要确认的命令",
      primary: request.command,
      detailLines: [{ label: "原因", value: request.reason }],
      promptLabel: "允许执行?",
      resultLabel: "执行",
      riskLevel: isHighRiskCommand(request.command) ? "高" : "中",
      defaultPolicy: "默认拒绝，除非明确批准。",
    };
  }

  if (request.kind === "external_file") {
    return {
      title: "需要打开工作区外文件",
      primary: request.path,
      detailLines: [
        { label: "缓存位置", value: request.destinationPath },
        {
          label: "模式",
          value: request.mode === "extract_text" ? "提取文本" : "复制原文件",
        },
        { label: "原因", value: request.reason },
      ],
      promptLabel: "允许打开?",
      resultLabel: "打开",
      riskLevel: "中",
      defaultPolicy: "默认拒绝，避免误读取工作区外内容。",
    };
  }

  const title =
    request.action === "list"
      ? "需要打开工作区外目录"
      : request.action === "read"
        ? "需要读取工作区外文件"
        : request.action === "search"
          ? "需要搜索工作区外目录"
          : "需要修改工作区外文件";
  const promptLabel =
    request.action === "list"
      ? "允许打开目录?"
      : request.action === "read"
        ? "允许读取?"
        : request.action === "search"
          ? "允许搜索?"
          : "允许修改?";

  return {
    title,
    primary: request.path,
    detailLines: [
      {
        label: "操作",
        value:
          request.action === "list"
            ? "列目录"
            : request.action === "read"
              ? "读取内容"
              : request.action === "search"
                ? "搜索目录"
                : "写入或修改",
      },
      { label: "原因", value: request.reason },
    ],
    promptLabel,
    resultLabel:
      request.action === "write"
        ? "修改"
        : request.action === "search"
          ? "搜索"
          : request.action === "read"
            ? "读取"
            : "打开",
    riskLevel:
      request.action === "write"
        ? "高"
        : request.action === "search"
          ? "中"
          : "低",
    defaultPolicy:
      request.action === "write"
        ? "默认拒绝，避免修改工作区外内容。"
        : request.action === "search"
          ? "默认拒绝，避免扫描工作区外目录。"
          : "默认拒绝，需明确批准后继续。",
  };
}

function getApprovalPromptOptions(
  request: ApprovalRequest,
  riskLevel: "低" | "中" | "高",
): { prompt: string; exactKey: string; kindKey: string; allowKind: boolean } {
  const exactKey = getApprovalExactCacheKey(request);
  const kindKey = getApprovalKindCacheKey(request);
  const allowKind = riskLevel !== "高";
  return {
    exactKey,
    kindKey,
    allowKind,
    prompt: allowKind
      ? "[y]本次 / [e]本任务精确同项 / [a]本任务同类 / [d]本任务同类拒绝 / [N]拒绝"
      : "[y]本次 / [e]本任务精确同项 / [d]本任务精确拒绝 / [N]拒绝",
  };
}

export async function startInteractive(options?: {
  autoApprove?: boolean;
  resume?: boolean;
  resumeSessionId?: string;
  cwd?: string;
}) {
  const workspaceRoot = options?.cwd || process.cwd();
  setWorkspaceRoot(workspaceRoot);
  loadWorkspaceEnv(workspaceRoot);
  const rl = readline.createInterface({
    input,
    output,
    terminal: true,
    completer: completeSlashCommand,
  });
  const spinner = new Spinner();
  const confirmAction = async (
    request: ApprovalRequest,
  ): Promise<ApprovalResponse> => {
    spinner.stop();
    const description = describeApprovalRequest(request);
    if (options?.autoApprove) {
      logCard("已自动确认");
      logCardList("目标", [description.primary]);
      logDetailEntries(
        [
          { label: "风险级别", value: description.riskLevel },
          { label: "默认策略", value: description.defaultPolicy },
          ...description.detailLines,
        ],
        "    ",
      );
      console.log();
      return { approved: true, scope: "task_kind" };
    }

    const promptOptions = getApprovalPromptOptions(
      request,
      description.riskLevel,
    );
    logCard(description.title);
    logCardList("目标", [description.primary]);
    logDetailEntries(
      [
        { label: "风险级别", value: description.riskLevel },
        { label: "默认策略", value: description.defaultPolicy },
        { label: "精确缓存", value: promptOptions.exactKey },
        ...(promptOptions.allowKind
          ? [{ label: "同类缓存", value: promptOptions.kindKey }]
          : [{ label: "同类缓存", value: "高风险操作仅允许精确缓存" }]),
        ...description.detailLines,
      ],
      "    ",
    );
    const answer = await rl.question(
      chalk.cyan.bold(`  ${description.promptLabel} ${promptOptions.prompt} `),
    );
    const normalizedAnswer = answer.trim().toLowerCase();
    const approved = /^(y|yes|e|exact|a|all)$/.test(normalizedAnswer);
    const rejectedForTask = /^(d|deny)$/.test(normalizedAnswer);
    const scope =
      /^(a|all)$/.test(normalizedAnswer) && promptOptions.allowKind
        ? "task_kind"
        : /^(e|exact)$/.test(normalizedAnswer) || rejectedForTask
          ? "task_exact"
          : "once";
    approved
      ? logSuccess(
          scope === "task_kind"
            ? `已确认${description.resultLabel}，本任务同类操作不再询问`
            : scope === "task_exact"
              ? `已确认${description.resultLabel}，本任务精确同项不再询问`
              : `已确认${description.resultLabel}`,
        )
      : logError(
          rejectedForTask
            ? `已拒绝${description.resultLabel}，本任务同项不再询问`
            : `已拒绝${description.resultLabel}`,
        );
    console.log();
    return { approved, scope };
  };

  const agent = new AgentOrchestrator({
    onEvent: (event) => handleEvent(event, spinner),
    onConfirmCommand: confirmAction,
    onReviewMemory: (review) => reviewProjectMemoryInteractively(rl, review),
  });

  logBanner();
  logHint(`当前工作区: ${getWorkspaceRoot()}`);
  logHint(`用户数据目录: ${getAppDataDir()}`);
  console.log();

  if (options?.resume || options?.resumeSessionId) {
    const restored = await agent.restoreSession(options.resumeSessionId);
    if (restored) {
      logSuccess(
        `已恢复${options.resumeSessionId ? `会话 ${options.resumeSessionId}` : "上次会话"}（${agent.turnCount} 轮对话）`,
      );
    } else {
      logEmptyState("没有可恢复的会话，开始新对话。");
    }
    console.log();
  }

  const prompt = () => chalk.cyan.bold("  > ");
  let lastTaskSteps: string[] = [];
  let lastTaskItems: AgentTaskItem[] = [];
  let lastPlanTask: string | null = null;
  let lastPlanText: string | null = null;

  while (true) {
    let line: string | undefined;
    try {
      line = await rl.question(prompt());
    } catch {
      break;
    }

    try {
      line = await collectMultilineInput(rl, line, prompt);
    } catch {
      break;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    const resumeMatch = /^\/resume(?:\s+(.+))?$/.exec(trimmed);
    if (resumeMatch) {
      const sessionId = resumeMatch[1]?.trim() ?? "";
      if (!sessionId) {
        logError("用法: /resume <session-id>");
        console.log();
        continue;
      }
      const restored = await agent.restoreSession(sessionId);
      restored
        ? logSuccess(`已恢复会话 ${sessionId}（${agent.turnCount} 轮对话）`)
        : logError(`未找到会话 ${sessionId}`);
      console.log();
      continue;
    }

    const slashCommand = getSlashCommandName(trimmed);

    if (trimmed === "/" || (trimmed.startsWith("/") && !slashCommand)) {
      printSlashSuggestions(trimmed);
      continue;
    }

    if (slashCommand === "/exit" || slashCommand === "/quit") {
      logHint("再见 👋");
      console.log();
      break;
    }
    if (slashCommand === "/clear") {
      agent.clearHistory();
      logSuccess("上下文已清空，开始新会话");
      console.log();
      continue;
    }
    if (slashCommand === "/help") {
      printHelp();
      continue;
    }
    if (slashCommand === "/plan") {
      const task = trimmed.replace(/^\/plan\b/, "").trim();
      if (!task) {
        logError("用法: /plan <task>");
        console.log();
        continue;
      }
      try {
        const result = await agent.plan(task);
        lastTaskSteps = result.steps;
        lastTaskItems = result.tasks || [];
        lastPlanTask = task;
        lastPlanText = result.finalText;
        spinner.stop();
        logCard("计划完成");
        logEmptyState("计划模式不会修改文件。");
        logAssistant(result.finalText);
      } catch (error) {
        spinner.stop();
        logError(error instanceof Error ? error.message : String(error));
        console.log();
      }
      continue;
    }
    if (slashCommand === "/execute") {
      const explicitTask = trimmed.replace(/^\/execute\b/, "").trim();
      const task = explicitTask || lastPlanTask;
      if (!task) {
        logError(
          "没有可执行的计划，请先运行 /plan <task>，或使用 /execute <task>",
        );
        console.log();
        continue;
      }
      try {
        if (!explicitTask && lastPlanText) {
          logCard("执行最近计划");
          logAssistant(lastPlanText);
        }
        const result = await agent.run(task);
        lastTaskSteps = result.steps;
        lastTaskItems = result.tasks || [];
        spinner.stop();
        logCard("执行完成");
        if (result.diffs.length > 0) {
          logSection("变更预览");
          for (const d of result.diffs) {
            logDiffHeader(d.path, d.summary);
            for (const l of d.diff.split("\n")) logDiffLine(l);
          }
        } else {
          logEmptyState("本轮没有文件变更。");
        }
        logAssistant(result.finalText);
      } catch (error) {
        spinner.stop();
        logError(error instanceof Error ? error.message : String(error));
        console.log();
      }
      continue;
    }
    if (slashCommand === "/execute-task" || slashCommand === "/retry-task") {
      const isRetryTask = slashCommand === "/retry-task";
      const taskIdText = trimmed.replace(/^\/execute-task\b/, "").trim();
      const taskId = Number.parseInt(taskIdText, 10);
      if (!isRetryTask && (!Number.isInteger(taskId) || taskId <= 0)) {
        logError("用法: /execute-task <id>");
        console.log();
        continue;
      }
      try {
        const result = isRetryTask
          ? await agent.retryNextBlockedTask()
          : await agent.executeTask(taskId);
        lastTaskSteps = result.steps;
        lastTaskItems = result.tasks || [];
        spinner.stop();
        logCard(isRetryTask ? "任务自动重试完成" : `任务 ${taskId} 执行完成`);
        if (result.diffs.length > 0) {
          logSection("变更预览");
          for (const d of result.diffs) {
            logDiffHeader(d.path, d.summary);
            for (const l of d.diff.split("\n")) logDiffLine(l);
          }
        } else {
          logEmptyState("本轮没有文件变更。");
        }
        logAssistant(result.finalText);
      } catch (error) {
        spinner.stop();
        logError(error instanceof Error ? error.message : String(error));
        console.log();
      }
      continue;
    }
    if (slashCommand === "/diff") {
      try {
        await printWorkspaceDiff(parseDiffCommandArgs(trimmed));
      } catch (error) {
        logError(error instanceof Error ? error.message : String(error));
        console.log();
      }
      continue;
    }
    if (slashCommand === "/status") {
      try {
        await printInteractiveStatus({
          turnCount: agent.turnCount,
          taskStepCount: lastTaskSteps.length,
          canUndo: agent.canUndoLastRun,
          undoStackDepth: agent.undoStackDepth,
        });
      } catch (error) {
        logError(error instanceof Error ? error.message : String(error));
        console.log();
      }
      continue;
    }
    if (slashCommand === "/config") {
      try {
        await printInteractiveConfig();
      } catch (error) {
        logError(error instanceof Error ? error.message : String(error));
        console.log();
      }
      continue;
    }
    if (slashCommand === "/tasks") {
      const taskArgs = trimmed.replace(/^\/tasks\b/, "").trim();
      printTaskSteps(lastTaskSteps, lastTaskItems, {
        timeline: /^(timeline|history)$/.test(taskArgs),
      });
      continue;
    }
    if (slashCommand === "/review") {
      try {
        const result = await reviewLastRunInteractively(rl, agent);
        if (result) {
          lastTaskSteps = result.steps;
          lastTaskItems = result.tasks || [];
          logAssistant(result.finalText);
        }
      } catch (error) {
        logError(error instanceof Error ? error.message : String(error));
        console.log();
      }
      continue;
    }
    if (slashCommand === "/memory") {
      try {
        await printProjectMemory(trimmed.replace(/^\/memory\b/, ""));
      } catch (error) {
        logError(error instanceof Error ? error.message : String(error));
        console.log();
      }
      continue;
    }
    if (slashCommand === "/undo") {
      try {
        const pathArgs = trimmed.replace(/^\/undo\b/, "").trim();
        const result = await agent.undoLastRun({
          paths: pathArgs
            ? pathArgs.split(/[\s,]+/).filter(Boolean)
            : undefined,
        });
        lastTaskSteps = result.steps;
        lastTaskItems = result.tasks || [];
        logCard("撤销完成");
        if (result.diffs.length > 0) {
          logSection("撤销预览");
          for (const d of result.diffs) {
            logDiffHeader(d.path, d.summary);
            for (const l of d.diff.split("\n")) logDiffLine(l);
          }
        } else {
          logEmptyState("没有可撤销的文件修改。");
        }
        logAssistant(result.finalText);
      } catch (error) {
        logError(error instanceof Error ? error.message : String(error));
        console.log();
      }
      continue;
    }
    if (slashCommand === "/init") {
      logHint("请在终端中运行 `local-code-agent init` 生成 .env 模板。");
      console.log();
      continue;
    }
    if (slashCommand === "/doctor") {
      logHint(
        "请在终端中运行 `local-code-agent doctor --ping` 检查安装、环境配置与 LLM 连通性。",
      );
      console.log();
      continue;
    }
    if (slashCommand === "/approvals") {
      const query = trimmed.replace(/^\/approvals\b/, "").trim();
      if (query === "active") {
        const decisions = agent.getActiveApprovalDecisions();
        logCard("当前任务临时审批");
        logCardList(
          "允许",
          decisions.allowed.length ? decisions.allowed : ["无"],
        );
        logCardList(
          "拒绝",
          decisions.rejected.length ? decisions.rejected : ["无"],
        );
        console.log();
        continue;
      }
      if (query === "clear") {
        agent.clearActiveApprovalDecisions();
        logSuccess("当前任务临时审批已清空");
        console.log();
        continue;
      }
      const parsed = parseApprovalLogQueryText(query);
      await printApprovalLog(
        {
          ...parsed.filters,
          limit: parsed.filters.limit || 10,
        },
        parsed.options,
      );
      continue;
    }
    if (slashCommand === "/reports") {
      const id = trimmed.replace(/^\/reports\b/, "").trim();
      try {
        await printRunReports({ id: id || undefined });
      } catch (error) {
        logError(error instanceof Error ? error.message : String(error));
        console.log();
      }
      continue;
    }
    if (slashCommand === "/sessions") {
      const query = trimmed.replace(/^\/sessions\b/, "").trim();
      await printSessions({ query: query || undefined });
      continue;
    }
    if (slashCommand === "/resume") {
      const sessionId = trimmed.replace(/^\/resume\b/, "").trim();
      if (!sessionId) {
        logError("用法: /resume <session-id>");
        console.log();
        continue;
      }
      const restored = await agent.restoreSession(sessionId);
      restored
        ? logSuccess(`已恢复会话 ${sessionId}（${agent.turnCount} 轮对话）`)
        : logError(`未找到会话 ${sessionId}`);
      console.log();
      continue;
    }
    if (slashCommand) {
      logError(`未知命令: ${trimmed}，输入 /help 查看帮助`);
      console.log();
      continue;
    }

    try {
      const result = await agent.run(trimmed);
      lastTaskSteps = result.steps;
      lastTaskItems = result.tasks || [];
      spinner.stop();
      logCard("执行完成");
      if (result.diffs.length > 0) {
        logSection("变更预览");
        for (const d of result.diffs) {
          logDiffHeader(d.path, d.summary);
          for (const l of d.diff.split("\n")) logDiffLine(l);
        }
      } else {
        logEmptyState("本轮没有文件变更。");
      }
      logAssistant(result.finalText);
    } catch (error) {
      spinner.stop();
      logError(error instanceof Error ? error.message : String(error));
      console.log();
    }
  }

  rl.close();
  process.exit(0);
}
