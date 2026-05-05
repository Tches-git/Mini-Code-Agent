#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { execa } from "execa";
import { AgentOrchestrator } from "../agent/orchestrator.js";
import { LlmClient } from "../llm/client.js";
import {
  getRuntimeEnvInfo,
  loadWorkspaceEnv,
  writeEnvTemplate,
} from "../llm/env.js";
import {
  applySandboxPatch,
  runTaskInWorktreeSandbox,
} from "../release/worktree.js";
import {
  logDiffHeader,
  logDiffLine,
  logEmptyState,
  logError,
  logHint,
  logKeyValue,
  logSection,
  logStatusLine,
  logStep,
  logSuccess,
} from "../utils/logger.js";
import {
  getAppDataDir,
  getWorkspaceRoot,
  setWorkspaceRoot,
} from "../utils/runtime.js";
import {
  type ApprovalLogFilters,
  parseApprovalLogQueryText,
  printApprovalLog,
} from "./approval-log.js";
import { runBenchmarkCommand } from "./benchmark.js";
import { startInteractive } from "./interactive.js";
import { runReleaseStandaloneCommand } from "./release.js";
import { printSessionDetail, printSessions } from "./sessions.js";

const program = new Command();

function getCliVersion(): string {
  const injectedVersion = process.env.MINI_CLAUDE_CODE_VERSION?.trim();
  if (injectedVersion) {
    return injectedVersion;
  }

  const packageJsonPath = fileURLToPath(
    new URL("../../package.json", import.meta.url),
  );
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      version?: string;
    };
    return packageJson.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function shouldRunAsEntrypoint(): boolean {
  if (process.env.MINI_CLAUDE_CODE_STANDALONE === "1") {
    return true;
  }

  if (!process.argv[1]) {
    return false;
  }

  try {
    return (
      path.resolve(fileURLToPath(import.meta.url)) ===
      path.resolve(process.argv[1])
    );
  } catch {
    return false;
  }
}

const CLI_VERSION = getCliVersion();

function configureHelp() {
  program.showHelpAfterError(
    "\n示例: mini-claude-code init && mini-claude-code doctor --ping",
  );
  program.addHelpText(
    "after",
    `
示例:
  $ mini-claude-code --version
  $ mini-claude-code init
  $ mini-claude-code doctor
  $ mini-claude-code doctor --ping
  $ mini-claude-code -i
  $ mini-claude-code "分析当前项目结构"
`,
  );
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`无效的数字: ${value}`);
  }
  return parsed;
}

function resolveWorkspaceOption(workspace?: string): string {
  return path.resolve(workspace?.trim() || process.cwd());
}

function applyWorkspaceRoot(workspace?: string): string {
  const resolved = resolveWorkspaceOption(workspace);
  setWorkspaceRoot(resolved);
  loadWorkspaceEnv(resolved);
  return resolved;
}

function logWorkspaceContext() {
  logKeyValue("工作区", getWorkspaceRoot());
  logKeyValue("用户数据目录", getAppDataDir());
}

