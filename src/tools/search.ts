import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { execa } from "execa";
import { z } from "zod";
import type { ToolDefinition } from "../types/agent.js";
import { createTool } from "./create-tool.js";

const MAX_MATCHES = 50;
const MAX_PROJECT_MAP_FILES = 40;
const DEFAULT_PROJECT_MAP_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".svelte",
  ".vue",
];
const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".backup",
  ".imports",
  "dist",
]);
const root = process.cwd();

type SearchMatch = {
  path: string;
  line: number;
  text: string;
  contextBefore?: string[];
  contextAfter?: string[];
};

type SearchFilters = {
  extensions: string[];
  includeGlobs: string[];
  excludeGlobs: string[];
  contextLines: number;
  maxResults: number;
};

type ProjectMapRole = "entry" | "core" | "leaf" | "module";

type ProjectMapEntry = {
  path: string;
  symbols: string[];
  relations: string[];
  importedBy: string[];
  role: ProjectMapRole;
  score: number;
};

function shouldSkipEntry(entryName: string): boolean {
  return (
    IGNORED_DIRECTORIES.has(entryName) ||
    entryName.startsWith(".") ||
    entryName.endsWith(".bak")
  );
}

function resolveSearchRoot(
  targetPath: string,
  confirmed = false,
): { fullPath: string; displayBase: string } {
  const fullPath = path.resolve(root, targetPath);
  const relativePath = path.relative(root, fullPath);
  const isOutsideWorkspace =
    relativePath.startsWith("..") || path.isAbsolute(relativePath);
  if (isOutsideWorkspace && !confirmed) {
    throw new Error("搜索工作区外目录前需要用户确认");
  }

  return {
    fullPath,
    displayBase: isOutsideWorkspace ? fullPath : relativePath || ".",
  };
}

function toDisplayPath(basePath: string, filePath: string): string {
  const relativePath = path.relative(basePath, filePath).replace(/\\/g, "/");
  if (relativePath && relativePath !== ".") {
    return relativePath;
  }
  return path.basename(filePath);
}

function normalizeGlob(glob: string): string {
  return glob.replace(/\\/g, "/").trim();
}

function normalizeExtension(extension: string): string {
  const trimmed = extension.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeGlob(pattern);
  let regex = "^";

  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === "*") {
      if (next === "*") {
        const afterNext = normalized[index + 2];
        if (afterNext === "/") {
          regex += "(?:.*/)?";
          index += 2;
        } else {
          regex += ".*";
          index += 1;
        }
      } else {
        regex += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      regex += "[^/]";
      continue;
    }

    if (char === "/") {
      regex += "\\/";
      continue;
    }

    if (/[$^+.()|{}[\]\\]/.test(char)) {
      regex += `\\${char}`;
      continue;
    }

    regex += char;
  }

  regex += "$";
  return new RegExp(regex);
}

function normalizeSearchFilters(input: {
  extensions?: string[];
  includeGlobs?: string[];
  excludeGlobs?: string[];
  contextLines?: number;
  maxResults?: number;
}): SearchFilters {
  const contextLines = Number.isFinite(input.contextLines)
    ? Math.max(0, Math.min(5, input.contextLines || 0))
    : 0;
  const maxResults = Number.isFinite(input.maxResults)
    ? Math.max(1, Math.min(200, input.maxResults || MAX_MATCHES))
    : MAX_MATCHES;

  return {
    extensions: Array.from(
      new Set((input.extensions || []).map(normalizeExtension).filter(Boolean)),
    ),
    includeGlobs: Array.from(
      new Set((input.includeGlobs || []).map(normalizeGlob).filter(Boolean)),
    ),
    excludeGlobs: Array.from(
      new Set((input.excludeGlobs || []).map(normalizeGlob).filter(Boolean)),
    ),
    contextLines,
    maxResults,
  };
}

function matchesGlobPattern(filePath: string, pattern: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, "/");
  return globToRegExp(pattern).test(normalizedPath);
}

function matchesSearchFilters(
  filePath: string,
  filters: SearchFilters,
): boolean {
  const normalizedPath = filePath.replace(/\\/g, "/");

  if (filters.extensions.length > 0) {
    const extension = path.extname(normalizedPath).toLowerCase();
    if (!filters.extensions.includes(extension)) {
      return false;
    }
  }

  if (
    filters.includeGlobs.length > 0 &&
    !filters.includeGlobs.some((pattern) =>
      matchesGlobPattern(normalizedPath, pattern),
    )
  ) {
    return false;
  }

  if (
    filters.excludeGlobs.some((pattern) =>
      matchesGlobPattern(normalizedPath, pattern),
    )
  ) {
    return false;
  }

  return true;
}

