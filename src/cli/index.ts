#!/usr/bin/env node
import { Command } from "commander";
import { AgentOrchestrator } from "../agent/orchestrator.js";
import { printApprovalLog, type ApprovalLogFilters } from "./approval-log.js";
import { logLine, logSection, logStep, logSuccess, logError, logDiffHeader, logDiffLine } from "../utils/logger.js";
import { startInteractive } from "./interactive.js";

const program = new Command();

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`无效的数字: ${value}`);
  }
  return parsed;
}

program
  .command("approvals")
  .description("查询本地审批日志")
  .argument("[query]", "按命令或原因关键字过滤")
  .option("-n, --limit <number>", "最多显示多少条记录", parsePositiveInteger, 20)
  .option("--decision <decision>", "按审批结果过滤 (approved/rejected/blocked)")
  .option("--source <source>", "按来源过滤 (tool/auto_validate/policy)")
  .option("--kind <kind>", "按类别过滤 (command/external_file/external_path)")
  .option("--action <action>", "按动作过滤 (run/import/list/read/search/write)")
  .option("--path <path>", "按目标路径过滤")
  .option("--after <time>", "仅显示某个时间之后的记录，例如 7d、24h、2026-03-25")
  .option("--before <time>", "仅显示某个时间之前的记录，例如 2w、2026-03-25T10:00")
  .option("--stats", "显示当前筛选结果的汇总统计")
  .option("--json", "以 JSON 输出")
  .action(async (
    query: string | undefined,
    options: {
      limit: number;
      decision?: "approved" | "rejected" | "blocked";
      source?: "tool" | "auto_validate" | "policy";
      kind?: "command" | "external_file" | "external_path";
      action?: "run" | "import" | "list" | "read" | "search" | "write";
      path?: string;
      after?: string;
      before?: string;
      stats?: boolean;
      json?: boolean;
    }
  ) => {
    const filters: ApprovalLogFilters = {
      contains: query,
      limit: options.limit,
      decision: options.decision,
      source: options.source,
      kind: options.kind,
      action: options.action,
      path: options.path,
      after: options.after,
      before: options.before
    };
    await printApprovalLog(filters, { json: Boolean(options.json), stats: Boolean(options.stats) });
  });

program
  .name("mini-claude-code")
  .description("一个最小可运行的本地代码 Agent")
  .argument("[task]", "要执行的任务（不传则进入交互模式）")
  .option("-i, --interactive", "进入交互式会话模式")
  .option("-y, --yes", "自动确认需要批准的命令")
  .option("-r, --resume", "恢复上次交互式会话的上下文")
  .action(async (task: string | undefined, options: { interactive?: boolean; yes?: boolean; resume?: boolean }) => {
    if (!task || options.interactive) {
      await startInteractive({ autoApprove: Boolean(options.yes), resume: Boolean(options.resume) });
      return;
    }

    try {
      logSection("用户任务");
      logLine(task);
      if (!options.yes) {
        logLine("提示: 需要用户确认的命令在单次执行模式下默认会被拒绝；可加 `-y` 自动放行。");
      }

      const agent = new AgentOrchestrator({
        onConfirmCommand: async () => Boolean(options.yes)
      });
      const result = await agent.run(task);

      logSection("执行步骤");
      result.steps.forEach((step, index) => logStep(index + 1, step));

      if (result.diffs.length > 0) {
        logSection("变更预览");
        result.diffs.forEach((d) => {
          logDiffHeader(d.path, d.summary);
          d.diff.split("\n").forEach((line) => logDiffLine(line));
        });
      }

      logSection("最终结果");
      logSuccess(result.finalText);
    } catch (error) {
      logSection("执行失败");
      logError(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
