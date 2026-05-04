import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setWorkspaceRoot } from "../utils/runtime.js";
import { captureUndoSnapshots, restoreUndoSnapshots } from "./undo.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "undo-test-"));
  setWorkspaceRoot(workspace);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("undo snapshots", () => {
  it("restores existing file content", async () => {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "src/a.ts"), "before", "utf8");
    const snapshots = await captureUndoSnapshots(["src/a.ts"]);
    await writeFile(path.join(workspace, "src/a.ts"), "after", "utf8");

    const diffs = await restoreUndoSnapshots(snapshots);

    expect(await readFile(path.join(workspace, "src/a.ts"), "utf8")).toBe(
      "before",
    );
    expect(diffs[0]?.summary).toBe("撤销修改");
  });

  it("removes files created after snapshot", async () => {
    const snapshots = await captureUndoSnapshots(["created.txt"]);
    await writeFile(path.join(workspace, "created.txt"), "new", "utf8");

    await restoreUndoSnapshots(snapshots);

    await expect(stat(path.join(workspace, "created.txt"))).rejects.toThrow();
  });
});
