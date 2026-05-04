import { promises as fs } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { z } from "zod";
import type { ToolDefinition } from "../types/agent.js";
import { buildDiffPreview } from "../utils/diff.js";
import {
  isPathInsideWorkspace,
  isPathOutsideWorkspace,
} from "../utils/path.js";
import { getWorkspaceRoot } from "../utils/runtime.js";
import { createTool } from "./create-tool.js";

function getRoot(): string {
  return getWorkspaceRoot();
}

function getBackupDir(): string {
  return path.join(getRoot(), ".backup");
}

function getImportsDir(): string {
  return path.join(getRoot(), ".imports");
}
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const DEFAULT_READ_FILE_LINE_LIMIT = 2000;
const MAX_READ_FILE_LINE_LIMIT = 5000;
const DEFAULT_TREE_MAX_DEPTH = 3;
const DEFAULT_TREE_MAX_ENTRIES = 200;
const MAX_TREE_MAX_DEPTH = 8;
const MAX_TREE_MAX_ENTRIES = 1000;
const TREE_IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".backup",
  ".imports",
  "dist",
]);
const TEXTUTIL_EXTRACTION_EXTENSIONS = new Set([
  ".doc",
  ".docx",
  ".odt",
  ".rtf",
]);
const OOXML_SPREADSHEET_EXTENSIONS = new Set([
  ".xlsx",
  ".xlsm",
  ".xltx",
  ".xltm",
]);
const OPEN_DOCUMENT_SPREADSHEET_EXTENSIONS = new Set([".ods"]);
const OOXML_PRESENTATION_EXTENSIONS = new Set([
  ".pptx",
  ".pptm",
  ".potx",
  ".potm",
]);
const OPEN_DOCUMENT_PRESENTATION_EXTENSIONS = new Set([".odp"]);
const FALLBACK_TEXT_EXTRACTION_EXTENSIONS = new Set([
  ".key",
  ".numbers",
  ".pages",
  ".pdf",
  ".ppt",
  ".xls",
]);
const TEXT_EXTRACTION_EXTENSIONS = new Set([
  ...TEXTUTIL_EXTRACTION_EXTENSIONS,
  ...OOXML_SPREADSHEET_EXTENSIONS,
  ...OPEN_DOCUMENT_SPREADSHEET_EXTENSIONS,
  ...OOXML_PRESENTATION_EXTENSIONS,
  ...OPEN_DOCUMENT_PRESENTATION_EXTENSIONS,
  ...FALLBACK_TEXT_EXTRACTION_EXTENSIONS,
]);
const TEXT_FILE_EXTENSIONS = new Set([
  ".adoc",
  ".conf",
  ".css",
  ".csv",
  ".env",
  ".html",
  ".ini",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mdx",
  ".mjs",
  ".rst",
  ".scss",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".tsv",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const IMPORT_MODES = ["auto", "copy", "extract_text"] as const;
type ImportMode = (typeof IMPORT_MODES)[number];

type ExternalImportResult = {
  relativePath: string;
  content?: string;
  summary: string;
};

type ReadFileOptions = {
  path: string;
  offset?: number;
  limit?: number;
  confirmed?: boolean;
};

type InspectFileOptions = {
  path: string;
  confirmed?: boolean;
};

type ImageDimensions = {
  width: number;
  height: number;
};

type ReplaceRangeOptions = {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  confirmed?: boolean;
};

type TreeFilesOptions = {
  path: string;
  maxDepth?: number;
  maxEntries?: number;
  includeFiles?: boolean;
  confirmed?: boolean;
};

function normalizeSlashes(target: string): string {
  return target.replace(/\\/g, "/");
}

function resolveAccessiblePath(target: string, confirmed = false): string {
  const fullPath = path.resolve(getRoot(), target);
  if (isPathOutsideWorkspace(fullPath) && !confirmed) {
    throw new Error("访问工作区外路径前需要用户确认");
  }
  return fullPath;
}

function resolveWorkspacePath(target: string): string {
  const root = getRoot();
  const fullPath = path.resolve(root, target);
  const relativePath = path.relative(root, fullPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("禁止访问工作区外路径");
  }
  return fullPath;
}

function toWorkspaceRelative(target: string): string {
  return normalizeSlashes(path.relative(getRoot(), target));
}

function toDisplayPath(target: string): string {
  return isPathInsideWorkspace(target)
    ? toWorkspaceRelative(path.resolve(getRoot(), target))
    : normalizeSlashes(path.resolve(getRoot(), target));
}

function toDiffLabel(displayPath: string): string {
  return displayPath.startsWith("/") ? displayPath.slice(1) : displayPath;
}

function normalizeReadOffset(offset?: number): number {
  return Number.isFinite(offset) ? Math.max(0, offset || 0) : 0;
}

function normalizeReadLimit(limit?: number): number {
  return Number.isFinite(limit)
    ? Math.max(
        1,
        Math.min(
          MAX_READ_FILE_LINE_LIMIT,
          limit || DEFAULT_READ_FILE_LINE_LIMIT,
        ),
      )
    : DEFAULT_READ_FILE_LINE_LIMIT;
}

function formatReadFileContent(
  content: string,
  options: ReadFileOptions,
): string {
  const offset = normalizeReadOffset(options.offset);
  const limit = normalizeReadLimit(options.limit);
  const lines = content.split("\n");
  const selected = lines.slice(offset, offset + limit);
  const endLine = offset + selected.length;
  const isTruncated = endLine < lines.length;
  const header = [
    `File: ${options.path}`,
    `Lines: ${offset + 1}-${endLine} of ${lines.length}`,
    isTruncated
      ? `Truncated: true (use offset=${endLine}, limit=${limit} to continue)`
      : "Truncated: false",
  ].join("\n");

  return `${header}\n\n${selected.join("\n")}`;
}

async function readFileContent(options: ReadFileOptions): Promise<string> {
  const target = resolveAccessiblePath(options.path, options.confirmed);
  const content = await fs.readFile(target, "utf8");
  return formatReadFileContent(content, {
    ...options,
    path: toDisplayPath(target),
  });
}

function replaceLineRangeContent(
  source: string,
  options: ReplaceRangeOptions,
): string {
  const lines = source.split("\n");
  if (options.startLine < 1 || options.endLine < options.startLine) {
    throw new Error(
      "行号范围无效：startLine 必须 >= 1 且 endLine 必须 >= startLine",
    );
  }
  if (options.endLine > lines.length) {
    throw new Error(`行号范围超出文件长度：文件共 ${lines.length} 行`);
  }

  const replacementLines = options.content.split("\n");
  lines.splice(
    options.startLine - 1,
    options.endLine - options.startLine + 1,
    ...replacementLines,
  );
  return lines.join("\n");
}

function normalizeTreeMaxDepth(maxDepth?: number): number {
  return Number.isFinite(maxDepth)
    ? Math.max(
        0,
        Math.min(MAX_TREE_MAX_DEPTH, maxDepth || DEFAULT_TREE_MAX_DEPTH),
      )
    : DEFAULT_TREE_MAX_DEPTH;
}

function normalizeTreeMaxEntries(maxEntries?: number): number {
  return Number.isFinite(maxEntries)
    ? Math.max(
        1,
        Math.min(MAX_TREE_MAX_ENTRIES, maxEntries || DEFAULT_TREE_MAX_ENTRIES),
      )
    : DEFAULT_TREE_MAX_ENTRIES;
}

async function buildTreeFilesOutput(
  options: TreeFilesOptions,
): Promise<string> {
  const target = resolveAccessiblePath(options.path || ".", options.confirmed);
  const displayRoot = toDisplayPath(target) || ".";
  const maxDepth = normalizeTreeMaxDepth(options.maxDepth);
  const maxEntries = normalizeTreeMaxEntries(options.maxEntries);
  const includeFiles = options.includeFiles !== false;
  const lines = [`${displayRoot}/`];
  let entryCount = 0;
  let skippedCount = 0;
  let truncated = false;

  const walkTree = async (
    dir: string,
    depth: number,
    prefix: string,
  ): Promise<void> => {
    if (truncated || depth >= maxDepth) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const visibleEntries = entries
      .filter((entry) => entry.isDirectory() || includeFiles)
      .filter((entry) => {
        if (entry.isDirectory() && TREE_IGNORED_DIRECTORIES.has(entry.name)) {
          skippedCount += 1;
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const aRank = a.isDirectory() ? 0 : 1;
        const bRank = b.isDirectory() ? 0 : 1;
        return aRank - bRank || a.name.localeCompare(b.name);
      });

    for (const [index, entry] of visibleEntries.entries()) {
      if (entryCount >= maxEntries) {
        truncated = true;
        return;
      }
      const isLast = index === visibleEntries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const nextPrefix = `${prefix}${isLast ? "    " : "│   "}`;
      lines.push(
        `${prefix}${connector}${entry.name}${entry.isDirectory() ? "/" : ""}`,
      );
      entryCount += 1;
      if (entry.isDirectory()) {
        await walkTree(path.join(dir, entry.name), depth + 1, nextPrefix);
      }
      if (truncated) return;
    }
  };

  await walkTree(target, 0, "");
  lines.push(
    ``,
    `Entries: ${entryCount}`,
    `Max depth: ${maxDepth}`,
    `Skipped ignored directories: ${skippedCount}`,
    `Truncated: ${truncated ? "true" : "false"}`,
  );
  return lines.join("\n");
}

function buildDiffEntry(
  displayPath: string,
  summary: string,
  before: string,
  after: string,
) {
  return {
    path: displayPath,
    summary,
    diff: buildDiffPreview(before, after, toDiffLabel(displayPath)),
  };
}

function getExtension(sourcePath: string): string {
  return path.extname(sourcePath).toLowerCase();
}

function normalizeImportMode(
  sourcePath: string,
  mode: ImportMode,
): Exclude<ImportMode, "auto"> {
  if (mode !== "auto") {
    return mode;
  }
  return TEXT_EXTRACTION_EXTENSIONS.has(getExtension(sourcePath))
    ? "extract_text"
    : "copy";
}

function isReadableTextFile(sourcePath: string): boolean {
  return TEXT_FILE_EXTENSIONS.has(getExtension(sourcePath));
}

function getMimeType(sourcePath: string): string {
  const extension = getExtension(sourcePath);
  const mimeTypes: Record<string, string> = {
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain",
    ".webp": "image/webp",
    ".xml": "application/xml",
  };
  if (mimeTypes[extension]) return mimeTypes[extension];
  if (TEXT_FILE_EXTENSIONS.has(extension)) return "text/plain";
  if (TEXT_EXTRACTION_EXTENSIONS.has(extension))
    return "application/octet-stream";
  return "application/octet-stream";
}

function readPngDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (buffer.length < 24) return undefined;
  if (
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  return undefined;
}

function readGifDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (buffer.length < 10) return undefined;
  const signature = buffer.subarray(0, 6).toString("ascii");
  if (signature === "GIF87a" || signature === "GIF89a") {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  return undefined;
}

function readJpegDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8)
    return undefined;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        width: buffer.readUInt16BE(offset + 7),
        height: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += 2 + length;
  }
  return undefined;
}

function readWebpDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (buffer.length < 30) return undefined;
  if (buffer.subarray(0, 4).toString("ascii") !== "RIFF") return undefined;
  if (buffer.subarray(8, 12).toString("ascii") !== "WEBP") return undefined;
  const chunkType = buffer.subarray(12, 16).toString("ascii");
  if (chunkType === "VP8X" && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (chunkType === "VP8 " && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunkType === "VP8L" && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >> 14) & 0x3fff),
    };
  }
  return undefined;
}

function countPdfPages(buffer: Buffer): number | undefined {
  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) return undefined;
  const text = buffer.toString("latin1");
  const matches = text.match(/\/Type\s*\/Page\b/g);
  return matches?.length || undefined;
}

function inspectImageDimensions(
  buffer: Buffer,
  sourcePath: string,
): ImageDimensions | undefined {
  const extension = getExtension(sourcePath);
  if (extension === ".png") return readPngDimensions(buffer);
  if (extension === ".gif") return readGifDimensions(buffer);
  if (extension === ".jpg" || extension === ".jpeg")
    return readJpegDimensions(buffer);
  if (extension === ".webp") return readWebpDimensions(buffer);
  return (
    readPngDimensions(buffer) ||
    readGifDimensions(buffer) ||
    readJpegDimensions(buffer) ||
    readWebpDimensions(buffer)
  );
}

function isProbablyTextBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.includes(0)) return false;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length < 0.05;
}

async function inspectFileContent(
  options: InspectFileOptions,
): Promise<string> {
  const target = resolveAccessiblePath(options.path, options.confirmed);
  const stats = await fs.stat(target);
  if (!stats.isFile()) {
    throw new Error(`仅支持检查普通文件: ${toDisplayPath(target)}`);
  }
  const buffer = await fs.readFile(target);
  const extension = getExtension(target) || "<none>";
  const mimeType = getMimeType(target);
  const likelyText = isReadableTextFile(target) || isProbablyTextBuffer(buffer);
  const imageDimensions = inspectImageDimensions(buffer, target);
  const pdfPages =
    getExtension(target) === ".pdf" ? countPdfPages(buffer) : undefined;
  const suggestion = likelyText
    ? "可直接使用 read_file 读取。"
    : TEXT_EXTRACTION_EXTENSIONS.has(getExtension(target))
      ? "可使用 import_external_file 的 extract_text 模式尝试提取文本。"
      : "这是二进制文件；如需分析内容，请先转换为文本或使用 import_external_file 缓存。";

  return JSON.stringify(
    {
      path: toDisplayPath(target),
      sizeBytes: stats.size,
      extension,
      mimeType,
      likelyText,
      imageDimensions,
      pdfPages,
      suggestion,
    },
    null,
    2,
  );
}

function sanitizeFileName(fileName: string): string {
  return (
    fileName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "imported-file"
  );
}

function getBackupRelativePath(filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  if (!isPathOutsideWorkspace(resolvedPath)) {
    return path.relative(getRoot(), resolvedPath);
  }

  const parts = resolvedPath
    .split(path.sep)
    .filter(Boolean)
    .map(sanitizeFileName);
  return path.join("__external__", ...parts);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function findAvailablePath(target: string): Promise<string> {
  if (!(await pathExists(target))) {
    return target;
  }

  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let index = 1; index <= 999; index++) {
    const candidate = path.join(dir, `${base}-${index}${ext}`);
    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }

  throw new Error("无法为导入文件找到可用文件名，请清理 .imports 后重试");
}

async function resolveImportDestination(
  sourcePath: string,
  destinationPath: string | undefined,
  mode: Exclude<ImportMode, "auto">,
): Promise<string> {
  const sourceName = sanitizeFileName(
    path.basename(sourcePath, path.extname(sourcePath)),
  );
  const targetExt =
    mode === "extract_text" ? ".txt" : path.extname(sourcePath) || ".bin";

  if (destinationPath) {
    const resolved = resolveWorkspacePath(destinationPath);
    if (await pathExists(resolved)) {
      throw new Error(
        `目标文件已存在，请更换 destinationPath: ${destinationPath}`,
      );
    }
    return resolved;
  }

  const importsDir = getImportsDir();
  await fs.mkdir(importsDir, { recursive: true });
  const target = path.join(importsDir, `${sourceName}${targetExt}`);
  return findAvailablePath(target);
}

