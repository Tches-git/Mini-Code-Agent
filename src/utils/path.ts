import path from "node:path";
import { getWorkspaceRoot } from "./runtime.js";

export function isPathInsideWorkspace(target: string): boolean {
  const root = getWorkspaceRoot();
  const fullPath = path.resolve(root, target);
  const relativePath = path.relative(root, fullPath);
  return !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

export function isPathOutsideWorkspace(target: string): boolean {
  return !isPathInsideWorkspace(target);
}

export function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