function buildContext(
  lines: string[],
  lineNumber: number,
  contextLines: number,
): { before?: string[]; after?: string[] } {
  if (contextLines <= 0) {
    return {};
  }

  const before = lines.slice(
    Math.max(0, lineNumber - contextLines - 1),
    Math.max(0, lineNumber - 1),
  );
  const after = lines.slice(lineNumber, lineNumber + contextLines);
  return {
    before: before.length > 0 ? before : undefined,
    after: after.length > 0 ? after : undefined,
  };
}

function scoreMatch(match: SearchMatch, query: string): number {
  const lowerQuery = query.toLowerCase();
  const lowerText = match.text.toLowerCase();
  const lowerPath = match.path.toLowerCase();
  let score = 0;

  if (lowerText === lowerQuery) {
    score += 10;
  }
  if (lowerText.startsWith(lowerQuery)) {
    score += 4;
  }
  if (path.basename(lowerPath).includes(lowerQuery)) {
    score += 3;
  }

  score += Math.max(0, 2 - match.line / 200);
  score += Math.max(0, 3 - lowerPath.split("/").length * 0.3);
  return score;
}

function sortMatches(matches: SearchMatch[], query: string): SearchMatch[] {
  return [...matches].sort((a, b) => {
    const scoreDelta = scoreMatch(b, query) - scoreMatch(a, query);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    const pathDelta = a.path.localeCompare(b.path);
    if (pathDelta !== 0) {
      return pathDelta;
    }
    return a.line - b.line;
  });
}

async function walk(
  dir: string,
  filters: SearchFilters,
  baseDir: string,
  result: string[] = [],
): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldSkipEntry(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, filters, baseDir, result);
    } else if (matchesSearchFilters(toDisplayPath(baseDir, full), filters)) {
      result.push(full);
    }
  }
  return result;
}

function parseRipgrepOutput(
  stdout: string,
  baseDir: string,
  filters: SearchFilters,
): SearchMatch[] {
  const matches: SearchMatch[] = [];

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line) as {
        type?: string;
        data?: {
          path?: { text?: string };
          line_number?: number;
          lines?: { text?: string };
        };
      };

      if (entry.type !== "match") continue;

      const matchPath = entry.data?.path?.text || "";
      if (!matchPath) continue;

      const displayPath = toDisplayPath(
        baseDir,
        path.resolve(baseDir, matchPath),
      );
      if (!matchesSearchFilters(displayPath, filters)) {
        continue;
      }

      matches.push({
        path: displayPath,
        line: entry.data?.line_number || 0,
        text: (entry.data?.lines?.text || "").trimEnd(),
      });
    } catch {}
  }

  return matches;
}

async function searchWithRipgrep(
  query: string,
  searchRoot: string,
  filters: SearchFilters,
): Promise<SearchMatch[]> {
  try {
    const result = await execa(
      "rg",
      [
        "--json",
        "--line-number",
        "--fixed-strings",
        "--ignore-case",
        "--glob",
        "!node_modules/**",
        "--glob",
        "!dist/**",
        "--glob",
        "!.backup/**",
        "--glob",
        "!.imports/**",
        "--glob",
        "!**/*.bak",
        query,
        ".",
      ],
      {
        cwd: searchRoot,
        reject: false,
      },
    );

    if (result.failed && result.code === "ENOENT") {
      return [];
    }

    const exitCode =
      result.exitCode ??
      (typeof result.code === "number" ? result.code : undefined);
    if (exitCode !== 0 && exitCode !== 1) {
      throw new Error(result.stderr || `rg 退出码: ${result.exitCode}`);
    }

    return sortMatches(
      parseRipgrepOutput(result.stdout, searchRoot, filters)
        .filter((match) => match.path && match.line > 0)
        .slice(0, filters.maxResults),
      query,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ENOENT")) {
      throw error;
    }
    return [];
  }
}

