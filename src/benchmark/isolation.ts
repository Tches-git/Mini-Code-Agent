import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getWorkspaceRoot } from "../utils/runtime.js";
import type { BenchmarkTask } from "./tasks.js";

const DEFAULT_EXCLUDES = [
  ".git",
  "dist",
  ".backup",
  ".imports",
  ".local-code-agent",
];

type BenchmarkIsolationMode = "in_place" | "temp_copy";

export type BenchmarkIsolationConfig = {
  mode: BenchmarkIsolationMode;
  baseTempDir?: string;
  cleanup?: boolean;
};

export type BenchmarkIsolationContext = {
  mode: BenchmarkIsolationMode;
  workspacePath: string;
  cleanup: () => Promise<void>;
};

function shouldIsolate(task: BenchmarkTask): boolean {
  return task.category !== "read";
}

async function injectTaskBaseline(
  task: BenchmarkTask,
  workspacePath: string,
): Promise<void> {
  if (task.id === "fix-readme-command") {
    const readmePath = path.join(workspacePath, "README.md");
    const content = await readFile(readmePath, "utf8");
    const nextContent = content.includes(
      "npm run chat -- --resume-session <session-id>",
    )
      ? content.replace(
          "npm run chat -- --resume-session <session-id>",
          "npm run chat -- --resume <session-id>",
        )
      : `${content.trimEnd()}\n\nbench-invalid-resume-command\n\`\`\`bash\nnpm run chat -- --resume <session-id>\n\`\`\`\n`;
    if (nextContent !== content) {
      await writeFile(readmePath, nextContent, "utf8");
    }
    return;
  }

  if (task.id === "fix-ts-type-error") {
    const targetPath = path.join(workspacePath, "src/types/agent.ts");
    const content = await readFile(targetPath, "utf8");
    const nextContent = `${content.trimEnd()}\n\n// __BENCHMARK_TS_ERROR__\nexport const __BENCHMARK_TS_ERROR__: number = "broken";\n`;
    if (nextContent !== content) {
      await writeFile(targetPath, nextContent, "utf8");
    }
    return;
  }

  if (task.id === "rename-local-symbol") {
    const targetPath = path.join(workspacePath, "src/agent/summary.ts");
    const content = await readFile(targetPath, "utf8");
    if (content.includes("MAX_FOCUS_KEYWORDS")) {
      const nextContent = content
        .replace(
          "const MAX_FOCUS_KEYWORDS = 24;",
          "const MAX_FOCUS_KEYWORD_LIMIT = 24;",
        )
        .replaceAll("MAX_FOCUS_KEYWORDS", "MAX_FOCUS_KEYWORD_LIMIT");
      if (nextContent !== content) {
        await writeFile(targetPath, nextContent, "utf8");
      }
    }
    return;
  }

  if (task.id === "fix-interactive-resume-regression") {
    const targetPath = path.join(workspacePath, "src/cli/interactive.ts");
    const content = await readFile(targetPath, "utf8");
    const nextContent = content.replace(
      'if (slashCommand === "/resume") {',
      'if (slashCommand === "/resume-session") {',
    );
    if (nextContent !== content) {
      await writeFile(targetPath, nextContent, "utf8");
    }
    return;
  }

  if (task.id === "fix-failing-token-test") {
    const targetPath = path.join(workspacePath, "src/utils/token.ts");
    const content = await readFile(targetPath, "utf8");
    const nextContent = content.replace(
      /const ENGLISH_CHAR_WEIGHT = [^;]+;/,
      "const ENGLISH_CHAR_WEIGHT = 0.6;",
    );
    if (nextContent !== content) {
      await writeFile(targetPath, nextContent, "utf8");
    }
    return;
  }

  if (task.id === "fix-approval-policy-regression") {
    const targetPath = path.join(workspacePath, "src/tools/command.ts");
    const content = await readFile(targetPath, "utf8");
    const nextContent = content.replace(
      '  "typecheck",\n]);',
      '  "typecheck",\n  "chat",\n]);',
    );
    if (nextContent !== content) {
      await writeFile(targetPath, nextContent, "utf8");
    }
  }
}

async function createTempWorkspaceCopy(options?: {
  sourcePath?: string;
  baseTempDir?: string;
}): Promise<string> {
  const sourcePath = options?.sourcePath || getWorkspaceRoot();
  const parentDir =
    options?.baseTempDir ||
    path.join(os.tmpdir(), "local-code-agent-benchmark-");
  const targetDir = await mkdtemp(parentDir);

  await mkdir(targetDir, { recursive: true });
  await cp(sourcePath, targetDir, {
    recursive: true,
    filter: (entryPath) => {
      const relativePath = path.relative(sourcePath, entryPath);
      if (!relativePath) return true;
      const topLevel = relativePath.split(path.sep)[0] || relativePath;
      return !DEFAULT_EXCLUDES.includes(topLevel);
    },
  });

  return targetDir;
}

export async function prepareBenchmarkIsolation(
  task: BenchmarkTask,
  options?: BenchmarkIsolationConfig,
): Promise<BenchmarkIsolationContext> {
  const mode = options?.mode || "in_place";
  const cleanupEnabled = options?.cleanup ?? true;

  if (mode === "temp_copy" && shouldIsolate(task)) {
    const workspacePath = await createTempWorkspaceCopy({
      sourcePath: getWorkspaceRoot(),
      baseTempDir: options?.baseTempDir,
    });
    await injectTaskBaseline(task, workspacePath);
    return {
      mode,
      workspacePath,
      cleanup: async () => {
        if (!cleanupEnabled) return;
        await rm(workspacePath, { recursive: true, force: true });
      },
    };
  }

  return {
    mode: "in_place",
    workspacePath: getWorkspaceRoot(),
    cleanup: async () => {},
  };
}