async function ensureReadableExternalFile(sourcePath: string): Promise<void> {
  const stats = await fs.stat(sourcePath);
  if (!stats.isFile()) {
    throw new Error(`仅支持导入文件，当前不是普通文件: ${sourcePath}`);
  }
  if (stats.size > MAX_IMPORT_BYTES) {
    throw new Error(
      `文件过大 (${stats.size} bytes)，当前最多支持导入 ${MAX_IMPORT_BYTES} bytes`,
    );
  }
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, value: string) =>
      String.fromCodePoint(Number.parseInt(value, 16)),
    )
    .replace(/&#(\d+);/g, (_, value: string) =>
      String.fromCodePoint(Number.parseInt(value, 10)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function cleanupExtractedText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripXmlTags(xml: string): string {
  const withLineBreaks = xml
    .replace(/<text:line-break\s*\/?>/g, "\n")
    .replace(/<text:tab\s*\/?>/g, "\t")
    .replace(/<br\s*\/?>/g, "\n");
  const withoutTags = withLineBreaks.replace(/<[^>]+>/g, " ");
  return cleanupExtractedText(
    decodeXmlEntities(withoutTags).replace(/[ \t]{2,}/g, " "),
  );
}

function extractXmlTextRuns(xml: string): string[] {
  return [
    ...xml.matchAll(/<(?:[\w-]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?t>/g),
  ]
    .map((match) => cleanupExtractedText(decodeXmlEntities(match[1])))
    .filter(Boolean);
}

function getXmlTagText(xml: string, tagName: string): string {
  const regex = new RegExp(
    `<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`,
  );
  const match = xml.match(regex);
  return match ? cleanupExtractedText(decodeXmlEntities(match[1])) : "";
}

function columnLettersToIndex(value: string): number {
  let result = 0;
  for (const char of value.toUpperCase()) {
    result = result * 26 + (char.charCodeAt(0) - 64);
  }
  return Math.max(0, result - 1);
}

async function extractTextWithTextutil(sourcePath: string): Promise<string> {
  const result = await execa(
    "textutil",
    ["-convert", "txt", "-stdout", sourcePath],
    {
      cwd: getRoot(),
      reject: false,
      timeout: 60_000,
    },
  );
  if (result.failed || result.exitCode !== 0) {
    throw new Error(result.stderr || `无法提取文档文本: ${sourcePath}`);
  }
  return cleanupExtractedText(result.stdout);
}

async function extractTextWithMdls(sourcePath: string): Promise<string> {
  const result = await execa(
    "mdls",
    ["-name", "kMDItemTextContent", "-raw", sourcePath],
    {
      cwd: getRoot(),
      reject: false,
      timeout: 60_000,
    },
  );
  if (result.failed || result.exitCode !== 0) {
    throw new Error(
      result.stderr || `无法读取 Spotlight 文本内容: ${sourcePath}`,
    );
  }
  const content = cleanupExtractedText(result.stdout);
  if (!content || content === "(null)" || content === "null") {
    throw new Error(`Spotlight 未提供可用文本内容: ${sourcePath}`);
  }
  return content;
}

async function extractTextWithStrings(sourcePath: string): Promise<string> {
  const result = await execa("strings", ["-n", "4", sourcePath], {
    cwd: getRoot(),
    reject: false,
    timeout: 60_000,
  });
  if (result.failed || result.exitCode !== 0) {
    throw new Error(
      result.stderr || `无法通过 strings 提取文本: ${sourcePath}`,
    );
  }
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 4);
  const content = cleanupExtractedText(lines.join("\n"));
  if (!content) {
    throw new Error(`未从二进制文件中提取到可读文本: ${sourcePath}`);
  }
  return content;
}

async function listZipEntries(sourcePath: string): Promise<string[]> {
  const result = await execa("unzip", ["-Z1", sourcePath], {
    cwd: getRoot(),
    reject: false,
    timeout: 60_000,
  });
  if (result.failed || result.exitCode !== 0) {
    throw new Error(result.stderr || `无法读取压缩包目录: ${sourcePath}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function readZipEntry(
  sourcePath: string,
  entryPath: string,
): Promise<string> {
  const result = await execa("unzip", ["-p", sourcePath, entryPath], {
    cwd: getRoot(),
    reject: false,
    timeout: 60_000,
  });
  if (result.failed || result.exitCode !== 0) {
    throw new Error(result.stderr || `无法读取压缩包内文件: ${entryPath}`);
  }
  return result.stdout;
}

async function readOptionalZipEntry(
  sourcePath: string,
  entryPath: string,
): Promise<string | undefined> {
  try {
    return await readZipEntry(sourcePath, entryPath);
  } catch {
    return undefined;
  }
}

function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => {
    const runs = extractXmlTextRuns(match[1]);
    if (runs.length > 0) {
      return cleanupExtractedText(runs.join(""));
    }
    return stripXmlTags(match[1]);
  });
}

function parseXlsxCellValue(
  cellXml: string,
  attrs: string,
  sharedStrings: string[],
): string {
  const typeMatch = attrs.match(/\bt="([^"]+)"/);
  const type = typeMatch?.[1];

  if (type === "inlineStr") {
    return cleanupExtractedText(extractXmlTextRuns(cellXml).join(""));
  }

  if (type === "s") {
    const index = Number.parseInt(getXmlTagText(cellXml, "v"), 10);
    return Number.isFinite(index) ? sharedStrings[index] || "" : "";
  }

  if (type === "b") {
    return getXmlTagText(cellXml, "v") === "1" ? "TRUE" : "FALSE";
  }

  if (type === "str") {
    return getXmlTagText(cellXml, "v");
  }

  const value = getXmlTagText(cellXml, "v");
  if (value) {
    return value;
  }

  return cleanupExtractedText(extractXmlTextRuns(cellXml).join(""));
}

function parseXlsxSheetRows(
  sheetXml: string,
  sharedStrings: string[],
): string[] {
  const rows: string[] = [];
  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowXml = rowMatch[1];
    const cells: string[] = [];
    let lastIndex = -1;

    for (const cellMatch of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const cellXml = cellMatch[2];
      const refMatch = attrs.match(/\br="([A-Z]+)\d+"/);
      const cellIndex = refMatch
        ? columnLettersToIndex(refMatch[1])
        : lastIndex + 1;
      while (cells.length < cellIndex) {
        cells.push("");
      }
      cells[cellIndex] = parseXlsxCellValue(cellXml, attrs, sharedStrings);
      lastIndex = cellIndex;
    }

    while (cells.length > 0 && !cells[cells.length - 1]) {
      cells.pop();
    }

    if (cells.some(Boolean)) {
      rows.push(cells.join("\t"));
    }
  }
  return rows;
}

async function extractSpreadsheetTextFromXlsx(
  sourcePath: string,
): Promise<string> {
  const entries = await listZipEntries(sourcePath);
  const sheetEntries = entries
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (sheetEntries.length === 0) {
    throw new Error(`未在 Excel 文件中找到工作表: ${sourcePath}`);
  }

  const workbookXml = await readOptionalZipEntry(sourcePath, "xl/workbook.xml");
  const sharedStringsXml = await readOptionalZipEntry(
    sourcePath,
    "xl/sharedStrings.xml",
  );
  const sharedStrings = sharedStringsXml
    ? parseSharedStrings(sharedStringsXml)
    : [];
  const sheetNames = workbookXml
    ? [...workbookXml.matchAll(/<sheet\b[^>]*name="([^"]+)"/g)].map((match) =>
        decodeXmlEntities(match[1]),
      )
    : [];

  const sections: string[] = [];
  for (const [index, sheetEntry] of sheetEntries.entries()) {
    const sheetXml = await readZipEntry(sourcePath, sheetEntry);
    const rows = parseXlsxSheetRows(sheetXml, sharedStrings);
    const title = sheetNames[index] || path.basename(sheetEntry, ".xml");
    if (rows.length > 0) {
      sections.push(`## ${title}\n${rows.join("\n")}`);
    }
  }

  const content = cleanupExtractedText(sections.join("\n\n"));
  if (!content) {
    throw new Error(`未从 Excel 文件中提取到可读文本: ${sourcePath}`);
  }
  return content;
}

function extractOpenDocumentCellText(cellXml: string): string {
  const paragraphs = [
    ...cellXml.matchAll(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g),
  ]
    .map((match) => stripXmlTags(match[1]))
    .filter(Boolean);
  if (paragraphs.length > 0) {
    return cleanupExtractedText(paragraphs.join(" "));
  }
  return stripXmlTags(cellXml);
}

async function extractSpreadsheetTextFromOds(
  sourcePath: string,
): Promise<string> {
  const contentXml = await readZipEntry(sourcePath, "content.xml");
  const tables = [
    ...contentXml.matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g),
  ];
  const sections: string[] = [];

  for (const tableMatch of tables) {
    const attrs = tableMatch[1];
    const tableXml = tableMatch[2];
    const nameMatch = attrs.match(/table:name="([^"]+)"/);
    const title = decodeXmlEntities(nameMatch?.[1] || "Sheet");
    const rows: string[] = [];

    for (const rowMatch of tableXml.matchAll(
      /<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/g,
    )) {
      const rowXml = rowMatch[1];
      const cells: string[] = [];
      for (const cellMatch of rowXml.matchAll(
        /<table:table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g,
      )) {
        const cellAttrs = cellMatch[1];
        const cellBody = cellMatch[2] || "";
        const repeatMatch = cellAttrs.match(
          /table:number-columns-repeated="(\d+)"/,
        );
        const repeatCount = Math.min(
          Number.parseInt(repeatMatch?.[1] || "1", 10) || 1,
          20,
        );
        const value = extractOpenDocumentCellText(cellBody);
        for (let index = 0; index < repeatCount; index++) {
          cells.push(index === 0 ? value : "");
        }
      }
      while (cells.length > 0 && !cells[cells.length - 1]) {
        cells.pop();
      }
      if (cells.some(Boolean)) {
        rows.push(cells.join("\t"));
      }
    }

    if (rows.length > 0) {
      sections.push(`## ${title}\n${rows.join("\n")}`);
    }
  }

  const content = cleanupExtractedText(sections.join("\n\n"));
  if (!content) {
    throw new Error(`未从 OpenDocument 表格中提取到可读文本: ${sourcePath}`);
  }
  return content;
}