export async function runInitCommand(options: {
  force?: boolean;
  cwd?: string;
}) {
  applyWorkspaceRoot(options.cwd);
  try {
    const result = await writeEnvTemplate({
      cwd: getWorkspaceRoot(),
      force: Boolean(options.force),
    });
    logSection("初始化完成");
    logWorkspaceContext();
    logKeyValue("结果", result.overwritten ? "已覆盖" : "已创建");
    logKeyValue("路径", result.path);
    logHint(
      "下一步: 编辑 .env 填写 OPENAI_API_KEY，然后运行 `mini-claude-code doctor --ping`。",
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

export async function runDoctorCommand(options: {
  json?: boolean;
  ping?: boolean;
  cwd?: string;
}) {
  applyWorkspaceRoot(options.cwd);
  const runtime = getRuntimeEnvInfo();
  const checks: Array<{
    name: string;
    ok: boolean;
    detail: string;
    required?: boolean;
  }> = [
    {
      name: "CLI 版本",
      ok: true,
      detail: CLI_VERSION,
    },
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
      detail: runtime.openaiApiKeyConfigured ? "已配置" : "未配置（必填）",
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

  if (options.ping) {
    if (!runtime.openaiApiKeyConfigured) {
      checks.push({
        name: "LLM API 连通性",
        ok: false,
        detail: "缺少 OPENAI_API_KEY，无法执行在线连通性检查",
        required: true,
      });
    } else {
      const connectivity = await new LlmClient().checkConnectivity();
      checks.push({
        name: "LLM API 连通性",
        ok: connectivity.ok,
        detail: connectivity.detail,
        required: true,
      });
    }
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
  logWorkspaceContext();
  logKeyValue("整体状态", allRequiredChecksPassed ? "通过" : "存在失败项");
  logKeyValue("检查总数", String(checks.length));
  logSection("检查详情");
  for (const check of checks) {
    logStatusLine(check.ok ? "PASS" : "FAIL", check.name);
    logKeyValue("详情", check.detail, "    ");
    if (check.required) {
      logKeyValue("级别", "必需", "    ");
    }
  }
  if (!runtime.openaiApiKeyConfigured) {
    logHint(
      "可先运行 `mini-claude-code init` 生成 .env，再填写 OPENAI_API_KEY。",
    );
  }
  if (!allRequiredChecksPassed) {
    process.exitCode = 1;
  }
}

program
  .command("init")
  .description("在当前目录或指定工作区生成 .env 配置模板")
  .option("-f, --force", "覆盖已有 .env")
  .option("--cwd <path>", "指定目标工作区目录")
  .addHelpText(
    "after",
    "\n下一步: 编辑 .env 填写 OPENAI_API_KEY，然后运行 `mini-claude-code doctor --ping`。\n",
  )
  .action(async (options: { force?: boolean; cwd?: string }) => {
    await runInitCommand({ force: Boolean(options.force), cwd: options.cwd });
  });

program
  .command("doctor")
  .description("检查指定工作区的 CLI 运行环境与配置")
  .option("--json", "以 JSON 输出")
  .option("--ping", "额外检查 LLM API 连通性")
  .option("--cwd <path>", "指定目标工作区目录")
  .addHelpText(
    "after",
    "\n建议先运行 `mini-claude-code init` 生成 .env，再执行 `doctor --ping`。\n",
  )
  .action(async (options: { json?: boolean; ping?: boolean; cwd?: string }) => {
    await runDoctorCommand({
      json: Boolean(options.json),
      ping: Boolean(options.ping),
      cwd: options.cwd,
    });
  });

program
  .command("approvals")
  .description("查询本地审批日志")
  .argument("[query]", "按命令或原因关键字过滤")
  .option(
    "-n, --limit <number>",
    "每页最多显示多少条记录",
    parsePositiveInteger,
    20,
  )
  .option("--page <number>", "显示第几页", parsePositiveInteger, 1)
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
  .option("--sort <sort>", "排序方式 (newest/oldest)")
  .option("--json", "以 JSON 输出")
  .action(
    async (
      query: string | undefined,
      options: {
        limit: number;
        page: number;
        decision?: "approved" | "rejected" | "blocked";
        source?: "tool" | "auto_validate" | "policy";
        kind?: "command" | "external_file" | "external_path";
        action?: "run" | "import" | "list" | "read" | "search" | "write";
        path?: string;
        after?: string;
        before?: string;
        stats?: boolean;
        sort?: "newest" | "oldest";
        json?: boolean;
      },
    ) => {
      const parsed = query ? parseApprovalLogQueryText(query) : undefined;
      const filters: ApprovalLogFilters = {
        contains: parsed?.filters.contains ?? query,
        limit: parsed?.filters.limit ?? options.limit,
        page: parsed?.filters.page ?? options.page,
        decision: parsed?.filters.decision ?? options.decision,
        source: parsed?.filters.source ?? options.source,
        kind: parsed?.filters.kind ?? options.kind,
        action: parsed?.filters.action ?? options.action,
        path: parsed?.filters.path ?? options.path,
        after: parsed?.filters.after ?? options.after,
        before: parsed?.filters.before ?? options.before,
        sort: parsed?.filters.sort ?? options.sort,
      };
      await printApprovalLog(filters, {
        json: parsed?.options.json ?? Boolean(options.json),
        stats: parsed?.options.stats ?? Boolean(options.stats),
      });
    },
  );

program
  .command("benchmark")
  .description("运行内置 benchmark 任务集（默认使用 temp_copy 隔离副本）")
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
  .command("release:standalone")
  .description("构建当前平台的 standalone 单文件 CLI 可执行产物")
  .option("--output-dir <path>", "输出目录，默认 dist/standalone")
  .option("--name <name>", "输出文件名，默认 mini-claude-code")
  .action(async (options: { outputDir?: string; name?: string }) => {
    await runReleaseStandaloneCommand({
      outputDir: options.outputDir,
      executableName: options.name,
    });
  });

program
  .command("sandbox:apply")
  .description("预检或应用 sandbox 生成的 patch")
  .argument("<patch>", "sandbox patch 文件路径")
  .option("--check", "只预检 patch 是否可应用，不写入文件")
  .option("--cwd <path>", "指定目标工作区目录")
  .action(
    async (patchPath: string, options: { check?: boolean; cwd?: string }) => {
      applyWorkspaceRoot(options.cwd);
      const result = await applySandboxPatch({
        patchPath,
        check: Boolean(options.check),
        cwd: getWorkspaceRoot(),
      });
      logSection(
        options.check ? "Sandbox Patch 预检完成" : "Sandbox Patch 已应用",
      );
      logKeyValue("Patch", result.patchPath);
      logKeyValue("模式", result.checkOnly ? "check" : "apply");
      logSuccess(result.applied ? "patch 已应用" : "patch 可应用");
    },
  );

program
  .command("sessions")
  .description("列出本地可恢复会话")
  .option("--json", "以 JSON 输出")
  .option(
    "-n, --limit <number>",
    "每页最多显示多少条记录",
    parsePositiveInteger,
    10,
  )
  .option("--page <number>", "显示第几页", parsePositiveInteger, 1)
  .option("--sort <sort>", "排序方式 (updated/created/turns)")
  .action(
    async (options: {
      json?: boolean;
      limit: number;
      page: number;
      sort?: "updated" | "created" | "turns";
    }) => {
      await printSessions({
        json: Boolean(options.json),
        limit: options.limit,
        page: options.page,
        sort: options.sort,
      });
    },
  );

program
  .command("session")
  .description("查看某个会话详情")
  .argument("<id>", "会话 ID")
  .option("--json", "以 JSON 输出")
  .action(async (id: string, options: { json?: boolean }) => {
    await printSessionDetail(id, { json: Boolean(options.json) });
  });

export async function runTaskCommand(
  task: string,
  options: {
    yes?: boolean;
    cwd?: string;
    sandbox?: boolean;
    keepSandbox?: boolean;
  },
) {
  applyWorkspaceRoot(options.cwd);
  logSection("用户任务");
  logWorkspaceContext();
  logKeyValue("目标", task);
  if (!options.yes) {
    logHint(
      "需要用户确认的命令在单次执行模式下默认会被拒绝；可加 `-y` 自动放行。",
    );
  }

  const result = options.sandbox
    ? await runTaskInWorktreeSandbox(task, {
        keep: Boolean(options.keepSandbox),
        onConfirmCommand: async () => Boolean(options.yes),
      })
    : await new AgentOrchestrator({
        onConfirmCommand: async () => Boolean(options.yes),
      }).run(task);

  if (options.sandbox && "sandboxPath" in result) {
    const sandboxResult = result as typeof result & {
      sandboxPath: string;
      kept: boolean;
      sandboxDiff: string;
      patchPath?: string;
      mergeHint: string;
    };
    logSection("Sandbox");
    logKeyValue("Worktree", sandboxResult.sandboxPath);
    logKeyValue("保留", sandboxResult.kept ? "是" : "否");
    logKeyValue("Diff", sandboxResult.sandboxDiff);
    if (sandboxResult.patchPath) {
      logKeyValue("Patch", sandboxResult.patchPath);
    }
    logHint(sandboxResult.mergeHint);
  }

  logSection("执行摘要");
  logKeyValue("步骤数", String(result.steps.length));
  logKeyValue("变更文件数", String(result.diffs.length));

  logSection("执行步骤");
  if (result.steps.length === 0) {
    logEmptyState("没有记录到执行步骤。");
  } else {
    for (const [index, step] of result.steps.entries()) {
      logStep(index + 1, step);
    }
  }

  logSection("变更预览");
  if (result.diffs.length > 0) {
    for (const d of result.diffs) {
      logDiffHeader(d.path, d.summary);
      for (const line of d.diff.split("\n")) logDiffLine(line);
    }
  } else {
    logEmptyState("本次执行未修改文件。");
  }

  logSection("最终结果");
  logSuccess(result.finalText);
}

configureHelp();

program
  .name("mini-claude-code")
  .description("一个可本地安装的代码 Agent CLI")
  .version(CLI_VERSION)
  .argument("[task]", "要执行的任务（不传则进入交互模式）")
  .option("-i, --interactive", "进入交互式会话模式")
  .option("-y, --yes", "自动确认需要批准的命令")
  .option("-r, --resume", "恢复上次交互式会话的上下文")
  .option("--resume-session <id>", "恢复指定会话 ID 的上下文")
  .option("--cwd <path>", "指定目标工作区目录")
  .option("--sandbox", "在临时 Git worktree 中隔离执行单次任务")
  .option("--keep-sandbox", "保留 sandbox worktree，便于检查结果")
  .action(
    async (
      task: string | undefined,
      options: {
        interactive?: boolean;
        yes?: boolean;
        resume?: boolean;
        resumeSession?: string;
        cwd?: string;
        sandbox?: boolean;
        keepSandbox?: boolean;
      },
    ) => {
      if (!task || options.interactive) {
        await startInteractive({
          autoApprove: Boolean(options.yes),
          resume: Boolean(options.resume),
          resumeSessionId: options.resumeSession,
          cwd: options.cwd,
        });
        return;
      }

      try {
        await runTaskCommand(task, {
          yes: Boolean(options.yes),
          cwd: options.cwd,
          sandbox: Boolean(options.sandbox),
          keepSandbox: Boolean(options.keepSandbox),
        });
      } catch (error) {
        logSection("执行失败");
        logError(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    },
  );

export async function runCli(argv = process.argv) {
  await program.parseAsync(argv);
}

function handleEntrypointError(error: unknown): never {
  logSection("执行失败");
  logError(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const isEntrypoint = shouldRunAsEntrypoint();

if (isEntrypoint) {
  runCli(process.argv).catch(handleEntrypointError);
}
