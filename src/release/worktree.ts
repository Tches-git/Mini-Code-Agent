import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { AgentOrchestrator } from "../agent/orchestrator.js";
import type {
  AgentRunResult,
  ApprovalRequest,
  ApprovalResponse,
} from "../types/agent.js";
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

export type SandboxPatchHunk = {
  index: number;
  path: string;
  header: string;
  preview: string;
};

export type SandboxPatchApplyResult = {
  patchPath: string;
  checkOnly: boolean;
  applied: boolean;
  stdout: string;
  stderr: string;
  dirtyFiles: string[];
  patchSummary: string;
  selectedPaths: string[];
  selectedHunks: number[];
};

export type SandboxBranchResult = {
  branchName: string;
  sandboxPath: string;
  patchPath: string;
  patchSummary: string;
};

export type SandboxPullRequestDraft = {
  title: string;
  body: string;
  patchSummary: string;
};

async function getDirtyFiles(cwd: string): Promise<string[]> {
  const result = await execa("git", ["status", "--porcelain"], {
    cwd,
    reject: false,
  });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3));
}

async function getPatchSummary(
  patchPath: string,
  cwd: string,
  selectedPaths: string[] = [],
): Promise<string> {
  const result = await execa(
    "git",
    [
      "apply",
      "--stat",
      ...selectedPaths.map((item) => `--include=${item}`),
      patchPath,
    ],
    {
      cwd,
      reject: false,
    },
  );
  return result.stdout.trim() || "patch 没有可显示摘要。";
}

function normalizePatchPaths(paths: string[] = []): string[] {
  return Array.from(
    new Set(
      paths
        .map((item) => item.trim().replace(/\\/g, "/"))
        .filter(Boolean)
        .filter((item) => !path.isAbsolute(item) && !item.startsWith("..")),
    ),
  );
}