async function extractPresentationTextFromPptx(
  sourcePath: string,
): Promise<string> {
  const entries = await listZipEntries(sourcePath);
  const slideEntries = entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (slideEntries.length === 0) {
    throw new Error(`未在演示文稿中找到幻灯片: ${sourcePath}`);
  }

  const sections: string[] = [];
  for (const [index, slideEntry] of slideEntries.entries()) {
    const slideXml = await readZipEntry(sourcePath, slideEntry);
    const lines = extractXmlTextRuns(slideXml);
    if (lines.length > 0) {
      sections.push(`## Slide ${index + 1}\n${lines.join("\n")}`);
    }
  }

  const content = cleanupExtractedText(sections.join("\n\n"));
  if (!content) {
    throw new Error(`未从演示文稿中提取到可读文本: ${sourcePath}`);
  }
  return content;
}

async function extractPresentationTextFromOdp(
  sourcePath: string,
): Promise<string> {
  const contentXml = await readZipEntry(sourcePath, "content.xml");
  const pages = [
    ...contentXml.matchAll(/<draw:page\b([^>]*)>([\s\S]*?)<\/draw:page>/g),
  ];
  const sections = pages
    .map((pageMatch, index) => {
      const attrs = pageMatch[1];
      const pageXml = pageMatch[2];
      const nameMatch = attrs.match(/draw:name="([^"]+)"/);
      const title = decodeXmlEntities(nameMatch?.[1] || `Slide ${index + 1}`);
      const text = stripXmlTags(pageXml);
      return text ? `## ${title}\n${text}` : "";
    })
    .filter(Boolean);

  const content = cleanupExtractedText(sections.join("\n\n"));
  if (!content) {
    throw new Error(
      `未从 OpenDocument 演示文稿中提取到可读文本: ${sourcePath}`,
    );
  }
  return content;
}

