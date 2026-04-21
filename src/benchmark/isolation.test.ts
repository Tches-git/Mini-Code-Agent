import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { setWorkspaceRoot } from "../utils/runtime.js";
import { prepareBenchmarkIsolation } from "./isolation.js";
import type { BenchmarkTask } from "./tasks.js";

function makeTask(
  category: BenchmarkTask["category"],
  enabled = true,
): BenchmarkTask {
  return {
    id: `${category}-task`,
    title: `${category} task`,
    category,
    prompt: "test prompt",
    description: "test description",
    enabled,
    expectation: {},
  };
}

describe("prepareBenchmarkIsolation", () => {
  beforeEach(() => {
    setWorkspaceRoot(process.cwd());
  });

  it("keeps read task in place by default", async () => {
    const task = makeTask("read");
    const isolation = await prepareBenchmarkIsolation(task, {
      mode: "temp_copy",
    });

    expect(isolation.mode).toBe("in_place");
    expect(isolation.workspacePath).toBe(process.cwd());
    await isolation.cleanup();
  });

  it("creates temp copy for edit task", async () => {
    const task = makeTask("edit");
    const isolation = await prepareBenchmarkIsolation(task, {
      mode: "temp_copy",
    });

    expect(isolation.mode).toBe("temp_copy");
    expect(isolation.workspacePath).not.toBe(process.cwd());
    await isolation.cleanup();
  });

  it("uses in_place mode when configured", async () => {
    const task = makeTask("auto_fix");
    const isolation = await prepareBenchmarkIsolation(task, {
      mode: "in_place",
    });

    expect(isolation.mode).toBe("in_place");
    expect(isolation.workspacePath).toBe(process.cwd());
    await isolation.cleanup();
  });

  it("injects broken README command baseline for fix-readme-command", async () => {
    const task: BenchmarkTask = {
      id: "fix-readme-command",
      title: "fix readme",
      category: "edit",
      prompt: "",
      description: "",
      enabled: true,
      expectation: {},
    };

    const isolation = await prepareBenchmarkIsolation(task, {
      mode: "temp_copy",
    });
    const content = await readFile(
      path.join(isolation.workspacePath, "README.md"),
      "utf8",
    );

    expect(content).toContain("npm run chat -- --resume <session-id>");
    expect(content).not.toContain(
      "npm run chat -- --resume-session <session-id>",
    );
    await isolation.cleanup();
  });

  it("injects stable TypeScript error baseline for fix-ts-type-error", async () => {
    const task: BenchmarkTask = {
      id: "fix-ts-type-error",
      title: "fix ts type error",
      category: "auto_fix",
      prompt: "",
      description: "",
      enabled: true,
      expectation: {},
    };

    const isolation = await prepareBenchmarkIsolation(task, {
      mode: "temp_copy",
    });
    const content = await readFile(
      path.join(isolation.workspacePath, "src/types/agent.ts"),
      "utf8",
    );

    expect(content).toContain("__BENCHMARK_TS_ERROR__");
    expect(content).toContain(
      'export const __BENCHMARK_TS_ERROR__: number = "broken";',
    );
    await isolation.cleanup();
  });

  it("injects local rename baseline for rename-local-symbol", async () => {
    const task: BenchmarkTask = {
      id: "rename-local-symbol",
      title: "rename local symbol",
      category: "edit",
      prompt: "",
      description: "",
      enabled: true,
      expectation: {},
    };

    const isolation = await prepareBenchmarkIsolation(task, {
      mode: "temp_copy",
    });
    const content = await readFile(
      path.join(isolation.workspacePath, "src/agent/summary.ts"),
      "utf8",
    );

    expect(content).toContain("MAX_FOCUS_KEYWORD_LIMIT");
    expect(content).not.toContain("MAX_FOCUS_KEYWORDS = 24");
    await isolation.cleanup();
  });

  it("injects interactive resume regression baseline", async () => {
    const task: BenchmarkTask = {
      id: "fix-interactive-resume-regression",
      title: "fix interactive resume regression",
      category: "validate",
      prompt: "",
      description: "",
      enabled: true,
      expectation: {},
    };

    const isolation = await prepareBenchmarkIsolation(task, {
      mode: "temp_copy",
    });
    const content = await readFile(
      path.join(isolation.workspacePath, "src/cli/interactive.ts"),
      "utf8",
    );

    expect(content).toContain('if (slashCommand === "/resume-session") {');
    expect(content).not.toContain('if (slashCommand === "/resume") {');
    await isolation.cleanup();
  });

  it("injects failing token test regression baseline", async () => {
    const task: BenchmarkTask = {
      id: "fix-failing-token-test",
      title: "fix failing token test",
      category: "validate",
      prompt: "",
      description: "",
      enabled: true,
      expectation: {},
    };

    const isolation = await prepareBenchmarkIsolation(task, {
      mode: "temp_copy",
    });
    const content = await readFile(
      path.join(isolation.workspacePath, "src/utils/token.ts"),
      "utf8",
    );

    expect(content).toContain("const ENGLISH_CHAR_WEIGHT = 0.6;");
    expect(content).not.toContain("const ENGLISH_CHAR_WEIGHT = 3 / 10;");
    await isolation.cleanup();
  });

  it("injects approval policy regression baseline", async () => {
    const task: BenchmarkTask = {
      id: "fix-approval-policy-regression",
      title: "fix approval policy regression",
      category: "validate",
      prompt: "",
      description: "",
      enabled: true,
      expectation: {},
    };

    const isolation = await prepareBenchmarkIsolation(task, {
      mode: "temp_copy",
    });
    const content = await readFile(
      path.join(isolation.workspacePath, "src/tools/command.ts"),
      "utf8",
    );

    expect(content).toContain('  "chat",');
    await isolation.cleanup();
  });
});
