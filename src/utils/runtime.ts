import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

function getEnvWithLegacy(
  name: string,
  legacyName: string,
): string | undefined {
  return process.env[name]?.trim() || process.env[legacyName]?.trim();
}

function normalizePathSegment(value: string): string {
  return (
    value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "workspace"
  );
}

export function getWorkspaceRoot(): string {
  const configured = getEnvWithLegacy(
    "LOCAL_CODE_AGENT_WORKSPACE_ROOT",
    "MINI_CLAUDE_CODE_WORKSPACE_ROOT",
  );
  return configured ? path.resolve(configured) : process.cwd();
}

export function setWorkspaceRoot(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  process.env.LOCAL_CODE_AGENT_WORKSPACE_ROOT = resolved;
  process.env.MINI_CLAUDE_CODE_WORKSPACE_ROOT = resolved;
  return resolved;
}

export function getAppDataDir(): string {
  const configured = getEnvWithLegacy(
    "LOCAL_CODE_AGENT_HOME",
    "MINI_CLAUDE_CODE_HOME",
  );
  return configured
    ? path.resolve(configured)
    : path.join(os.homedir(), ".local-code-agent");
}

export function getWorkspaceStateDir(): string {
  const override = getEnvWithLegacy(
    "LOCAL_CODE_AGENT_STATE_DIR",
    "MINI_CLAUDE_CODE_STATE_DIR",
  );
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