async function searchWithFallback(
  query: string,
  searchRoot: string,
  filters: SearchFilters,
): Promise<SearchMatch[]> {
  const lowerQuery = query.toLowerCase();
  const files = await walk(searchRoot, filters, searchRoot);
  const matches: SearchMatch[] = [];

  for (const file of files) {
    try {
      const content = await fs.readFile(file, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, index) => {
        if (line.toLowerCase().includes(lowerQuery)) {
          const context = buildContext(lines, index + 1, filters.contextLines);
          matches.push({
            path: toDisplayPath(searchRoot, file),
            line: index + 1,
            text: line.trim(),
            contextBefore: context.before,
            contextAfter: context.after,
          });
        }
      });
    } catch {
      continue;
    }

    if (matches.length >= filters.maxResults) break;
  }

  return sortMatches(matches.slice(0, filters.maxResults), query);
}

async function enrichMatchesWithContext(
  matches: SearchMatch[],
  searchRoot: string,
  contextLines: number,
): Promise<SearchMatch[]> {
  if (contextLines <= 0 || matches.length === 0) {
    return matches;
  }

  const byPath = new Map<string, SearchMatch[]>();
  for (const match of matches) {
    const bucket = byPath.get(match.path) || [];
    bucket.push(match);
    byPath.set(match.path, bucket);
  }

  for (const [displayPath, groupedMatches] of byPath) {
    const filePath = path.resolve(searchRoot, displayPath);
    try {
      const content = await fs.readFile(filePath, "utf8");
      const lines = content.split("\n");
      for (const match of groupedMatches) {
        const context = buildContext(lines, match.line, contextLines);
        match.contextBefore = context.before;
        match.contextAfter = context.after;
      }
    } catch {}
  }

  return matches;
}

function getScriptKind(filePath: string): ts.ScriptKind {
  switch (path.extname(filePath).toLowerCase()) {
    case ".ts":
      return ts.ScriptKind.TS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".js":
      return ts.ScriptKind.JS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".mts":
      return ts.ScriptKind.TS;
    case ".cts":
      return ts.ScriptKind.TS;
    case ".mjs":
      return ts.ScriptKind.JS;
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.Unknown;
  }
}

function extractTopLevelSymbolsWithAst(
  content: string,
  filePath = "file.ts",
): string[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath),
  );
  const symbols = new Set<string>();

  const addSymbol = (name: string | undefined) => {
    if (!name) return;
    symbols.add(name);
  };

  const addBindingName = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) {
      addSymbol(name.text);
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        addBindingName(element.name);
      }
    }
  };

  const hasExportModifier = (node: ts.Node) => {
    const maybeModifiers = (node as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
    return Boolean(
      maybeModifiers?.some(
        (modifier: ts.ModifierLike) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ),
    );
  };

  const hasSymbolLikeInitializer = (node: ts.VariableDeclaration) => {
    const initializer = node.initializer;
    return Boolean(
      initializer &&
        (ts.isArrowFunction(initializer) ||
          ts.isFunctionExpression(initializer) ||
          ts.isClassExpression(initializer)),
    );
  };

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      if (hasExportModifier(statement)) addSymbol(statement.name?.text);
    } else if (ts.isClassDeclaration(statement)) {
      if (hasExportModifier(statement)) addSymbol(statement.name?.text);
    } else if (ts.isInterfaceDeclaration(statement)) {
      if (hasExportModifier(statement)) addSymbol(statement.name.text);
    } else if (ts.isTypeAliasDeclaration(statement)) {
      if (hasExportModifier(statement)) addSymbol(statement.name.text);
    } else if (ts.isEnumDeclaration(statement)) {
      if (hasExportModifier(statement)) addSymbol(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      const shouldIncludeStatement = hasExportModifier(statement);
      for (const declaration of statement.declarationList.declarations) {
        if (shouldIncludeStatement || hasSymbolLikeInitializer(declaration)) {
          addBindingName(declaration.name);
        }
      }
    } else if (ts.isExportDeclaration(statement) && statement.exportClause) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          addSymbol(element.name.text);
        }
      }
    }
    if (symbols.size >= 12) {
      return Array.from(symbols);
    }
  }

  return Array.from(symbols);
}

