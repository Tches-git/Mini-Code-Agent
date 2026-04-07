import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import { AgentOrchestrator } from "../agent/orchestrator.js";
import { parseApprovalLogQueryText, printApprovalLog } from "./approval-log.js";
import type { ApprovalRequest } from "../types/agent.js";
import {
  logBanner,
  logAssistant,
  logToolCall,
  logToolResult,
  logToolError,
  logAutoValidate,
  logAutoValidateSkipped,
  logAutoFix,
  logFileModified,
  logContextTrimmed,
  logDiffHeader,
  logDiffLine,
  Spinner,
} from "../utils/logger.js";

const SLASH_COMMANDS = {
  "/exit": "退出交互模式",
  "/clear": "清空对话上下文，开始新会话",
  "/help": "显示可用命令列表",
  "/approvals": "查看审批记录，可用 decision:/action:/path:/after: 等过滤",
};

function getSlashCommandName(input: string): string | null {
  if (!input.startsWith("/")) {
    return null;
  }

  const commandName = input.split(/\s+/, 1)[0] || null;
  if (!commandName) {
    return null;
  }

  // 只有单段 /command 才按斜杠命令处理；绝对路径如 /Users/... 应继续当作普通任务。
  return commandName.includes("/", 1) ? null : commandName;
}

function printHelp() {
  console.log();
  console.log(chalk.cyan.bold("  可用命令:"));
  for (const [cmd, desc] of Object.entries(SLASH_COMMANDS)) {
    console.log(chalk.yellow(`    ${cmd.padEnd(10)}`) + chalk.gray(desc));
  }
  console.log(chalk.gray("    其他输入将作为任务发送给 Agent"));
  console.log();
}

function handleEvent(event: any, spinner: Spinner) {
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

function describeApprovalRequest(request: ApprovalRequest): { title: string; primary: string; detailLines: string[]; promptLabel: string; resultLabel: string } {
  if (request.kind === "command") {
    return {
      title: "需要确认的命令",
      primary: request.command,
      detailLines: [`原因: ${request.reason}`],
      promptLabel: "允许执行?",
      resultLabel: "执行"
    };
  }

  if (request.kind === "external_file") {
    return {
      title: "需要打开工作区外文件",
      primary: request.path,
      detailLines: [
        `打开后缓存到: ${request.destinationPath}`,
        `模式: ${request.mode === "extract_text" ? "提取文本" : "复制原文件"}`,
        `原因: ${request.reason}`
      ],
      promptLabel: "允许打开?",
      resultLabel: "打开"
    };
  }

  const title = request.action === "list"
    ? "需要打开工作区外目录"
    : request.action === "read"
      ? "需要读取工作区外文件"
      : request.action === "search"
        ? "需要搜索工作区外目录"
        : "需要修改工作区外文件";
  const promptLabel = request.action === "list"
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
      `操作: ${request.action === "list" ? "列目录" : request.action === "read" ? "读取内容" : request.action === "search" ? "搜索目录" : "写入或修改"}`,
      `原因: ${request.reason}`
    ],
    promptLabel,
    resultLabel: request.action === "write" ? "修改" : request.action === "search" ? "搜索" : request.action === "read" ? "读取" : "打开"
  };
}

export async function startInteractive(options?: { autoApprove?: boolean; resume?: boolean }) {
  const rl = readline.createInterface({ input, output, terminal: true });
  const spinner = new Spinner();
  const confirmAction = async (request: ApprovalRequest): Promise<boolean> => {
    spinner.stop();
    const description = describeApprovalRequest(request);
    if (options?.autoApprove) {
      console.log(chalk.green(`\n  ✔ 已自动确认: ${description.primary}`));
      for (const detailLine of description.detailLines) {
        console.log(chalk.gray(`  ${detailLine}`));
      }
      console.log();
      return true;
    }

    console.log(chalk.yellow(`\n  ${description.title}`));
    console.log(chalk.white(`  ${description.primary}`));
    for (const detailLine of description.detailLines) {
      console.log(chalk.gray(`  ${detailLine}`));
    }
    const answer = await rl.question(chalk.cyan.bold(`  ${description.promptLabel} [y/N] `));
    const approved = /^(y|yes)$/i.test(answer.trim());
    console.log(approved ? chalk.green(`  ✔ 已确认${description.resultLabel}\n`) : chalk.red(`  ✖ 已拒绝${description.resultLabel}\n`));
    return approved;
  };

  const agent = new AgentOrchestrator({
    onEvent: (event) => handleEvent(event, spinner),
    onConfirmCommand: confirmAction,
  });

  logBanner();

  if (options?.resume) {
    const restored = await agent.restoreSession();
    if (restored) {
      console.log(chalk.green(`  ✔ 已恢复上次会话（${agent.turnCount} 轮对话）\n`));
    } else {
      console.log(chalk.gray("  没有可恢复的会话，开始新对话\n"));
    }
  }

  const prompt = () => chalk.cyan.bold("  > ");

  while (true) {
    let line;
    try {
      line = await rl.question(prompt());
    } catch {
      break;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    const slashCommand = getSlashCommandName(trimmed);

    if (slashCommand === "/exit" || slashCommand === "/quit") {
      console.log(chalk.gray("\n  再见 👋\n"));
      break;
    }
    if (slashCommand === "/clear") {
      agent.clearHistory();
      console.log(chalk.green("  ✔ 上下文已清空，开始新会话\n"));
      continue;
    }
    if (slashCommand === "/help") {
      printHelp();
      continue;
    }
    if (slashCommand === "/approvals") {
      const query = trimmed.replace(/^\/approvals\b/, "").trim();
      const parsed = parseApprovalLogQueryText(query);
      await printApprovalLog(
        {
          ...parsed.filters,
          limit: parsed.filters.limit || 10
        },
        parsed.options
      );
      continue;
    }
    if (slashCommand) {
      console.log(chalk.red(`  未知命令: ${trimmed}，输入 /help 查看帮助\n`));
      continue;
    }

    try {
      const result = await agent.run(trimmed);
      spinner.stop();
      if (result.diffs.length > 0) {
        console.log(chalk.cyan("\n  ─── 变更预览 ───"));
        result.diffs.forEach((d) => {
          logDiffHeader(d.path, d.summary);
          d.diff.split("\n").forEach((l) => logDiffLine(l));
        });
      }
      logAssistant(result.finalText);
    } catch (error) {
      spinner.stop();
      console.log(chalk.red("\n  ✖ " +
        (error instanceof Error ? error.message : String(error)) +
        "\n"));
    }
  }

  rl.close();
  process.exit(0);
}
