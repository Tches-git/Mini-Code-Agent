import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { z } from "zod";
import type { ToolDefinition } from "../types/agent.js";
import { appendCommandAudit } from "../utils/command-audit.js";
import { isPathOutsideWorkspace } from "../utils/path.js";
import {
  getProjectToolingConfig,
  readWorkspacePackageJson,
} from "../utils/project-tooling.js";
import { getWorkspaceRoot } from "../utils/runtime.js";
import { createTool } from "./create-tool.js";

const SHELL_SYNTAX_PATTERN = /&&|\|\||[|;<>`$\n\r]/;
const SAFE_EXECUTABLES = new Set([
  "cat",
  "find",
  "head",
  "ls",
  "pwd",
  "rg",
  "sed",
  "stat",
  "tail",
  "wc",
  "which",
]);
const SAFE_TOOLCHAIN_EXECUTABLES = new Set([
  "eslint",
  "jest",
  "prettier",
  "tsc",
  "vite",
  "vitest",
]);
const BLOCKED_EXECUTABLES = new Set([
  "rm",
  "rmdir",
  "dd",
  "fdisk",
  "parted",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "sudo",
  "launchctl",
  "osascript",
]);
const BLOCKED_NETWORK_EXECUTABLES = new Set([
  "curl",
  "wget",
  "ssh",
  "scp",
  "sftp",
  "nc",
  "ncat",
  "telnet",
]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const SAFE_GIT_SUBCOMMANDS = new Set([
  "branch",
  "diff",
  "log",
  "rev-parse",
  "show",
  "status",
]);
const GUARDED_GIT_SUBCOMMANDS = new Set([
  "add",
  "checkout",
  "cherry-pick",
  "commit",
  "fetch",
  "merge",
  "pull",
  "push",
  "rebase",
  "restore",
  "stash",
  "switch",
  "tag",
]);
const DEFAULT_SAFE_PACKAGE_MANAGER_SCRIPTS = [
  "build",
  "check",
  "lint",
  "test",
  "typecheck",
];
const DEFAULT_GUARDED_PACKAGE_MANAGER_SCRIPTS = [
  "chat",
  "dev",
  "install",
  "migrate",
  "seed",
  "start",
];
const GUARDED_PACKAGE_MANAGER_SUBCOMMANDS = new Set([
  "add",
  "ci",
  "create",
  "dlx",
  "exec",
  "import",
  "init",
  "install",
  "link",
  "remove",
  "unlink",
  "update",
  "upgrade",
]);
const SAFE_PACKAGE_MANAGER_SUBCOMMANDS = new Set(["run", "test"]);
const FORWARDED_MUTATING_FLAGS = new Set([
  "--fix",
  "--write",
  "-u",
  "--update",
  "--update-snapshots",
]);

const BLOCKED_SUBSTRINGS = [
  "rm -rf /",
  "rm -rf ~",
  "rm -rf .",
  "rmdir /",
  "git reset --hard",
  "git clean -fd",
  "git push --force",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "init 0",
  "init 6",
  "mkfs",
  "fdisk",
  "dd if=",
  "parted",
  "chmod 777",
  "chmod -R 777",
  "chown root",
  "curl|sh",
  "curl|bash",
  "wget|sh",
  "wget|bash",
  "unset PATH",
  "history -c",
  ":(){ :|:& };:",
];

const BLOCKED_PATTERNS: RegExp[] = [
  /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/(?![\w])/,
  />\s*\/dev\/[sh]d[a-z]/,
  /sudo\s+rm\s/,
  /chmod\s+-?R?\s*777\s/,
  /mkfs\.[a-z]+/,
  /dd\s+if=.*of=\/dev\//,
  /curl\s.*\|\s*(ba)?sh/,
  /wget\s.*\|\s*(ba)?sh/,
];

const MAX_COMMAND_LENGTH = 2000;
const COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_COMMAND_OUTPUT_LINE_LIMIT = 2000;
const MAX_COMMAND_OUTPUT_LINE_LIMIT = 5000;

export type CommandPolicy = {
  decision: "allow" | "confirm" | "block";
  reason: string;
  executable: string;
};

type CommandOutputPage = {
  text: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  nextOffset?: number;
};

type CommandOutputSnapshot = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  createdAt: string;
  timedOut?: boolean;
  failureReason?: string;
};

let lastCommandOutputSnapshot: CommandOutputSnapshot | null = null;

type PolicyConfig = {
  allow?: string[];
  confirm?: string[];
  block?: string[];
  sandboxDefault?: boolean;
};

let cachedPolicyConfig: {
  path: string;
  mtimeMs: number;
  config: PolicyConfig;
} | null = null;

function getPolicyConfigPath(): string {
  return path.join(getWorkspaceRoot(), ".local-code-agent", "policy.json");
}

function getLegacyPolicyConfigPath(): string {
  return path.join(getWorkspaceRoot(), ".mini-claude-code", "policy.json");
}

async function readPolicyConfig(): Promise<PolicyConfig> {
  let configPath = getPolicyConfigPath();
  try {
    try {
      await fs.access(configPath);
    } catch {
      configPath = getLegacyPolicyConfigPath();
    }
    const stat = await fs.stat(configPath);
    if (
      cachedPolicyConfig?.path === configPath &&
      cachedPolicyConfig.mtimeMs === stat.mtimeMs
    ) {
      return cachedPolicyConfig.config;
    }
    const parsed = JSON.parse(
      await fs.readFile(configPath, "utf8"),
    ) as PolicyConfig;
    const config: PolicyConfig = {
      allow: Array.isArray(parsed.allow) ? parsed.allow : [],
      confirm: Array.isArray(parsed.confirm) ? parsed.confirm : [],
      block: Array.isArray(parsed.block) ? parsed.block : [],
      sandboxDefault: Boolean(parsed.sandboxDefault),
    };
    cachedPolicyConfig = { path: configPath, mtimeMs: stat.mtimeMs, config };
    return config;
  } catch {
    return {};
  }
}

function parseConfiguredRules(envName: string): string[] {
  const raw = process.env[envName];
  if (!raw) return [];
  return raw
    .split(/[\n,;]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function matchesConfiguredRule(
  command: string,
  rules: string[],
): string | null {
  for (const rule of rules) {
    if (rule.endsWith("*")) {
      const prefix = rule.slice(0, -1);
      if (command.startsWith(prefix)) {
        return rule;
      }
      continue;
    }
    if (command === rule) {
      return rule;
    }
  }
  return null;
}

function getExecutableName(file: string): string {
  return path.basename(file).toLowerCase();
}

function validateExecutable(file: string): string | null {
  if (file.includes("/") && isPathOutsideWorkspace(file)) {
    return `禁止执行工作区外脚本: ${file}`;
  }

  const executable = getExecutableName(file);
  if (BLOCKED_EXECUTABLES.has(executable) || executable.startsWith("mkfs")) {
    return `命令 ${executable} 不允许通过 run_command 执行`;
  }

  if (BLOCKED_NETWORK_EXECUTABLES.has(executable)) {
    return `默认禁止网络或远程命令: ${executable}`;
  }

  return null;
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (char === "\\") {
      i += 1;
      if (i >= command.length) {
        throw new Error("命令以未完成的转义结尾");
      }
      current += command[i];
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new Error("命令中的引号未闭合");
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function isDangerous(command: string): string | null {
  const normalized = command.toLowerCase().replace(/\s+/g, " ").trim();

  if (command.length > MAX_COMMAND_LENGTH) {
    return `命令过长 (${command.length} 字符，上限 ${MAX_COMMAND_LENGTH})`;
  }

  if (SHELL_SYNTAX_PATTERN.test(command)) {
    return "禁止使用 shell 链式、管道、重定向或命令替换语法";
  }

  for (const blocked of BLOCKED_SUBSTRINGS) {
    if (normalized.includes(blocked.toLowerCase())) {
      return `匹配黑名单: "${blocked}"`;
    }
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return `匹配危险模式: ${pattern}`;
    }
  }

  return null;
}

async function resolveLocalToolchainCommand(executable: string): Promise<
  | {
      file: string;
      args: string[];
    }
  | undefined
> {
  const localBinPath = path.join(
    getWorkspaceRoot(),
    "node_modules",
    ".bin",
    executable,
  );

  try {
    await fs.access(localBinPath);
  } catch {
    return undefined;
  }

  return {
    file: process.execPath,
    args: [localBinPath],
  };
}

async function assessNestedPackageManagerInvocation(
  executable: string,
  parentScriptName: string,
  packageManager: string,
  args: string[],
  scripts: Record<string, string>,
  seenScripts: Set<string>,
): Promise<CommandPolicy> {
  const subcommand = args[0]?.toLowerCase();
  if (!subcommand) {
    return {
      decision: "allow",
      reason: `${executable} run ${parentScriptName} 仅调用了 ${packageManager} 帮助命令`,
      executable,
    };
  }

  if (GUARDED_PACKAGE_MANAGER_SUBCOMMANDS.has(subcommand)) {
    return {
      decision: "confirm",
      reason: `${executable} run ${parentScriptName} 会通过 ${packageManager} ${subcommand} 修改依赖或环境，需要用户确认`,
      executable,
    };
  }

  if (subcommand === "test") {
    if (!scripts.test) {
      return {
        decision: "block",
        reason: `${executable} run ${parentScriptName} 引用了不存在的脚本 test`,
        executable,
      };
    }
    if (hasForwardedMutatingFlags(args.slice(1))) {
      return {
        decision: "confirm",
        reason: `${executable} run ${parentScriptName} 通过 ${packageManager} test 携带了可能修改文件或快照的参数，需要用户确认`,
        executable,
      };
    }
    return assessProjectScript(
      executable,
      "test",
      scripts.test,
      scripts,
      seenScripts,
    );
  }

  if (subcommand === "run") {
    const nestedScriptName = args[1]?.toLowerCase();
    if (!nestedScriptName) {
      return {
        decision: "block",
        reason: `${executable} run ${parentScriptName} 中的 ${packageManager} run 缺少脚本名`,
        executable,
      };
    }
    if (!scripts[nestedScriptName]) {
      return {
        decision: "block",
        reason: `${executable} run ${parentScriptName} 引用了不存在的脚本 ${nestedScriptName}`,
        executable,
      };
    }
    if (hasForwardedMutatingFlags(args.slice(2))) {
      return {
        decision: "confirm",
        reason: `${executable} run ${parentScriptName} 通过 ${packageManager} run ${nestedScriptName} 携带了可能修改文件的参数，需要用户确认`,
        executable,
      };
    }
    return assessProjectScript(
      executable,
      nestedScriptName,
      scripts[nestedScriptName],
      scripts,
      seenScripts,
    );
  }

  if (packageManager === "yarn" && scripts[subcommand]) {
    if (hasForwardedMutatingFlags(args.slice(1))) {
      return {
        decision: "confirm",
        reason: `${executable} run ${parentScriptName} 通过 yarn ${subcommand} 携带了可能修改文件的参数，需要用户确认`,
        executable,
      };
    }
    return assessProjectScript(
      executable,
      subcommand,
      scripts[subcommand],
      scripts,
      seenScripts,
    );
  }

  return {
    decision: "confirm",
    reason: `${executable} run ${parentScriptName} 会通过 ${packageManager} ${subcommand} 执行额外命令，需要用户确认`,
    executable,
  };
}

async function assessProjectScript(
  executable: string,
  scriptName: string,
  scriptCommand: string,
  scripts: Record<string, string>,
  seenScripts = new Set<string>(),
): Promise<CommandPolicy> {
  if (seenScripts.has(scriptName)) {
    return {
      decision: "confirm",
      reason: `${executable} run ${scriptName} 存在脚本递归调用，需要用户确认`,
      executable,
    };
  }
  const nextSeenScripts = new Set(seenScripts);
  nextSeenScripts.add(scriptName);

  const syntaxIssue = isDangerous(scriptCommand.trim());
  if (syntaxIssue) {
    return {
      decision: "confirm",
      reason: `${executable} run ${scriptName} 会执行复杂项目脚本，需要用户确认`,
      executable,
    };
  }

  let file = "";
  let args: string[] = [];
  try {
    [file, ...args] = tokenizeCommand(scriptCommand);
  } catch {
    return {
      decision: "confirm",
      reason: `${executable} run ${scriptName} 会执行项目脚本，需要用户确认`,
      executable,
    };
  }

  if (!file) {
    return {
      decision: "confirm",
      reason: `${executable} run ${scriptName} 会执行项目脚本，需要用户确认`,
      executable,
    };
  }

  const executableIssue = validateExecutable(file);
  if (executableIssue) {
    return {
      decision: "block",
      reason: `${executable} run ${scriptName} 对应脚本不允许执行: ${executableIssue}`,
      executable,
    };
  }

  const scriptExecutable = getExecutableName(file);
  if (file.includes("/")) {
    return {
      decision: "confirm",
      reason: `${executable} run ${scriptName} 会直接执行本地脚本，需要用户确认`,
      executable,
    };
  }

  if (PACKAGE_MANAGERS.has(scriptExecutable)) {
    return assessNestedPackageManagerInvocation(
      executable,
      scriptName,
      scriptExecutable,
      args,
      scripts,
      nextSeenScripts,
    );
  }

  if (scriptExecutable === "node" || scriptExecutable === "tsx") {
    return {
      decision: "confirm",
      reason: `${executable} run ${scriptName} 会直接执行本地代码，需要用户确认`,
      executable,
    };
  }

  if (
    SAFE_EXECUTABLES.has(scriptExecutable) ||
    SAFE_TOOLCHAIN_EXECUTABLES.has(scriptExecutable)
  ) {
    return {
      decision: "allow",
      reason: `${executable} run ${scriptName} 属于已知安全脚本`,
      executable,
    };
  }

  if (scriptExecutable === "git") {
    const gitPolicy = await assessGitCommand(args);
    return gitPolicy.decision === "allow"
      ? {
          decision: "allow",
          reason: `${executable} run ${scriptName} 属于已知安全脚本`,
          executable,
        }
      : {
          decision: "confirm",
          reason: `${executable} run ${scriptName} 会执行项目脚本，需要用户确认`,
          executable,
        };
  }

  return {
    decision: "confirm",
    reason: `${executable} run ${scriptName} 会执行项目脚本，需要用户确认`,
    executable,
  };
}

async function assessGitCommand(args: string[]): Promise<CommandPolicy> {
  const subcommand = args[0]?.toLowerCase();
  if (!subcommand) {
    return {
      decision: "allow",
      reason: "git 帮助命令允许直接执行",
      executable: "git",
    };
  }
  if (SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
    return {
      decision: "allow",
      reason: `git ${subcommand} 属于只读或低风险命令`,
      executable: "git",
    };
  }
  if (GUARDED_GIT_SUBCOMMANDS.has(subcommand)) {
    return {
      decision: "confirm",
      reason: `git ${subcommand} 可能修改仓库状态，需要用户确认`,
      executable: "git",
    };
  }
  return {
    decision: "block",
    reason: `git ${subcommand} 不在允许列表中`,
    executable: "git",
  };
}

function hasForwardedMutatingFlags(args: string[]): boolean {
  return args.some((arg) => FORWARDED_MUTATING_FLAGS.has(arg.toLowerCase()));
}

function normalizeCommandOutputOffset(offset?: number): number {
  return Number.isFinite(offset) ? Math.max(0, offset || 0) : 0;
}

function normalizeCommandOutputLimit(limit?: number): number {
  return Number.isFinite(limit)
    ? Math.max(
        1,
        Math.min(
          MAX_COMMAND_OUTPUT_LINE_LIMIT,
          limit || DEFAULT_COMMAND_OUTPUT_LINE_LIMIT,
        ),
      )
    : DEFAULT_COMMAND_OUTPUT_LINE_LIMIT;
}

function paginateCommandOutput(
  text: string,
  offset?: number,
  limit?: number,
): CommandOutputPage {
  const normalizedOffset = normalizeCommandOutputOffset(offset);
  const normalizedLimit = normalizeCommandOutputLimit(limit);
  const lines = text ? text.split("\n") : [];
  const selected = lines.slice(
    normalizedOffset,
    normalizedOffset + normalizedLimit,
  );
  const endLine = normalizedOffset + selected.length;
  const truncated = endLine < lines.length;

  return {
    text: selected.join("\n"),
    totalLines: lines.length,
    startLine: selected.length > 0 ? normalizedOffset + 1 : 0,
    endLine,
    truncated,
    nextOffset: truncated ? endLine : undefined,
  };
}

function getCommandErrorSummary(
  exitCode: number | null | undefined,
  stderr: string,
  stdout: string,
): string | undefined {
  if (!exitCode) return undefined;
  const combined = `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const interesting = combined.filter((line) =>
    /error|failed|failure|exception|not found|cannot|denied|traceback|syntax/i.test(
      line,
    ),
  );
  return (
    (interesting.length > 0 ? interesting : combined).slice(0, 12).join("\n") ||
    undefined
  );
}

