import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExeca = vi.hoisted(() => vi.fn());

vi.mock("execa", () => ({
  execa: mockExeca,
}));

import { gitTools } from "./git.js";

function getTool(name: string) {
  const tool = gitTools.find((item) => item.name === name);
  if (!tool) {
    throw new Error(`tool not found: ${name}`);
  }
  return tool;
}

describe("gitTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("git_status returns formatted status output", async () => {
    mockExeca
      .mockResolvedValueOnce({
        failed: false,
        code: undefined,
        stdout: "true",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        failed: false,
        code: undefined,
        stdout: "## main\n M src/index.ts",
        stderr: "",
        exitCode: 0,
      });

    const result = await getTool("git_status").execute({});
    expect(result).toContain("## main");
    expect(mockExeca).toHaveBeenNthCalledWith(
      2,
      "git",
      ["status", "--short", "--branch"],
      expect.objectContaining({ cwd: process.cwd() }),
    );
  });

  it("git_diff returns empty-state message when no unstaged diff exists", async () => {
    mockExeca
      .mockResolvedValueOnce({
        failed: false,
        code: undefined,
        stdout: "true",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        failed: false,
        code: undefined,
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

    const result = await getTool("git_diff").execute({ path: "src/index.ts" });
    expect(result).toBe("当前没有未暂存差异。");
    expect(mockExeca).toHaveBeenNthCalledWith(
      2,
      "git",
      ["diff", "--", "src/index.ts"],
      expect.any(Object),
    );
  });

  it("git_add rejects staging the whole workspace", async () => {
    mockExeca.mockResolvedValueOnce({
      failed: false,
      code: undefined,
      stdout: "true",
      stderr: "",
      exitCode: 0,
    });

    await expect(getTool("git_add").execute({ paths: ["."] })).rejects.toThrow(
      "请显式指定文件路径",
    );
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it("git_commit rejects when nothing is staged", async () => {
    mockExeca
      .mockResolvedValueOnce({
        failed: false,
        code: undefined,
        stdout: "true",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        failed: false,
        code: undefined,
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

    await expect(
      getTool("git_commit").execute({ message: "test commit" }),
    ).rejects.toThrow("当前没有已暂存的改动");
  });

  it("git_commit commits staged changes", async () => {
    mockExeca
      .mockResolvedValueOnce({
        failed: false,
        code: undefined,
        stdout: "true",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        failed: false,
        code: undefined,
        stdout: "src/index.ts",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        failed: false,
        code: undefined,
        stdout: "[main abc123] test commit",
        stderr: "",
        exitCode: 0,
      });

    const result = await getTool("git_commit").execute({
      message: "test commit",
    });

    expect(result).toContain("test commit");
    expect(mockExeca).toHaveBeenNthCalledWith(
      3,
      "git",
      ["commit", "-m", "test commit"],
      expect.any(Object),
    );
  });
});
