import path from "node:path";
import { execa } from "execa";
import { z } from "zod";
import type { ToolDefinition } from "../types/agent.js";
import { isPathOutsideWorkspace, normalizeFilePath } from "../utils/path.js";
import { createTool } from "./create-tool.js";

const GIT_TIMEOUT_MS = 30_000;
const MAX_LOG_ENTRIES = 50;
const MAX_DIFF_BYTES = 100_000;

type GitCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

function normalizeRepoPath(filePath: string): string {
  const normalized = normalizeFilePath(filePath).trim();
  if (!normalized) {
    throw new Error("路径不能为空");
  }
  if (path.isAbsolute(normalized) || isPathOutsideWorkspace(normalized)) {
    throw new Error(`Git 工具只允许操作工作区内路径: ${filePath}`);
  }
  if (normalized === ".") {
    throw new Error("为避免一次暂存整个工作区，请显式指定文件路径");
  }
  return normalized;
}

async function runGit(args: string[]): Promise<GitCommandResult> {
  const result = await execa("git", args, {
    cwd: process.cwd(),
    reject: false,
    timeout: GIT_TIMEOUT_MS,
  });

  if (result.failed && result.code === "ENOENT") {
    throw new Error("当前环境未安装 git 或 git 不可执行");
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 1,
  };
}

async function ensureGitRepo(): Promise<void> {
  const result = await runGit(["rev-parse", "--is-inside-work-tree"]);
  if (result.exitCode !== 0 || result.stdout.trim() !== "true") {
    throw new Error("当前工作区不是 Git 仓库，无法使用 git 工具");
  }
}

function ensureSuccess(result: GitCommandResult, commandLabel: string): void {
  if (result.exitCode === 0) {
    return;
  }

  const detail = (result.stderr || result.stdout || "未知错误").trim();
  throw new Error(`${commandLabel} 执行失败: ${detail}`);
}

export const gitTools: ToolDefinition[] = [
  createTool({
    name: "git_status",
    description: "查看当前 Git 仓库状态，包括分支、暂存区和未跟踪文件",
    schema: z.object({}),
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      await ensureGitRepo();
      const status = await runGit(["status", "--short", "--branch"]);
      ensureSuccess(status, "git status");
      return status.stdout || "工作区干净，没有待处理改动。";
    },
  }),
  createTool({
    name: "git_diff",
    description: "查看 Git diff，可选择暂存区或指定文件",
    schema: z.object({
      staged: z.boolean().optional(),
      path: z.string().min(1).optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        staged: { type: "boolean", description: "是否查看暂存区 diff" },
        path: { type: "string", description: "限制到单个工作区内文件路径" },
      },
      additionalProperties: false,
    },
    async execute(input) {
      await ensureGitRepo();
      const args = ["diff"];
      if (input.staged) {
        args.push("--cached");
      }
      if (input.path) {
        args.push("--", normalizeRepoPath(input.path));
      }
      const diff = await runGit(args);
      ensureSuccess(diff, "git diff");
      if (!diff.stdout.trim()) {
        return input.staged ? "暂存区没有差异。" : "当前没有未暂存差异。";
      }
      return diff.stdout.slice(0, MAX_DIFF_BYTES);
    },
  }),
  createTool({
    name: "git_log",
    description: "查看最近的 Git 提交记录",
    schema: z.object({
      limit: z.number().int().min(1).max(MAX_LOG_ENTRIES).optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LOG_ENTRIES,
          description: "返回多少条最近提交",
        },
      },
      additionalProperties: false,
    },
    async execute(input) {
      await ensureGitRepo();
      const limit = input.limit || 10;
      const log = await runGit([
        "log",
        `--max-count=${limit}`,
        "--pretty=format:%h %ad %s",
        "--date=short",
      ]);
      ensureSuccess(log, "git log");
      return log.stdout || "当前仓库还没有提交记录。";
    },
  }),
  createTool({
    name: "git_add",
    description: "将显式指定的工作区内文件加入 Git 暂存区",
    schema: z.object({
      paths: z.array(z.string().min(1)).min(1, "至少提供一个文件路径"),
    }),
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "要暂存的工作区内文件路径列表",
        },
      },
      required: ["paths"],
      additionalProperties: false,
    },
    async execute(input) {
      await ensureGitRepo();
      const paths = input.paths.map(normalizeRepoPath);
      const add = await runGit(["add", "--", ...paths]);
      ensureSuccess(add, "git add");
      return `已加入暂存区: ${paths.join(", ")}`;
    },
  }),
  createTool({
    name: "git_commit",
    description: "提交当前已暂存的 Git 改动",
    schema: z.object({
      message: z
        .string()
        .min(1, "提交信息不能为空")
        .max(200, "提交信息过长，请控制在 200 字内"),
    }),
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Git commit message，只提交当前已暂存内容",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
    async execute(input) {
      await ensureGitRepo();
      const status = await runGit(["diff", "--cached", "--name-only"]);
      ensureSuccess(status, "git diff --cached --name-only");
      if (!status.stdout.trim()) {
        throw new Error("当前没有已暂存的改动，无法提交");
      }

      const commit = await runGit(["commit", "-m", input.message]);
      ensureSuccess(commit, "git commit");
      return commit.stdout || "提交完成。";
    },
  }),
];
