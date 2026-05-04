import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

function normalizePathSegment(value: string): string {
  return (
    value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "workspace"
  );
}

export function getWorkspaceRoot(): string {
  const configured = process.env.MINI_CLAUDE_CODE_WORKSPACE_ROOT?.trim();
  return configured ? path.resolve(configured) : process.cwd();
}

export function setWorkspaceRoot(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  process.env.MINI_CLAUDE_CODE_WORKSPACE_ROOT = resolved;
  return resolved;
}

export function getAppDataDir(): string {
  const configured = process.env.MINI_CLAUDE_CODE_HOME?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(os.homedir(), ".mini-claude-code");
}

export function getWorkspaceStateDir(): string {
  const override = process.env.MINI_CLAUDE_CODE_STATE_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }

  const workspaceRoot = getWorkspaceRoot();
  const hash = createHash("sha1")
    .update(workspaceRoot)
    .digest("hex")
    .slice(0, 12);
  const name = normalizePathSegment(path.basename(workspaceRoot));
  return path.join(getAppDataDir(), "workspaces", `${name}-${hash}`);
}
