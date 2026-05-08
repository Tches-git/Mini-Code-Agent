import { promises as fs } from "node:fs";
import path from "node:path";
import type { DiffEntry } from "../types/agent.js";
import { buildDiffPreview } from "../utils/diff.js";
import { getWorkspaceRoot } from "../utils/runtime.js";

export type UndoSnapshot = {
  path: string;
  existed: boolean;
  content: string;
};

function resolveUndoPath(filePath: string): string {
  const root = getWorkspaceRoot();
  const resolved = path.resolve(root, filePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`不能撤销工作区外路径: ${filePath}`);
  }
  return resolved;
}

export async function captureUndoSnapshots(
  paths: Iterable<string>,
): Promise<UndoSnapshot[]> {
  const snapshots: UndoSnapshot[] = [];
  const seen = new Set<string>();

  for (const filePath of paths) {
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    const resolved = resolveUndoPath(filePath);
    try {
      snapshots.push({
        path: filePath,
        existed: true,
        content: await fs.readFile(resolved, "utf8"),
      });
    } catch {
      snapshots.push({ path: filePath, existed: false, content: "" });
    }
  }

  return snapshots;
}

export type UndoSelection = {
  paths?: string[];
};

export async function restoreUndoSnapshots(
  snapshots: UndoSnapshot[],
  selection: UndoSelection = {},
): Promise<DiffEntry[]> {
  const diffs: DiffEntry[] = [];
  const selectedPaths = selection.paths?.length
    ? new Set(selection.paths.map((item) => item.replace(/\\/g, "/")))
    : null;

  for (const snapshot of snapshots) {
    if (
      selectedPaths &&
      !selectedPaths.has(snapshot.path.replace(/\\/g, "/"))
    ) {
      continue;
    }
    const resolved = resolveUndoPath(snapshot.path);
    let before = "";
    try {
      before = await fs.readFile(resolved, "utf8");
    } catch {}

    if (snapshot.existed) {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, snapshot.content, "utf8");
      diffs.push({
        path: snapshot.path,
        summary: "撤销修改",
        diff: buildDiffPreview(before, snapshot.content, snapshot.path),
      });
      continue;
    }

    await fs.unlink(resolved).catch(() => {});
    diffs.push({
      path: snapshot.path,
      summary: "撤销新建文件",
      diff: buildDiffPreview(before, "", snapshot.path),
    });
  }

  return diffs;
}