async function extractTextContent(sourcePath: string): Promise<string> {
  const extension = getExtension(sourcePath);
  const strategies: Array<{ name: string; run: () => Promise<string> }> = [];

  if (TEXTUTIL_EXTRACTION_EXTENSIONS.has(extension)) {
    strategies.push({
      name: "textutil",
      run: () => extractTextWithTextutil(sourcePath),
    });
  }
  if (OOXML_SPREADSHEET_EXTENSIONS.has(extension)) {
    strategies.push({
      name: "excel-xml",
      run: () => extractSpreadsheetTextFromXlsx(sourcePath),
    });
  }
  if (OPEN_DOCUMENT_SPREADSHEET_EXTENSIONS.has(extension)) {
    strategies.push({
      name: "ods-xml",
      run: () => extractSpreadsheetTextFromOds(sourcePath),
    });
  }
  if (OOXML_PRESENTATION_EXTENSIONS.has(extension)) {
    strategies.push({
      name: "pptx-xml",
      run: () => extractPresentationTextFromPptx(sourcePath),
    });
  }
  if (OPEN_DOCUMENT_PRESENTATION_EXTENSIONS.has(extension)) {
    strategies.push({
      name: "odp-xml",
      run: () => extractPresentationTextFromOdp(sourcePath),
    });
  }
  if (FALLBACK_TEXT_EXTRACTION_EXTENSIONS.has(extension)) {
    strategies.push({
      name: "spotlight",
      run: () => extractTextWithMdls(sourcePath),
    });
    strategies.push({
      name: "strings",
      run: () => extractTextWithStrings(sourcePath),
    });
  }

  if (strategies.length === 0) {
    throw new Error(`当前暂不支持自动提取该格式的文本: ${sourcePath}`);
  }

  const errors: string[] = [];
  for (const strategy of strategies) {
    try {
      const content = cleanupExtractedText(await strategy.run());
      if (content) {
        return content;
      }
      errors.push(`${strategy.name}: 未提取到内容`);
    } catch (error) {
      errors.push(
        `${strategy.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(`无法提取文件文本: ${sourcePath}\n${errors.join("\n")}`);
}

async function importExternalFile(options: {
  sourcePath: string;
  destinationPath?: string;
  mode: ImportMode;
}): Promise<ExternalImportResult> {
  const resolvedSourcePath = path.resolve(getRoot(), options.sourcePath);
  if (isPathInsideWorkspace(resolvedSourcePath)) {
    throw new Error(
      `文件已位于工作区内，请直接读取: ${toWorkspaceRelative(resolvedSourcePath)}`,
    );
  }

  await ensureReadableExternalFile(resolvedSourcePath);

  const normalizedMode = normalizeImportMode(resolvedSourcePath, options.mode);
  const resolvedDestinationPath = await resolveImportDestination(
    resolvedSourcePath,
    options.destinationPath,
    normalizedMode,
  );

  await fs.mkdir(path.dirname(resolvedDestinationPath), { recursive: true });

  if (normalizedMode === "extract_text") {
    const content = await extractTextContent(resolvedSourcePath);
    await fs.writeFile(resolvedDestinationPath, content, "utf8");
    return {
      relativePath: toWorkspaceRelative(resolvedDestinationPath),
      content,
      summary: `已打开并提取文本: ${path.basename(resolvedSourcePath)}`,
    };
  }

  if (isReadableTextFile(resolvedSourcePath)) {
    const content = await fs.readFile(resolvedSourcePath, "utf8");
    await fs.writeFile(resolvedDestinationPath, content, "utf8");
    return {
      relativePath: toWorkspaceRelative(resolvedDestinationPath),
      content,
      summary: `已打开文本文件: ${path.basename(resolvedSourcePath)}`,
    };
  }

  await fs.copyFile(resolvedSourcePath, resolvedDestinationPath);
  return {
    relativePath: toWorkspaceRelative(resolvedDestinationPath),
    summary: `已打开外部文件: ${path.basename(resolvedSourcePath)}`,
  };
}

/**
 * 在修改文件前，将原文件备份到 .backup/ 目录。
 * 备份路径保留原始相对路径结构，文件名追加时间戳防止覆盖。
 * 如果原文件不存在（新建场景）则跳过。
 */
async function backupFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    return;
  }
  const relPath = getBackupRelativePath(filePath);
  const ext = path.extname(relPath);
  const base = relPath.slice(0, relPath.length - ext.length);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(getBackupDir(), `${base}.${timestamp}${ext}`);
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.copyFile(filePath, backupPath);
}

const pathSchema = z.object({
  path: z.string(),
  confirmed: z.boolean().optional(),
});
const readFileSchema = z.object({
  path: z.string(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(MAX_READ_FILE_LINE_LIMIT).optional(),
  confirmed: z.boolean().optional(),
});
const inspectFileSchema = z.object({
  path: z.string(),
  confirmed: z.boolean().optional(),
});
const treeFilesSchema = z.object({
  path: z.string().optional(),
  maxDepth: z.number().int().min(0).max(MAX_TREE_MAX_DEPTH).optional(),
  maxEntries: z.number().int().min(1).max(MAX_TREE_MAX_ENTRIES).optional(),
  includeFiles: z.boolean().optional(),
  confirmed: z.boolean().optional(),
});
const pathContentSchema = z.object({
  path: z.string(),
  content: z.string(),
  confirmed: z.boolean().optional(),
});
const insertSchema = z.object({
  path: z.string(),
  anchorText: z.string(),
  content: z.string(),
  confirmed: z.boolean().optional(),
});
const replaceSchema = z.object({
  path: z.string(),
  oldText: z.string(),
  newText: z.string(),
  confirmed: z.boolean().optional(),
});
const replaceRangeSchema = z.object({
  path: z.string(),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  content: z.string(),
  confirmed: z.boolean().optional(),
});
const importSchema = z.object({
  sourcePath: z.string().min(1, "sourcePath 不能为空"),
  destinationPath: z.string().optional(),
  mode: z.enum(IMPORT_MODES).optional(),
  confirmed: z.boolean().optional(),
});

export {
  buildTreeFilesOutput,
  cleanupExtractedText,
  columnLettersToIndex,
  countPdfPages,
  decodeXmlEntities,
  extractOpenDocumentCellText,
  extractXmlTextRuns,
  formatReadFileContent,
  getBackupRelativePath,
  getExtension,
  getMimeType,
  getXmlTagText,
  inspectFileContent,
  inspectImageDimensions,
  isProbablyTextBuffer,
  isReadableTextFile,
  normalizeImportMode,
  normalizeSlashes,
  parseSharedStrings,
  parseXlsxCellValue,
  parseXlsxSheetRows,
  replaceLineRangeContent,
  resolveAccessiblePath,
  resolveWorkspacePath,
  sanitizeFileName,
  stripXmlTags,
  toDiffLabel,
  toDisplayPath,
  toWorkspaceRelative,
};

export const fileTools: ToolDefinition[] = [
  createTool({
    name: "list_files",
    description: "列出目录下的文件和子目录，可在确认后访问工作区外路径",
    schema: pathSchema,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, confirmed: { type: "boolean" } },
      required: ["path"],
    },
    async execute(input) {
      const target = resolveAccessiblePath(input.path, input.confirmed);
      const entries = await fs.readdir(target, { withFileTypes: true });
      return JSON.stringify(
        entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "dir" : "file",
        })),
        null,
        2,
      );
    },
  }),
  createTool({
    name: "tree_files",
    description:
      "以目录树形式展示文件层级，适合理解项目结构；支持深度、条目数和是否包含文件",
    schema: treeFilesSchema,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "可选，起始目录，默认当前工作区" },
        maxDepth: {
          type: "number",
          description: `可选，最大深度，范围 0-${MAX_TREE_MAX_DEPTH}，默认 ${DEFAULT_TREE_MAX_DEPTH}`,
        },
        maxEntries: {
          type: "number",
          description: `可选，最多展示条目数，范围 1-${MAX_TREE_MAX_ENTRIES}，默认 ${DEFAULT_TREE_MAX_ENTRIES}`,
        },
        includeFiles: {
          type: "boolean",
          description: "可选，是否展示文件，默认 true",
        },
        confirmed: { type: "boolean" },
      },
    },
    async execute(input) {
      return buildTreeFilesOutput({
        path: input.path || ".",
        maxDepth: input.maxDepth,
        maxEntries: input.maxEntries,
        includeFiles: input.includeFiles,
        confirmed: input.confirmed,
      });
    },
  }),
  createTool({
    name: "read_file",
    description:
      "读取文件内容，可用 offset/limit 按行分页，默认最多返回 2000 行；可在确认后访问工作区外文件",
    schema: readFileSchema,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: {
          type: "number",
          description: "可选，从第几行开始读取（0-based），默认 0",
        },
        limit: {
          type: "number",
          description: `可选，最多读取多少行，范围 1-${MAX_READ_FILE_LINE_LIMIT}，默认 ${DEFAULT_READ_FILE_LINE_LIMIT}`,
        },
        confirmed: { type: "boolean" },
      },
      required: ["path"],
    },
    async execute(input) {
      return readFileContent(input);
    },
  }),
  createTool({
    name: "inspect_file",
    description:
      "只读检查文件元信息，返回大小、扩展名、MIME、是否像文本、图片尺寸和下一步建议；适合读取二进制/图片/PDF 前先判断",
    schema: inspectFileSchema,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "要检查的文件路径" },
        confirmed: { type: "boolean" },
      },
      required: ["path"],
    },
    async execute(input) {
      return inspectFileContent(input);
    },
  }),
  createTool({
    name: "import_external_file",
    description:
      "在用户明确要求分析工作区外本地文件时，先把文件安全打开到工作区缓存中；对 Office/OpenDocument/PDF 等常见格式尽量自动提取为文本",
    schema: importSchema,
    inputSchema: {
      type: "object",
      properties: {
        sourcePath: {
          type: "string",
          description: "工作区外文件路径，可以是绝对路径",
        },
        destinationPath: {
          type: "string",
          description: "可选，缓存到工作区内的目标路径",
        },
        mode: {
          type: "string",
          enum: [...IMPORT_MODES],
          description: "auto=常见文档自动提取文本，其它文件默认复制",
        },
        confirmed: {
          type: "boolean",
          description: "仅当用户已明确确认打开工作区外文件时才传 true",
        },
      },
      required: ["sourcePath"],
    },
    async execute(input) {
      if (!input.confirmed) {
        throw new Error(`打开工作区外文件前需要用户确认: ${input.sourcePath}`);
      }

      const result = await importExternalFile({
        sourcePath: input.sourcePath,
        destinationPath: input.destinationPath,
        mode: input.mode || "auto",
      });

      const preview = result.content
        ? buildDiffPreview("", result.content, toDiffLabel(result.relativePath))
        : buildDiffPreview(
            "",
            `[binary import] ${input.sourcePath}\n`,
            toDiffLabel(result.relativePath),
          );

      return {
        message: `${result.summary}\n缓存路径: ${result.relativePath}${result.content ? "\n现在可以继续读取该文本文件做分析。" : "\n已保留原始文件副本；若需要分析内容，请先转成可读文本格式。"}`,
        diff: {
          path: result.relativePath,
          summary: result.summary,
          diff: preview,
        },
      };
    },
  }),
  createTool({
    name: "create_file",
    description: "新建文件；如果文件已存在则返回提示，不覆盖原文件",
    schema: pathContentSchema,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        confirmed: { type: "boolean" },
      },
      required: ["path", "content"],
    },
    async execute(input) {
      const target = resolveAccessiblePath(input.path, input.confirmed);
      const displayPath = toDisplayPath(target);
      try {
        await fs.access(target);
        return `文件已存在，未覆盖: ${displayPath}`;
      } catch {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, input.content, "utf8");
        return {
          message: `已创建 ${displayPath}`,
          diff: buildDiffEntry(displayPath, "新建文件", "", input.content),
        };
      }
    },
  }),
  createTool({
    name: "write_file",
    description: "写入整个文件内容，适合明确覆盖整个文件时使用",
    schema: pathContentSchema,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        confirmed: { type: "boolean" },
      },
      required: ["path", "content"],
    },
    async execute(input) {
      const target = resolveAccessiblePath(input.path, input.confirmed);
      const displayPath = toDisplayPath(target);
      let before = "";
      try {
        before = await fs.readFile(target, "utf8");
      } catch {}
      await backupFile(target);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, input.content, "utf8");
      return {
        message: `已写入 ${displayPath}`,
        diff: buildDiffEntry(displayPath, "整文件写入", before, input.content),
      };
    },
  }),
  createTool({
    name: "append_text",
    description: "向文件末尾追加文本，适合补充内容",
    schema: pathContentSchema,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        confirmed: { type: "boolean" },
      },
      required: ["path", "content"],
    },
    async execute(input) {
      const target = resolveAccessiblePath(input.path, input.confirmed);
      const displayPath = toDisplayPath(target);
      const before = await fs.readFile(target, "utf8");
      await backupFile(target);
      await fs.appendFile(target, input.content, "utf8");
      const after = before + input.content;
      return {
        message: `已追加内容到 ${displayPath}`,
        diff: buildDiffEntry(displayPath, "末尾追加", before, after),
      };
    },
  }),
  createTool({
    name: "insert_after",
    description: "在指定锚点文本后插入内容，适合小范围新增代码",
    schema: insertSchema,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        anchorText: { type: "string" },
        content: { type: "string" },
        confirmed: { type: "boolean" },
      },
      required: ["path", "anchorText", "content"],
    },
    async execute(input) {
      const target = resolveAccessiblePath(input.path, input.confirmed);
      const displayPath = toDisplayPath(target);
      const source = await fs.readFile(target, "utf8");
      if (!source.includes(input.anchorText)) {
        throw new Error(`锚点文本未找到: ${displayPath}`);
      }
      await backupFile(target);
      const updated = source.replace(
        input.anchorText,
        `${input.anchorText}${input.content}`,
      );
      await fs.writeFile(target, updated, "utf8");
      return {
        message: `已在锚点后插入内容: ${displayPath}`,
        diff: buildDiffEntry(displayPath, "锚点插入", source, updated),
      };
    },
  }),
  createTool({
    name: "replace_range",
    description:
      "按 1-based 行号范围替换文件内容，适合 read_file 分页后做稳定局部编辑",
    schema: replaceRangeSchema,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: {
          type: "number",
          description: "起始行号，1-based，包含该行",
        },
        endLine: { type: "number", description: "结束行号，1-based，包含该行" },
        content: { type: "string", description: "用于替换指定行范围的新内容" },
        confirmed: { type: "boolean" },
      },
      required: ["path", "startLine", "endLine", "content"],
    },
    async execute(input) {
      const target = resolveAccessiblePath(input.path, input.confirmed);
      const displayPath = toDisplayPath(target);
      const source = await fs.readFile(target, "utf8");
      const updated = replaceLineRangeContent(source, input);
      await backupFile(target);
      await fs.writeFile(target, updated, "utf8");
      return {
        message: `已替换 ${displayPath} 第 ${input.startLine}-${input.endLine} 行`,
        diff: buildDiffEntry(displayPath, "行范围替换", source, updated),
      };
    },
  }),
  createTool({
    name: "replace_text",
    description: "在文件中做局部文本替换，适合最小改动",
    schema: replaceSchema,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
        confirmed: { type: "boolean" },
      },
      required: ["path", "oldText", "newText"],
    },
    async execute(input) {
      const target = resolveAccessiblePath(input.path, input.confirmed);
      const displayPath = toDisplayPath(target);
      const content = await fs.readFile(target, "utf8");
      if (!content.includes(input.oldText)) {
        throw new Error(`目标文本未找到: ${displayPath}`);
      }
      await backupFile(target);
      const updated = content.replaceAll(input.oldText, input.newText);
      await fs.writeFile(target, updated, "utf8");
      return {
        message: `已完成局部替换: ${displayPath}`,
        diff: buildDiffEntry(displayPath, "局部替换", content, updated),
      };
    },
  }),
];
