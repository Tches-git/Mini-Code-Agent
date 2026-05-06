import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySandboxPatch,
  createSandboxBranch,
  createSandboxPullRequestDraft,
  listSandboxPatchHunks,
} from "./worktree.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "sandbox-apply-test-"));
  await execa("git", ["init"], { cwd: tempDir });
  await execa("git", ["config", "user.email", "test@example.com"], {
    cwd: tempDir,
  });
  await execa("git", ["config", "user.name", "Test"], { cwd: tempDir });
  await writeFile(path.join(tempDir, "a.txt"), "before\n", "utf8");
  await execa("git", ["add", "a.txt"], { cwd: tempDir });
  await execa("git", ["commit", "-m", "init"], { cwd: tempDir });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("applySandboxPatch", () => {
  it("rejects applying a patch when target worktree is dirty", async () => {
    await writeFile(path.join(tempDir, "a.txt"), "after\n", "utf8");
    const patch = await execa("git", ["diff", "--binary"], { cwd: tempDir });
    await execa("git", ["checkout", "--", "a.txt"], { cwd: tempDir });
    const patchPath = path.join(os.tmpdir(), `dirty-${Date.now()}.patch`);
    await writeFile(patchPath, `${patch.stdout}\n`, "utf8");
    await writeFile(path.join(tempDir, "dirty.txt"), "dirty\n", "utf8");

    await expect(
      applySandboxPatch({ patchPath, cwd: tempDir }),
    ).rejects.toThrow("存在未提交改动");
    await rm(patchPath, { force: true });
  });

  it("checks and applies a patch", async () => {
    await writeFile(path.join(tempDir, "a.txt"), "after\n", "utf8");
    const patch = await execa("git", ["diff", "--binary"], { cwd: tempDir });
    await execa("git", ["checkout", "--", "a.txt"], { cwd: tempDir });
    const patchPath = path.join(os.tmpdir(), `change-${Date.now()}.patch`);
    await writeFile(patchPath, `${patch.stdout}\n`, "utf8");

    const check = await applySandboxPatch({
      patchPath,
      cwd: tempDir,
      check: true,
    });
    expect(check.applied).toBe(false);
    expect(check.checkOnly).toBe(true);
    expect(check.patchSummary).toContain("a.txt");

    const applied = await applySandboxPatch({ patchPath, cwd: tempDir });
    expect(applied.applied).toBe(true);
    await expect(readFile(path.join(tempDir, "a.txt"), "utf8")).resolves.toBe(
      "after\n",
    );
    await rm(patchPath, { force: true });
  });

  it("generates a PR draft from patch summary", async () => {
    await writeFile(path.join(tempDir, "a.txt"), "draft-after\n", "utf8");
    const patch = await execa("git", ["diff", "--binary"], { cwd: tempDir });
    await execa("git", ["checkout", "--", "a.txt"], { cwd: tempDir });
    const patchPath = path.join(os.tmpdir(), `draft-${Date.now()}.patch`);
    await writeFile(patchPath, `${patch.stdout}\n`, "utf8");

    const draft = await createSandboxPullRequestDraft({
      patchPath,
      cwd: tempDir,
    });

    expect(draft.title).toContain("a.txt");
    expect(draft.patchSummary).toContain("a.txt");
    expect(draft.body).toContain("## Changed files");
    expect(draft.body).toContain("- a.txt");
    await rm(patchPath, { force: true });
  });

  it("creates a sandbox branch worktree from patch", async () => {
    await writeFile(path.join(tempDir, "a.txt"), "branch-after\n", "utf8");
    const patch = await execa("git", ["diff", "--binary"], { cwd: tempDir });
    await execa("git", ["checkout", "--", "a.txt"], { cwd: tempDir });
    const patchPath = path.join(os.tmpdir(), `branch-${Date.now()}.patch`);
    const sandboxPath = path.join(os.tmpdir(), `branch-worktree-${Date.now()}`);
    await writeFile(patchPath, `${patch.stdout}\n`, "utf8");

    const result = await createSandboxBranch({
      patchPath,
      branchName: `sandbox-test-${Date.now()}`,
      sandboxPath,
      cwd: tempDir,
    });

    expect(result.patchSummary).toContain("a.txt");
    await expect(
      readFile(path.join(sandboxPath, "a.txt"), "utf8"),
    ).resolves.toBe("branch-after\n");
    await expect(readFile(path.join(tempDir, "a.txt"), "utf8")).resolves.toBe(
      "before\n",
    );
    await execa("git", ["worktree", "remove", "--force", sandboxPath], {
      cwd: tempDir,
      reject: false,
    });
    await rm(patchPath, { force: true });
  });

  it("applies only selected patch hunks", async () => {
    await writeFile(path.join(tempDir, "a.txt"), "one\nmid\ntwo\n", "utf8");
    await execa("git", ["add", "a.txt"], { cwd: tempDir });
    await execa("git", ["commit", "-m", "two hunks base"], { cwd: tempDir });
    await writeFile(path.join(tempDir, "a.txt"), "ONE\nmid\nTWO\n", "utf8");
    const patch = await execa("git", ["diff", "--binary", "--unified=0"], {
      cwd: tempDir,
    });
    await execa("git", ["checkout", "--", "a.txt"], { cwd: tempDir });
    const patchPath = path.join(os.tmpdir(), `hunks-${Date.now()}.patch`);
    await writeFile(patchPath, `${patch.stdout}\n`, "utf8");

    const hunks = await listSandboxPatchHunks(patchPath);
    const applied = await applySandboxPatch({
      patchPath,
      cwd: tempDir,
      hunks: [2],
    });

    expect(hunks.map((hunk) => hunk.index)).toEqual([1, 2]);
    expect(hunks[0]?.path).toBe("a.txt");
    expect(applied.selectedHunks).toEqual([2]);
    await expect(readFile(path.join(tempDir, "a.txt"), "utf8")).resolves.toBe(
      "one\nmid\nTWO\n",
    );
    await rm(patchPath, { force: true });
  });

  it("applies only selected patch paths", async () => {
    await writeFile(path.join(tempDir, "a.txt"), "after\n", "utf8");
    await writeFile(path.join(tempDir, "b.txt"), "before-b\n", "utf8");
    await execa("git", ["add", "b.txt"], { cwd: tempDir });
    await execa("git", ["commit", "-m", "add b"], { cwd: tempDir });
    await writeFile(path.join(tempDir, "b.txt"), "after-b\n", "utf8");
    const patch = await execa("git", ["diff", "--binary"], { cwd: tempDir });
    await execa("git", ["checkout", "--", "a.txt", "b.txt"], { cwd: tempDir });
    const patchPath = path.join(os.tmpdir(), `select-${Date.now()}.patch`);
    await writeFile(patchPath, `${patch.stdout}\n`, "utf8");

    const applied = await applySandboxPatch({
      patchPath,
      cwd: tempDir,
      paths: ["a.txt"],
    });

    expect(applied.selectedPaths).toEqual(["a.txt"]);
    await expect(readFile(path.join(tempDir, "a.txt"), "utf8")).resolves.toBe(
      "after\n",
    );
    await expect(readFile(path.join(tempDir, "b.txt"), "utf8")).resolves.toBe(
      "before-b\n",
    );
    await rm(patchPath, { force: true });
  });
});
