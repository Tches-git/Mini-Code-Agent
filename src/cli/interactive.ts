import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import chalk from "chalk";
import { AgentOrchestrator } from "../agent/orchestrator.js";
import { loadWorkspaceEnv } from "../llm/env.js";
import { listSessions } from "../agent/session.js";
import type { AgentEvent, ApprovalRequest } from "../types/agent.js";
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
  logLine,
  logSection,
  logSuccess,
  logToolCall,
  logToolError,
  logToolResult,
  Spinner,
} from "../utils/logger.js";
import { parseApprovalLogQueryText, printApprovalLog } from "./approval-log.js";
import { getAppDataDir, getWorkspaceRoot, setWorkspaceRoot } from "../utils/runtime.js";

const SLASH_COMMANDS = {
  "/exit": "退出交互模式",
  "/clear": "清空对话上下文，开始新会话",
  "/help": "显示可用命令列表",
  "/approvals": "查看审批记录，可用 decision:/action:/path:/after: 等过滤",
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

function printHelp() {
  logCardList(
    "可用命令",
    Object.entries(SLASH_COMMANDS).map(([cmd, desc]) => `**${cmd}** ${desc}`),
  );
  logHint("其他输入将作为任务发送给 Agent。");
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
      riskLevel: "高",
      defaultPolicy: "默认拒绝，除非明确批准。",
    };
  }

  if (request.kind === "external_file") {
    return {
      title: "需要打开工作区外文件",
      primary: request.path,
      detailLines: [
        { label: "缓存位置", value: request.destinationPath },
        { label: "模式", value: request.mode === "extract_text" ? "提取文本" : "复制原文件" },
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
    riskLevel: request.action === "write" ? "高" : request.action === "search" ? "中" : "低",
    defaultPolicy:
      request.action === "write"
        ? "默认拒绝，避免修改工作区外内容。"
        : request.action === "search"
          ? "默认拒绝，避免扫描工作区外目录。"
          : "默认拒绝，需明确批准后继续。",
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
  const rl = readline.createInterface({ input, output, terminal: true });
  const spinner = new Spinner();
  const confirmAction = async (request: ApprovalRequest): Promise<boolean> => {
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
      return true;
    }

    logCard(description.title);
    logCardList("目标", [description.primary]);
    logDetailEntries(
      [
        { label: "风险级别", value: description.riskLevel },
        { label: "默认策略", value: description.defaultPolicy },
        ...description.detailLines,
      ],
      "    ",
    );
    const answer = await rl.question(
      chalk.cyan.bold(`  ${description.promptLabel} [y/N] `),
    );
    const approved = /^(y|yes)$/i.test(answer.trim());
    approved ? logSuccess(`已确认${description.resultLabel}`) : logError(`已拒绝${description.resultLabel}`);
    console.log();
    return approved;
  };

  const agent = new AgentOrchestrator({
    onEvent: (event) => handleEvent(event, spinner),
    onConfirmCommand: confirmAction,
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

  while (true) {
    let line: string | undefined;
    try {
      line = await rl.question(prompt());
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
    if (slashCommand === "/init") {
      logHint("请在终端中运行 `mini-claude-code init` 生成 .env 模板。");
      console.log();
      continue;
    }
    if (slashCommand === "/doctor") {
      logHint("请在终端中运行 `mini-claude-code doctor --ping` 检查安装、环境配置与 LLM 连通性。");
      console.log();
      continue;
    }
    if (slashCommand === "/approvals") {
      const query = trimmed.replace(/^\/approvals\b/, "").trim();
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
    if (slashCommand === "/sessions") {
      const sessions = await listSessions();
      logCardList(
        "可恢复会话",
        sessions.slice(0, 10).map(
          (session) =>
            `**${session.id}** · ${session.title} · ${session.updatedAt} · ${session.turnCount} 轮`,
        ),
        { emptyText: "当前没有可恢复的会话。" },
      );
      console.log();
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