function extractTopLevelSymbols(content: string, filePath = "file.ts"): string[] {
  if (getScriptKind(filePath) !== ts.ScriptKind.Unknown) {
    const astSymbols = extractTopLevelSymbolsWithAst(content, filePath);
    if (astSymbols.length > 0) {
      return astSymbols;
    }
  }

  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function\b)/g,
    /export\s+class\s+([A-Za-z_$][\w$]*)/g,
    /export\s+interface\s+([A-Za-z_$][\w$]*)/g,
    /export\s+type\s+([A-Za-z_$][\w$]*)/g,
    /export\s+enum\s+([A-Za-z_$][\w$]*)/g,
  ];
  const symbols = new Set<string>();
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      symbols.add(match[1]);
      if (symbols.size >= 12) {
        return Array.from(symbols);
      }
    }
  }
  return Array.from(symbols);
}

function extractRelationsWithAst(
  content: string,
  filePath = "file.ts",
): string[] {
  if (getScriptKind(filePath) === ts.ScriptKind.Unknown) {
    return [];
  }
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath),
  );
  const relations = new Set<string>();

  const addRelation = (specifier: string | undefined) => {
    if (!specifier) return;
    if (!specifier.startsWith(".")) return;
    relations.add(specifier);
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      addRelation(statement.moduleSpecifier.getText(sourceFile).slice(1, -1));
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      addRelation(statement.moduleSpecifier.getText(sourceFile).slice(1, -1));
    }
    if (relations.size >= 8) {
      return Array.from(relations);
    }
  }

  return Array.from(relations);
}

function resolveProjectRelation(
  fromPath: string,
  relation: string,
): string {
  const baseDir = path.posix.dirname(fromPath);
  return path.posix.normalize(path.posix.join(baseDir, relation));
}

function getProjectMapRole(
  filePath: string,
  relations: string[],
  importedBy: string[],
): ProjectMapRole {
  const normalizedPath = filePath.replace(/\\/g, "/");
  if (/\/(index|main|app|server|client|cli)\.[^.]+$/.test(normalizedPath)) {
    return "entry";
  }
  if (relations.length > 0 && importedBy.length > 0) {
    return "core";
  }
  if (relations.length === 0 && importedBy.length > 0) {
    return "leaf";
  }
  return "module";
}

function scoreProjectMapEntry(
  filePath: string,
  symbols: string[],
  relations: string[] = [],
  importedBy: string[] = [],
  role: ProjectMapRole = "module",
): number {
  const normalizedPath = filePath.replace(/\\/g, "/");
  let score = Math.max(1, 12 - normalizedPath.split("/").length);
  if (/\/index\.[^.]+$/.test(normalizedPath)) score += 3;
  if (/\/(cli|agent|tools|llm)\//.test(normalizedPath)) score += 2;
  if (symbols.length > 0) score += Math.min(6, symbols.length);
  if (relations.length > 0) score += Math.min(4, relations.length);
  if (importedBy.length > 0) score += Math.min(4, importedBy.length);
  if (role === "entry") score += 3;
  if (role === "core") score += 4;
  if (role === "leaf") score += 2;
  return score;
}

async function buildProjectMap(
  targetPath: string,
  confirmed = false,
  maxFiles = MAX_PROJECT_MAP_FILES,
): Promise<ProjectMapEntry[]> {
  const resolved = resolveSearchRoot(targetPath, confirmed);
  const filters = normalizeSearchFilters({
    extensions: DEFAULT_PROJECT_MAP_EXTENSIONS,
    maxResults: maxFiles,
  });
  const files = await walk(resolved.fullPath, filters, resolved.fullPath);
  const entries: ProjectMapEntry[] = [];

  for (const file of files) {
    try {
      const content = await fs.readFile(file, "utf8");
      const displayPath = toDisplayPath(resolved.fullPath, file);
      const symbols = extractTopLevelSymbols(content, file);
      const relations = extractRelationsWithAst(content, file);
      entries.push({
        path: displayPath,
        symbols,
        relations,
        importedBy: [],
        role: "module",
        score: 0,
      });
    } catch {
      continue;
    }
  }

  const pathSet = new Set(entries.map((entry) => entry.path));
  const importedByMap = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (const relation of entry.relations) {
      const resolvedRelation = resolveProjectRelation(entry.path, relation);
      for (const candidate of [resolvedRelation, `${resolvedRelation}.ts`, `${resolvedRelation}.tsx`, `${resolvedRelation}.js`, `${resolvedRelation}.jsx`, `${resolvedRelation}/index.ts`, `${resolvedRelation}/index.js`]) {
        if (!pathSet.has(candidate)) continue;
        const bucket = importedByMap.get(candidate) || new Set<string>();
        bucket.add(entry.path);
        importedByMap.set(candidate, bucket);
        break;
      }
    }
  }

  for (const entry of entries) {
    entry.importedBy = Array.from(importedByMap.get(entry.path) || []).sort();
    entry.role = getProjectMapRole(entry.path, entry.relations, entry.importedBy);
    entry.score = scoreProjectMapEntry(
      entry.path,
      entry.symbols,
      entry.relations,
      entry.importedBy,
      entry.role,
    );
  }

  return entries
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, maxFiles);
}

