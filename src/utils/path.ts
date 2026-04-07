import path from "node:path";

const root = process.cwd();

export function isPathInsideWorkspace(target: string): boolean {
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
