import path from "node:path";
import { getWorkspaceRoot, setWorkspaceRoot } from "../utils/runtime.js";

export function getBenchmarkSourceWorkspace(): string {
  return getWorkspaceRoot();
}

export function withBenchmarkWorkspace<T>(workspacePath: string, run: () => Promise<T>): Promise<T> {
  const previous = getWorkspaceRoot();
  setWorkspaceRoot(workspacePath);
  return run().finally(() => {
    setWorkspaceRoot(previous);
  });
}

export function resolveBenchmarkReportPath(outputPath?: string): string {
  return outputPath || path.join(getWorkspaceRoot(), ".mini-claude-code", "benchmark-report.json");
}