function parsePatchPaths(patchContent: string): string[] {
  return Array.from(
    new Set(
      Array.from(patchContent.matchAll(/^diff --git a\/(.*?) b\//gm))
        .map((match) => match[1]?.trim())
        .filter((item): item is string => Boolean(item)),
    ),
  );
}

export function parsePatchHunks(patchContent: string): SandboxPatchHunk[] {
  const hunks: SandboxPatchHunk[] = [];
  const lines = patchContent.split("\n");
  let currentPath = "";
  for (let index = 0; index < lines.length; index++) {
    const diffMatch = /^diff --git a\/(.*?) b\//.exec(lines[index] || "");
    if (diffMatch?.[1]) currentPath = diffMatch[1];
    if (!lines[index]?.startsWith("@@ ")) continue;
    hunks.push({
      index: hunks.length + 1,
      path: currentPath,
      header: lines[index],
      preview: lines
        .slice(index, index + 8)
        .filter(Boolean)
        .join("\n"),
    });
  }
  return hunks;
}

function normalizeHunks(hunks: number[] = []): number[] {
  return Array.from(
    new Set(hunks.filter((item) => Number.isInteger(item) && item > 0)),
  ).sort((a, b) => a - b);
}

function filterPatchHunks(
  patchContent: string,
  selectedHunks: number[],
): string {
  if (selectedHunks.length === 0) return patchContent;
  const selected = new Set(selectedHunks);
  const lines = patchContent.split("\n");
  const output: string[] = [];
  let fileHeader: string[] = [];
  let hunk: string[] = [];
  let hunkIndex = 0;
  let includeCurrentFile = false;

  const flushHunk = () => {
    if (hunk.length === 0) return;
    hunkIndex += 1;
    if (selected.has(hunkIndex)) {
      if (!includeCurrentFile) {
        output.push(...fileHeader);
        includeCurrentFile = true;
      }
      output.push(...hunk);
    }
    hunk = [];
  };

  const flushFile = () => {
    flushHunk();
    fileHeader = [];
    includeCurrentFile = false;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushFile();
      fileHeader = [line];
    } else if (line.startsWith("@@ ")) {
      flushHunk();
      hunk = [line];
    } else if (hunk.length > 0) {
      hunk.push(line);
    } else if (fileHeader.length > 0) {
      fileHeader.push(line);
    } else {
      output.push(line);
    }
  }
  flushFile();
  return `${output.join("\n").trimEnd()}\n`;
}

async function createSelectedHunkPatch(
  patchPath: string,
  selectedHunks: number[],
): Promise<string> {
  if (selectedHunks.length === 0) return patchPath;
  const patchContent = await readFile(patchPath, "utf8");
  const filteredPatch = filterPatchHunks(patchContent, selectedHunks);
  const selectedPatchPath = path.join(
    os.tmpdir(),
    `sandbox-hunks-${Date.now()}-${process.pid}.patch`,
  );
  await writeFile(selectedPatchPath, filteredPatch, "utf8");
  return selectedPatchPath;
}

function formatPrTitle(paths: string[]): string {
  if (paths.length === 0) return "Apply sandbox patch";
  if (paths.length === 1) return `Apply sandbox patch for ${paths[0]}`;
  return `Apply sandbox patch for ${paths[0]} and ${paths.length - 1} more`;
}

export async function listSandboxPatchHunks(
  patchPath: string,
): Promise<SandboxPatchHunk[]> {
  return parsePatchHunks(await readFile(patchPath, "utf8"));
}

export async function createSandboxPullRequestDraft(options: {
  patchPath: string;
  cwd?: string;
}): Promise<SandboxPullRequestDraft> {
  const cwd = options.cwd || getWorkspaceRoot();
  const patchContent = await readFile(options.patchPath, "utf8");
  const paths = parsePatchPaths(patchContent);
  const patchSummary = await getPatchSummary(options.patchPath, cwd);
  return {
    title: formatPrTitle(paths),
    patchSummary,
    body: [
      "## Summary",
      "",
      "Apply the sandbox-generated patch after review.",
      "",
      "## Changed files",
      paths.length
        ? paths.map((item) => `- ${item}`).join("\n")
        : "- None detected",
      "",
      "## Patch summary",
      "```text",
      patchSummary,
      "```",
      "",
      "## Validation",
      "- [ ] Run focused tests",
      "- [ ] Run build or release checks as needed",
    ].join("\n"),
  };
}

export async function applySandboxPatch(options: {
  patchPath: string;
  cwd?: string;
  check?: boolean;
  allowDirty?: boolean;
  paths?: string[];
  hunks?: number[];
}): Promise<SandboxPatchApplyResult> {
  const cwd = options.cwd || getWorkspaceRoot();
  const selectedPaths = normalizePatchPaths(options.paths);
  const selectedHunks = normalizeHunks(options.hunks);
  const dirtyFiles = await getDirtyFiles(cwd);
  if (dirtyFiles.length > 0 && !options.allowDirty) {
    throw new Error(
      `目标工作区存在未提交改动，拒绝应用 sandbox patch: ${dirtyFiles.join(", ")}`,
    );
  }
  const patchToApply = await createSelectedHunkPatch(
    options.patchPath,
    selectedHunks,
  );
  try {
    const patchSummary = await getPatchSummary(
      patchToApply,
      cwd,
      selectedPaths,
    );
    const args = [
      "apply",
      ...(options.check ? ["--check"] : []),
      ...selectedPaths.map((item) => `--include=${item}`),
      patchToApply,
    ];
    const result = await execa("git", args, { cwd, reject: false });
    if ((result.exitCode ?? 1) !== 0) {
      throw new Error(
        [
          result.stderr || result.stdout || "git apply 执行失败",
          "sandbox patch 已保留，可先用 sandbox:branch 创建隔离 worktree 分步解决冲突，或用 sandbox:apply --path <file> / --hunk <n> 缩小应用范围后重试。",
        ].join("\n"),
      );
    }
    return {
      patchPath: options.patchPath,
      checkOnly: Boolean(options.check),
      applied: !options.check,
      stdout: result.stdout,
      stderr: result.stderr,
      dirtyFiles,
      patchSummary,
      selectedPaths,
      selectedHunks,
    };
  } finally {
    if (patchToApply !== options.patchPath) {
      await rm(patchToApply, { force: true });
    }
  }
}

export async function createSandboxBranch(options: {
  patchPath: string;
  branchName: string;
  sandboxPath?: string;
  cwd?: string;
}): Promise<SandboxBranchResult> {
  const cwd = options.cwd || getWorkspaceRoot();
  const branchName = options.branchName.trim();
  if (!/^[A-Za-z0-9._/-]+$/.test(branchName)) {
    throw new Error(`无效分支名: ${options.branchName}`);
  }
  const sandboxPath =
    options.sandboxPath ||
    (await mkdtemp(path.join(os.tmpdir(), "local-code-agent-branch-")));
  await runGit(["worktree", "add", "-b", branchName, sandboxPath, "HEAD"], cwd);
  const patchSummary = await getPatchSummary(options.patchPath, sandboxPath);
  await applySandboxPatch({
    patchPath: options.patchPath,
    cwd: sandboxPath,
    allowDirty: true,
  });
  return {
    branchName,
    sandboxPath,
    patchPath: options.patchPath,
    patchSummary,
  };
}

export async function runTaskInWorktreeSandbox(
  task: string,
  options?: {
    keep?: boolean;
    onConfirmCommand?: (request: ApprovalRequest) => Promise<ApprovalResponse>;
  },
): Promise<SandboxRunResult> {
  const originalWorkspace = getWorkspaceRoot();
  await runGit(["rev-parse", "--is-inside-work-tree"], originalWorkspace);
  const sandboxParent = await mkdtemp(
    path.join(os.tmpdir(), "local-code-agent-worktree-"),
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
      ? `可用 sandbox:apply --check ${patchPath} 预检，再用 sandbox:apply ${patchPath} 应用；需要分步处理时可用 --path <file> 或 sandbox:branch ${patchPath} <branch>。`
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