function getPreferredOutputStream(
  exitCode: number | null | undefined,
  stdout: string,
  stderr: string,
): "stdout" | "stderr" {
  return exitCode && stderr.trim()
    ? "stderr"
    : stdout.trim()
      ? "stdout"
      : "stderr";
}

function isCommandTimeoutResult(result: {
  timedOut?: boolean;
  signal?: string | null;
  stderr?: string;
}): boolean {
  return Boolean(
    result.timedOut ||
      result.signal === "SIGTERM" ||
      /timed? out|timeout/i.test(result.stderr || ""),
  );
}

async function shouldSandboxCommand(requested?: boolean): Promise<boolean> {
  if (requested !== undefined) return requested;
  const policyConfig = await readPolicyConfig();
  return Boolean(policyConfig.sandboxDefault);
}

async function runCommandInSandbox(
  file: string,
  args: string[],
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  failed?: boolean;
  code?: string | number;
  timedOut?: boolean;
  signal?: string | null;
}> {
  const workspaceRoot = getWorkspaceRoot();
  const sandboxParent = await fs.mkdtemp(
    path.join(os.tmpdir(), "mini-command-sandbox-"),
  );
  const sandboxPath = path.join(sandboxParent, "workspace");
  try {
    const gitCheck = await execa(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      {
        cwd: workspaceRoot,
        reject: false,
      },
    );
    if ((gitCheck.exitCode ?? 1) === 0) {
      const worktree = await execa(
        "git",
        ["worktree", "add", "--detach", sandboxPath, "HEAD"],
        { cwd: workspaceRoot, reject: false },
      );
      if ((worktree.exitCode ?? 1) !== 0) {
        throw new Error(worktree.stderr || "创建命令 sandbox worktree 失败");
      }
    } else {
      await fs.cp(workspaceRoot, sandboxPath, {
        recursive: true,
        filter: (source) => !source.includes(`${path.sep}.git${path.sep}`),
      });
    }
    const result = await execa(file, args, {
      cwd: sandboxPath,
      reject: false,
      timeout: COMMAND_TIMEOUT_MS,
    });
    return {
      ...result,
      exitCode: result.exitCode ?? null,
      stdout:
        `${result.stdout}\n\n[sandbox] 命令在隔离副本中执行，原工作区未修改: ${sandboxPath}`.trim(),
    };
  } finally {
    await execa("git", ["worktree", "remove", "--force", sandboxPath], {
      cwd: workspaceRoot,
      reject: false,
    }).catch(() => {});
    await fs.rm(sandboxParent, { recursive: true, force: true });
  }
}