export type { ProjectMapEntry, SearchFilters, SearchMatch };
export {
  buildContext,
  buildProjectMap,
  extractRelationsWithAst,
  extractTopLevelSymbols,
  extractTopLevelSymbolsWithAst,
  getProjectMapRole,
  globToRegExp,
  matchesGlobPattern,
  matchesSearchFilters,
  normalizeExtension,
  normalizeGlob,
  normalizeSearchFilters,
  parseRipgrepOutput,
  scoreMatch,
  scoreProjectMapEntry,
  shouldSkipEntry,
  sortMatches,
};

export const searchTools: ToolDefinition[] = [
  createTool({
    name: "search_text",
    description:
      "在文本文件中搜索关键词；可指定工作区内或确认后的工作区外目录范围，并支持文件类型、glob 过滤、上下文和结果数限制",
    schema: z.object({
      query: z.string().min(1, "搜索关键词不能为空"),
      path: z.string().optional(),
      extensions: z.array(z.string()).optional(),
      includeGlobs: z.array(z.string()).optional(),
      excludeGlobs: z.array(z.string()).optional(),
      contextLines: z.number().int().min(0).max(5).optional(),
      maxResults: z.number().int().min(1).max(200).optional(),
      confirmed: z.boolean().optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: {
          type: "string",
          description: "可选，限定搜索目录，默认当前工作区",
        },
        extensions: {
          type: "array",
          items: { type: "string" },
          description: "可选，只搜索指定后缀，如 ['ts', '.md']",
        },
        includeGlobs: {
          type: "array",
          items: { type: "string" },
          description:
            "可选，仅包含匹配这些 glob 的文件，如 ['src/**', '**/*.test.ts']",
        },
        excludeGlobs: {
          type: "array",
          items: { type: "string" },
          description: "可选，排除匹配这些 glob 的文件，如 ['**/fixtures/**']",
        },
        contextLines: {
          type: "number",
          description: "可选，每条命中前后额外返回多少行上下文，范围 0-5",
        },
        maxResults: {
          type: "number",
          description: "可选，最多返回多少条命中，范围 1-200",
        },
        confirmed: {
          type: "boolean",
          description: "仅当用户已明确确认搜索工作区外目录时才传 true",
        },
      },
      required: ["query"],
    },
    async execute(input) {
      const resolved = resolveSearchRoot(input.path || ".", input.confirmed);
      const filters = normalizeSearchFilters({
        extensions: input.extensions,
        includeGlobs: input.includeGlobs,
        excludeGlobs: input.excludeGlobs,
        contextLines: input.contextLines,
        maxResults: input.maxResults,
      });
      const rgMatches = await searchWithRipgrep(
        input.query,
        resolved.fullPath,
        filters,
      );
      const matches =
        rgMatches.length > 0
          ? rgMatches
          : await searchWithFallback(input.query, resolved.fullPath, filters);
      const enrichedMatches = await enrichMatchesWithContext(
        matches,
        resolved.fullPath,
        filters.contextLines,
      );
      return JSON.stringify(enrichedMatches, null, 2);
    },
  }),
  createTool({
    name: "project_map",
    description:
      "生成项目结构地图，返回关键源码文件及其顶层符号，帮助快速理解仓库结构；可限定目录范围",
    schema: z.object({
      path: z.string().optional(),
      maxFiles: z.number().int().min(1).max(100).optional(),
      confirmed: z.boolean().optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "可选，限定生成项目地图的目录，默认当前工作区",
        },
        maxFiles: {
          type: "number",
          description: "可选，最多返回多少个关键文件，范围 1-100",
        },
        confirmed: {
          type: "boolean",
          description: "仅当用户已明确确认读取工作区外目录时才传 true",
        },
      },
    },
    async execute(input) {
      const entries = await buildProjectMap(
        input.path || ".",
        input.confirmed,
        input.maxFiles,
      );
      return JSON.stringify(entries, null, 2);
    },
  }),
];
