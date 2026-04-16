import { promises as fs } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { z } from "zod";
import type { ToolDefinition } from "../types/agent.js";
import { appendCommandAudit } from "../utils/command-audit.js";
import { isPathOutsideWorkspace } from "../utils/path.js";
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
const SAFE_PACKAGE_MANAGER_SCRIPTS = new Set([
  "build",
  "check",
  "lint",
  "test",
  "typecheck",
]);
const GUARDED_PACKAGE_MANAGER_SCRIPTS = new Set([
  "chat",
  "dev",
  "install",
  "migrate",
  "seed",
  "start",
]);
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

export type CommandPolicy = {
  decision: "allow" | "confirm" | "block";
  reason: string;
  executable: string;
};

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

async function readPackageScripts(): Promise<Record<string, string>> {
  try {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as {
      scripts?: Record<string, string>;
    };
    return packageJson.scripts || {};
  } catch {
    return {};
  }
}

async function resolveLocalToolchainCommand(executable: string): Promise<
  | {
      file: string;
      args: string[];
    }
  | undefined
> {
  const localBinPath = path.join(process.cwd(), "node_modules", ".bin", executable);

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

async function assessProjectScript(
  executable: string,
  scriptName: string,
  scriptCommand: string,
): Promise<CommandPolicy> {
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

async function assessPackageManagerCommand(
  executable: string,
  args: string[],
): Promise<CommandPolicy> {
  const scripts = await readPackageScripts();
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
      if (SAFE_PACKAGE_MANAGER_SCRIPTS.has(subcommand)) {
        return assessProjectScript(executable, subcommand, scripts[subcommand]);
      }
      return {
        decision: "confirm",
        reason: `${executable} ${subcommand} 会执行项目脚本，需要用户确认`,
        executable,
      };
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
    return {
      decision: "allow",
      reason: `${executable} test 属于验证命令`,
      executable,
    };
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
    if (SAFE_PACKAGE_MANAGER_SCRIPTS.has(scriptName)) {
      return assessProjectScript(executable, scriptName, scripts[scriptName]);
    }
    if (GUARDED_PACKAGE_MANAGER_SCRIPTS.has(scriptName)) {
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

export const commandTools: ToolDefinition[] = [
  createTool({
    name: "run_command",
    description: "运行工作区内的命令，例如 npm run build",
    schema: z.object({
      command: z.string().min(1, "命令不能为空"),
      confirmed: z.boolean().optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        confirmed: {
          type: "boolean",
          description: "仅当用户已明确确认后才传 true",
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
      const result = await execa(
        localToolchainCommand?.file || file,
        localToolchainCommand?.args
          ? [...localToolchainCommand.args, ...args]
          : args,
        {
          cwd: process.cwd(),
          reject: false,
          timeout: COMMAND_TIMEOUT_MS,
        },
      );
      if (result.failed && result.code === "ENOENT") {
        throw new Error(`命令不存在或不可执行: ${file}`);
      }
      return JSON.stringify(
        {
          command: input.command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        },
        null,
        2,
      );
    },
  }),
];