function getLastCommandOutputPage(options: {
  stream?: "stdout" | "stderr";
  outputOffset?: number;
  outputLimit?: number;
}) {
  if (!lastCommandOutputSnapshot) {
    throw new Error("没有可读取的上一次命令输出，请先运行 run_command");
  }
  const stream = options.stream || "stdout";
  const page = paginateCommandOutput(
    stream === "stderr"
      ? lastCommandOutputSnapshot.stderr
      : lastCommandOutputSnapshot.stdout,
    options.outputOffset,
    options.outputLimit,
  );
  return JSON.stringify(
    {
      command: lastCommandOutputSnapshot.command,
      exitCode: lastCommandOutputSnapshot.exitCode,
      createdAt: lastCommandOutputSnapshot.createdAt,
      stream,
      output: page.text,
      page,
      timedOut: lastCommandOutputSnapshot.timedOut,
      failureReason: lastCommandOutputSnapshot.failureReason,
    },
    null,
    2,
  );
}

async function assessPackageManagerCommand(
  executable: string,
  args: string[],
): Promise<CommandPolicy> {
  const packageJson = await readWorkspacePackageJson();
  const scripts = packageJson?.scripts || {};
  const tooling = getProjectToolingConfig(packageJson);
  const safeScripts = new Set([
    ...DEFAULT_SAFE_PACKAGE_MANAGER_SCRIPTS,
    ...tooling.commandPolicy.safeScripts,
  ]);
  const guardedScripts = new Set([
    ...DEFAULT_GUARDED_PACKAGE_MANAGER_SCRIPTS,
    ...tooling.commandPolicy.guardedScripts,
  ]);
  const subcommand = args[0]?.toLowerCase();

  if (!subcommand) {
    return {
      decision: "allow",
      reason: `${executable} 帮助命令允许直接执行`,
      executable,
    };
  }

  if (
    !SAFE_PACKAGE_MANAGER_SUBCOMMANDS.has(subcommand) &&
    !GUARDED_PACKAGE_MANAGER_SUBCOMMANDS.has(subcommand)
  ) {
    if (executable === "yarn" && scripts[subcommand]) {
      return assessProjectScript(
        executable,
        subcommand,
        scripts[subcommand],
        scripts,
      );
    }
    return {
      decision: "block",
      reason: `${executable} ${subcommand} 不在允许列表中`,
      executable,
    };
  }

  if (GUARDED_PACKAGE_MANAGER_SUBCOMMANDS.has(subcommand)) {
    return {
      decision: "confirm",
      reason: `${executable} ${subcommand} 可能安装依赖或执行外部代码，需要用户确认`,
      executable,
    };
  }

  if (subcommand === "test") {
    if (!scripts.test) {
      return {
        decision: "block",
        reason: `项目中不存在脚本 test`,
        executable,
      };
    }
    if (hasForwardedMutatingFlags(args.slice(1))) {
      return {
        decision: "confirm",
        reason: `${executable} test 携带可能修改文件或快照的参数，需要用户确认`,
        executable,
      };
    }
    return assessProjectScript(executable, "test", scripts.test, scripts);
  }

  if (subcommand === "run") {
    const scriptName = args[1]?.toLowerCase();
    if (!scriptName) {
      return {
        decision: "block",
        reason: `${executable} run 需要指定脚本名`,
        executable,
      };
    }
    if (!scripts[scriptName]) {
      return {
        decision: "block",
        reason: `项目中不存在脚本 ${scriptName}`,
        executable,
      };
    }
    if (safeScripts.has(scriptName)) {
      if (hasForwardedMutatingFlags(args.slice(2))) {
        return {
          decision: "confirm",
          reason: `${executable} run ${scriptName} 携带可能修改文件的参数，需要用户确认`,
          executable,
        };
      }
      return assessProjectScript(
        executable,
        scriptName,
        scripts[scriptName],
        scripts,
      );
    }
    if (guardedScripts.has(scriptName)) {
      return {
        decision: "confirm",
        reason: `${executable} run ${scriptName} 可能启动服务或改动环境，需要用户确认`,
        executable,
      };
    }
    return {
      decision: "confirm",
      reason: `${executable} run ${scriptName} 会执行项目脚本，需要用户确认`,
      executable,
    };
  }

  return {
    decision: "allow",
    reason: `${executable} ${subcommand} 属于允许的包管理器命令`,
    executable,
  };
}

