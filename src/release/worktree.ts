import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { AgentOrchestrator } from "../agent/orchestrator.js";
import type { AgentRunResult, ApprovalRequest } from "../types/agent.js";
import { getWorkspaceRoot, setWorkspaceRoot } from "../utils/runtime.js";

export type SandboxRunResult = AgentRunResult & {
  sandboxPath: string;
  kept: boolean;
  sandboxDiff: string;
  patchPath?: string;
  mergeHint: string;
};

async function runGit(args: string[], cwd: string) {
  const result = await execa("git", args, { cwd, reject: false });
  if ((result.exitCode ?? 1) !== 0) {
    throw new Error(
      result.stderr || result.stdout || `git ${args.join(" ")} 执行失败`,
    );
  }
  return result.stdout;
}

export async function runTaskInWorktreeSandbox(
  task: string,
  options?: {
    keep?: boolean;
    onConfirmCommand?: (request: ApprovalRequest) => Promise<boolean>;
  },
): Promise<SandboxRunResult> {
  const originalWorkspace = getWorkspaceRoot();
  await runGit(["rev-parse", "--is-inside-work-tree"], originalWorkspace);
  const sandboxParent = await mkdtemp(
    path.join(os.tmpdir(), "mini-claude-code-worktree-"),
  );
  const sandboxPath = path.join(sandboxParent, "workspace");

  try {
    await runGit(
      ["worktree", "add", "--detach", sandboxPath, "HEAD"],
      originalWorkspace,
    );
    setWorkspaceRoot(sandboxPath);
    const agent = new AgentOrchestrator({
      onConfirmCommand: options?.onConfirmCommand,
    });
    const result = await agent.run(task);
    const sandboxDiffResult = await execa("git", ["diff", "--stat"], {
      cwd: sandboxPath,
      reject: false,
    });
    const patchResult = await execa("git", ["diff", "--binary"], {
      cwd: sandboxPath,
      reject: false,
    });
    const sandboxDiff =
      sandboxDiffResult.stdout.trim() || "sandbox 没有文件差异。";
    const patchPath = patchResult.stdout.trim()
      ? path.join(sandboxParent, "sandbox.patch")
      : undefined;
    if (patchPath) {
      await writeFile(patchPath, patchResult.stdout, "utf8");
    }
    const mergeHint = patchPath
      ? `可用 git apply ${patchPath} 将 sandbox 改动应用回主工作区；建议先检查 patch 内容。`
      : options?.keep
        ? `可在 ${sandboxPath} 检查结果；当前没有可应用 patch。`
        : "sandbox 已清理，且没有生成 patch。";
    return {
      ...result,
      sandboxPath,
      kept: Boolean(options?.keep),
      sandboxDiff,
      patchPath,
      mergeHint,
    };
  } finally {
    setWorkspaceRoot(originalWorkspace);
    if (!options?.keep) {
      await execa("git", ["worktree", "remove", "--force", sandboxPath], {
        cwd: originalWorkspace,
        reject: false,
      });
      await rm(sandboxParent, { recursive: true, force: true });
    }
  }
}
