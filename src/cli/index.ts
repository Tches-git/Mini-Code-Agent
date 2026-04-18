#!/usr/bin/env node
import { existsSync } from "node:fs";
import { Command } from "commander";
import { execa } from "execa";
import { AgentOrchestrator } from "../agent/orchestrator.js";
import { getRuntimeEnvInfo, writeEnvTemplate } from "../llm/env.js";
import {
  logDiffHeader,
  logDiffLine,
  logError,
  logLine,
  logSection,
  logStep,
  logSuccess,
} from "../utils/logger.js";
import { type ApprovalLogFilters, printApprovalLog } from "./approval-log.js";
import { runBenchmarkCommand } from "./benchmark.js";
import { startInteractive } from "./interactive.js";
import { printSessionDetail, printSessions } from "./sessions.js";

const program = new Command();

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`无效的数字: ${value}`);
  }
  return parsed;
}

async function runInitCommand(options: { force?: boolean }) {
  try {
    const result = await writeEnvTemplate({ force: Boolean(options.force) });
    logSection("初始化完成");
    logSuccess(
      `${result.overwritten ? "已覆盖" : "已创建"} ${result.path}`,
    );
    logLine(
      "下一步: 编辑 .env 填写 OPENAI_API_KEY，然后运行 `mini-claude-code doctor`。",
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      logSection("初始化失败");
      logError("当前目录已存在 .env；如需覆盖，请追加 --force。");
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

async function runDoctorCommand(options: { json?: boolean }) {
  const runtime = getRuntimeEnvInfo();
  const checks: Array<{
    name: string;
    ok: boolean;
    detail: string;
    required?: boolean;
  }> = [
    {
      name: "Node.js >= 18",
      ok: Number.parseInt(process.versions.node.split(".")[0] || "0", 10) >= 18,
      detail: `当前版本 ${process.versions.node}`,
      required: true,
    },
    {
      name: "已检测到 package.json",
      ok: existsSync("package.json"),
      detail: existsSync("package.json")
        ? "当前目录看起来是一个项目工作区"
        : "建议在目标项目目录中运行此命令",
    },
    {
      name: ".env 文件",
      ok: runtime.hasEnvFile,
      detail: runtime.hasEnvFile
        ? `已检测到 ${runtime.envFilePath}`
        : `未检测到 ${runtime.envFilePath}`,
    },
    {
      name: "OPENAI_API_KEY",
      ok: runtime.openaiApiKeyConfigured,
      detail: runtime.openaiApiKeyConfigured
        ? "已配置"
        : "未配置（必填）",
      required: true,
    },
    {
      name: "OPENAI_BASE_URL",
      ok: true,
      detail: runtime.openaiBaseUrl || "未设置（将使用官方默认端点）",
    },
    {
      name: "MODEL_NAME",
      ok: true,
      detail: runtime.modelName,
    },
  ];

  try {
    const result = await execa("rg", ["--version"]);
    checks.push({
      name: "ripgrep (rg)",
      ok: true,
      detail: result.stdout.split("\n")[0] || "已安装",
    });
  } catch {
    checks.push({
      name: "ripgrep (rg)",
      ok: false,
      detail: "未安装；search_text 会回退到 Node.js 遍历，性能可能较差",
    });
  }

  const allRequiredChecksPassed = checks.every(
    (check) => !check.required || check.ok,
  );

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: allRequiredChecksPassed,
          checks,
        },
        null,
        2,
      ),
    );
    if (!allRequiredChecksPassed) {
      process.exitCode = 1;
    }
    return;
  }

  logSection("环境自检");
  for (const check of checks) {
    (check.ok ? logSuccess : logError)(`${check.name}: ${check.detail}`);
  }
  if (!runtime.openaiApiKeyConfigured) {
    logLine("提示: 可先运行 `mini-claude-code init` 生成 .env，再填写 OPENAI_API_KEY。");
  }
  if (!allRequiredChecksPassed) {
    process.exitCode = 1;
  }
}

program
  .command("init")
  .description("在当前目录生成 .env 配置模板")
  .option("-f, --force", "覆盖已有 .env")
  .action(async (options: { force?: boolean }) => {
    await runInitCommand({ force: Boolean(options.force) });
  });

program
  .command("doctor")
  .description("检查本地 CLI 运行环境与配置")
  .option("--json", "以 JSON 输出")
  .action(async (options: { json?: boolean }) => {
    await runDoctorCommand({ json: Boolean(options.json) });
  });