export async function getRunCommandPolicy(
  command: string,
): Promise<CommandPolicy> {
  const normalizedCommand = command.trim();
  const syntaxIssue = isDangerous(normalizedCommand);
  if (syntaxIssue) {
    return { decision: "block", reason: syntaxIssue, executable: "" };
  }

  const policyConfig = await readPolicyConfig();
  const policyBlockedRule = matchesConfiguredRule(
    normalizedCommand,
    policyConfig.block || [],
  );
  if (policyBlockedRule) {
    return {
      decision: "block",
      reason: `命中 .local-code-agent/policy.json block 规则: ${policyBlockedRule}`,
      executable: "",
    };
  }

  const policyAllowedRule = matchesConfiguredRule(
    normalizedCommand,
    policyConfig.allow || [],
  );
  if (policyAllowedRule) {
    return {
      decision: "allow",
      reason: `命中 .local-code-agent/policy.json allow 规则: ${policyAllowedRule}`,
      executable: "",
    };
  }

  const policyGuardedRule = matchesConfiguredRule(
    normalizedCommand,
    policyConfig.confirm || [],
  );
  if (policyGuardedRule) {
    return {
      decision: "confirm",
      reason: `命中 .local-code-agent/policy.json confirm 规则: ${policyGuardedRule}`,
      executable: "",
    };
  }

  const blockedRule = matchesConfiguredRule(
    normalizedCommand,
    parseConfiguredRules("RUN_COMMAND_BLOCKLIST"),
  );
  if (blockedRule) {
    return {
      decision: "block",
      reason: `命中环境变量 RUN_COMMAND_BLOCKLIST 规则: ${blockedRule}`,
      executable: "",
    };
  }

  const allowedRule = matchesConfiguredRule(
    normalizedCommand,
    parseConfiguredRules("RUN_COMMAND_ALLOWLIST"),
  );
  if (allowedRule) {
    return {
      decision: "allow",
      reason: `命中环境变量 RUN_COMMAND_ALLOWLIST 规则: ${allowedRule}`,
      executable: "",
    };
  }

  const guardedRule = matchesConfiguredRule(
    normalizedCommand,
    parseConfiguredRules("RUN_COMMAND_GUARDLIST"),
  );
  if (guardedRule) {
    return {
      decision: "confirm",
      reason: `命中环境变量 RUN_COMMAND_GUARDLIST 规则: ${guardedRule}`,
      executable: "",
    };
  }

  let file = "";
  let args: string[] = [];
  try {
    [file, ...args] = tokenizeCommand(normalizedCommand);
  } catch (error) {
    return {
      decision: "block",
      reason: error instanceof Error ? error.message : String(error),
      executable: "",
    };
  }

  if (!file) {
    return { decision: "block", reason: "命令不能为空", executable: "" };
  }

  const executableIssue = validateExecutable(file);
  const executable = getExecutableName(file);
  if (executableIssue) {
    return { decision: "block", reason: executableIssue, executable };
  }

  if (file.includes("/")) {
    return {
      decision: "confirm",
      reason: `执行工作区脚本 ${file} 会直接运行本地代码，需要用户确认`,
      executable,
    };
  }

  if (
    SAFE_EXECUTABLES.has(executable) ||
    SAFE_TOOLCHAIN_EXECUTABLES.has(executable)
  ) {
    return {
      decision: "allow",
      reason: `${executable} 在安全白名单内`,
      executable,
    };
  }

  if (executable === "git") {
    return assessGitCommand(args);
  }

  if (PACKAGE_MANAGERS.has(executable)) {
    return assessPackageManagerCommand(executable, args);
  }

  if (executable === "node" || executable === "tsx") {
    return {
      decision: "confirm",
      reason: `${executable} 会直接执行本地脚本，需要用户确认`,
      executable,
    };
  }

  if (executable === "npx") {
    return {
      decision: "confirm",
      reason: "npx 可能下载并执行外部包，需要用户确认",
      executable,
    };
  }

  return {
    decision: "block",
    reason: `命令 ${executable} 不在允许白名单中`,
    executable,
  };
}

