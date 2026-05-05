import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySandboxPatch } from "./worktree.js";

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
  it("checks and applies a patch", async () => {
    await writeFile(path.join(tempDir, "a.txt"), "after\n", "utf8");
    const patch = await execa("git", ["diff", "--binary"], { cwd: tempDir });
    await execa("git", ["checkout", "--", "a.txt"], { cwd: tempDir });
    const patchPath = path.join(tempDir, "change.patch");
    await writeFile(patchPath, `${patch.stdout}\n`, "utf8");

    const check = await applySandboxPatch({
      patchPath,
      cwd: tempDir,
      check: true,
    });
    expect(check.applied).toBe(false);
    expect(check.checkOnly).toBe(true);

    const applied = await applySandboxPatch({ patchPath, cwd: tempDir });
    expect(applied.applied).toBe(true);
    await expect(readFile(path.join(tempDir, "a.txt"), "utf8")).resolves.toBe(
      "after\n",
    );
  });
});
