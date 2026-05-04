import { mkdtemp, rm } from "node:fs/promises";
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
    const sandboxDiff =
      sandboxDiffResult.stdout.trim() || "sandbox 没有文件差异。";
    const mergeHint = options?.keep
      ? `可在 ${sandboxPath} 检查改动；确认后用 git diff/apply 或手动合并回主工作区。`
      : "sandbox 已清理；如需检查和合并，请下次加 --keep-sandbox。";
    return {
      ...result,
      sandboxPath,
      kept: Boolean(options?.keep),
      sandboxDiff,
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