program
  .command("approvals")
  .description("查询本地审批日志")
  .argument("[query]", "按命令或原因关键字过滤")
  .option(
    "-n, --limit <number>",
    "最多显示多少条记录",
    parsePositiveInteger,
    20,
  )
  .option("--decision <decision>", "按审批结果过滤 (approved/rejected/blocked)")
  .option("--source <source>", "按来源过滤 (tool/auto_validate/policy)")
  .option("--kind <kind>", "按类别过滤 (command/external_file/external_path)")
  .option("--action <action>", "按动作过滤 (run/import/list/read/search/write)")
  .option("--path <path>", "按目标路径过滤")
  .option(
    "--after <time>",
    "仅显示某个时间之后的记录，例如 7d、24h、2026-03-25",
  )
  .option(
    "--before <time>",
    "仅显示某个时间之前的记录，例如 2w、2026-03-25T10:00",
  )
  .option("--stats", "显示当前筛选结果的汇总统计")
  .option("--json", "以 JSON 输出")
  .action(
    async (
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
      },
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
        before: options.before,
      };
      await printApprovalLog(filters, {
        json: Boolean(options.json),
        stats: Boolean(options.stats),
      });
    },
  );

program
  .command("benchmark")
  .description("运行内置 benchmark 任务集")
  .option(
    "--task <id>",
    "仅运行指定 benchmark 任务，可重复传入",
    (value, previous: string[] = []) => [...previous, value],
    [],
  )
  .option("--output <path>", "结果 JSON 输出路径")
  .option("--list", "列出所有 benchmark 任务")
  .option("--json", "以 JSON 输出结果")
  .option("--include-disabled", "包含默认禁用的 benchmark 草案任务")
  .option("--isolation-mode <mode>", "隔离执行模式 (in_place/temp_copy)")
  .option("--keep-isolated-workspace", "保留隔离副本，便于排查 benchmark 问题")
  .action(
    async (options: {
      task: string[];
      output?: string;
      list?: boolean;
      json?: boolean;
      includeDisabled?: boolean;
      isolationMode?: "in_place" | "temp_copy";
      keepIsolatedWorkspace?: boolean;
    }) => {
      await runBenchmarkCommand({
        taskIds: options.task,
        output: options.output,
        list: Boolean(options.list),
        json: Boolean(options.json),
        includeDisabled: Boolean(options.includeDisabled),
        isolationMode: options.isolationMode,
        keepIsolatedWorkspace: Boolean(options.keepIsolatedWorkspace),
      });
    },
  );

program
  .command("sessions")
  .description("列出本地可恢复会话")
  .option("--json", "以 JSON 输出")
  .action(async (options: { json?: boolean }) => {
    await printSessions({ json: Boolean(options.json) });
  });

program
  .command("session")
  .description("查看某个会话详情")
  .argument("<id>", "会话 ID")
  .option("--json", "以 JSON 输出")
  .action(async (id: string, options: { json?: boolean }) => {
    await printSessionDetail(id, { json: Boolean(options.json) });
  });

program
  .name("mini-claude-code")
  .description("一个最小可运行的本地代码 Agent")
  .argument("[task]", "要执行的任务（不传则进入交互模式）")
  .option("-i, --interactive", "进入交互式会话模式")
  .option("-y, --yes", "自动确认需要批准的命令")
  .option("-r, --resume", "恢复上次交互式会话的上下文")
  .option("--resume-session <id>", "恢复指定会话 ID 的上下文")
  .action(
    async (
      task: string | undefined,
      options: {
        interactive?: boolean;
        yes?: boolean;
        resume?: boolean;
        resumeSession?: string;
      },
    ) => {
      if (!task || options.interactive) {
        await startInteractive({
          autoApprove: Boolean(options.yes),
          resume: Boolean(options.resume),
          resumeSessionId: options.resumeSession,
        });
        return;
      }

      try {
        logSection("用户任务");
        logLine(task);
        if (!options.yes) {
          logLine(
            "提示: 需要用户确认的命令在单次执行模式下默认会被拒绝；可加 `-y` 自动放行。",
          );
        }

        const agent = new AgentOrchestrator({
          onConfirmCommand: async () => Boolean(options.yes),
        });
        const result = await agent.run(task);

        logSection("执行步骤");
        for (const [index, step] of result.steps.entries())
          logStep(index + 1, step);

        if (result.diffs.length > 0) {
          logSection("变更预览");
          for (const d of result.diffs) {
            logDiffHeader(d.path, d.summary);
            for (const line of d.diff.split("\n")) logDiffLine(line);
          }
        }

        logSection("最终结果");
        logSuccess(result.finalText);
      } catch (error) {
        logSection("执行失败");
        logError(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    },
  );

program.parseAsync(process.argv);