export {
  getCommandErrorSummary,
  getLastCommandOutputPage,
  getPreferredOutputStream,
  isCommandTimeoutResult,
  paginateCommandOutput,
};

export const commandTools: ToolDefinition[] = [
  createTool({
    name: "read_command_output",
    description:
      "读取上一次 run_command 的 stdout 或 stderr 后续分页，不重新执行命令",
    schema: z.object({
      stream: z.enum(["stdout", "stderr"]).optional(),
      outputOffset: z.number().int().min(0).optional(),
      outputLimit: z
        .number()
        .int()
        .min(1)
        .max(MAX_COMMAND_OUTPUT_LINE_LIMIT)
        .optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        stream: {
          type: "string",
          enum: ["stdout", "stderr"],
          description: "可选，要读取 stdout 还是 stderr，默认 stdout",
        },
        outputOffset: {
          type: "number",
          description: "可选，从第几行开始返回（0-based）",
        },
        outputLimit: {
          type: "number",
          description: `可选，最多返回多少行，范围 1-${MAX_COMMAND_OUTPUT_LINE_LIMIT}，默认 ${DEFAULT_COMMAND_OUTPUT_LINE_LIMIT}`,
        },
      },
    },
    async execute(input) {
      return getLastCommandOutputPage(input);
    },
  }),
  createTool({
    name: "run_command",
    description: "运行工作区内的命令，例如 npm run build",
    schema: z.object({
      command: z.string().min(1, "命令不能为空"),
      outputOffset: z.number().int().min(0).optional(),
      outputLimit: z
        .number()
        .int()
        .min(1)
        .max(MAX_COMMAND_OUTPUT_LINE_LIMIT)
        .optional(),
      confirmed: z.boolean().optional(),
      sandbox: z.boolean().optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        outputOffset: {
          type: "number",
          description:
            "可选，从 stdout/stderr 第几行开始返回（0-based），默认 0",
        },
        outputLimit: {
          type: "number",
          description: `可选，stdout/stderr 最多各返回多少行，范围 1-${MAX_COMMAND_OUTPUT_LINE_LIMIT}，默认 ${DEFAULT_COMMAND_OUTPUT_LINE_LIMIT}`,
        },
        confirmed: {
          type: "boolean",
          description: "仅当用户已明确确认后才传 true",
        },
        sandbox: {
          type: "boolean",
          description:
            "可选，true 时在临时 sandbox/worktree 中执行命令，不修改当前工作区；未传时遵循 policy.json 的 sandboxDefault",
        },
      },
      required: ["command"],
    },
    async execute(input) {
      const policy = await getRunCommandPolicy(input.command);
      if (policy.decision === "block") {
        await appendCommandAudit({
          timestamp: new Date().toISOString(),
          command: input.command,
          reason: policy.reason,
          decision: "blocked",
          source: "policy",
        });
        throw new Error(
          `检测到危险命令: ${input.command}\n原因: ${policy.reason}`,
        );
      }
      if (policy.decision === "confirm" && !input.confirmed) {
        throw new Error(
          `命令需要用户确认后才能执行: ${input.command}\n原因: ${policy.reason}`,
        );
      }

      const [file, ...args] = tokenizeCommand(input.command);
      if (!file) {
        throw new Error("命令不能为空");
      }

      const executable = getExecutableName(file);
      const localToolchainCommand =
        !file.includes("/") && SAFE_TOOLCHAIN_EXECUTABLES.has(executable)
          ? await resolveLocalToolchainCommand(executable)
          : undefined;
      const commandFile = localToolchainCommand?.file || file;
      const commandArgs = localToolchainCommand?.args
        ? [...localToolchainCommand.args, ...args]
        : args;
      const result = (await shouldSandboxCommand(input.sandbox))
        ? await runCommandInSandbox(commandFile, commandArgs)
        : await execa(commandFile, commandArgs, {
            cwd: getWorkspaceRoot(),
            reject: false,
            timeout: COMMAND_TIMEOUT_MS,
          });
      if (result.failed && result.code === "ENOENT") {
        throw new Error(`命令不存在或不可执行: ${file}`);
      }
      const timedOut = isCommandTimeoutResult(result);
      const failureReason = timedOut
        ? `命令超时（${COMMAND_TIMEOUT_MS}ms），已返回已捕获的部分输出。`
        : undefined;
      lastCommandOutputSnapshot = {
        command: input.command,
        exitCode: result.exitCode ?? null,
        stdout: result.stdout,
        stderr: result.stderr,
        createdAt: new Date().toISOString(),
        timedOut,
        failureReason,
      };
      const stdoutPage = paginateCommandOutput(
        result.stdout,
        input.outputOffset,
        input.outputLimit,
      );
      const stderrPage = paginateCommandOutput(
        result.stderr,
        input.outputOffset,
        input.outputLimit,
      );
      const errorSummary = getCommandErrorSummary(
        result.exitCode,
        result.stderr,
        result.stdout,
      );
      const preferredStream = getPreferredOutputStream(
        result.exitCode,
        result.stdout,
        result.stderr,
      );
      return JSON.stringify(
        {
          command: input.command,
          exitCode: result.exitCode,
          stdout: stdoutPage.text,
          stderr: stderrPage.text,
          preferredStream,
          preferredOutput:
            preferredStream === "stderr" ? stderrPage.text : stdoutPage.text,
          stdoutPage,
          stderrPage,
          errorSummary,
          timedOut,
          failureReason,
          nextPageHint:
            stdoutPage.truncated || stderrPage.truncated
              ? "使用 read_command_output 读取上一次命令输出的后续页，无需重跑命令。"
              : undefined,
        },
        null,
        2,
      );
    },
  }),
];
