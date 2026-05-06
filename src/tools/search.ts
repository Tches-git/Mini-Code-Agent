import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import ts from "typescript";
import { z } from "zod";
import type { ToolDefinition } from "../types/agent.js";
import { getWorkspaceRoot, getWorkspaceStateDir } from "../utils/runtime.js";
import { createTool } from "./create-tool.js";

const MAX_MATCHES = 50;
const MAX_GLOB_FILES = 100;
const MAX_PROJECT_MAP_FILES = 40;
const MAX_PROJECT_MAP_SCAN_FILES = 160;
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
function getRoot(): string {
  return getWorkspaceRoot();
}

type SearchMatch = {
  path: string;
  line: number;
  text: string;
  query?: string;
  contextBefore?: string[];
  contextAfter?: string[];
};

type SearchResultMatch = {
  path: string;
  text: string;
  line?: number;
  query?: string;
  contextBefore?: string[];
  contextAfter?: string[];
};

type SearchResultFile = {
  path: string;
  matchCount: number;
  matches: SearchResultMatch[];
};

type SearchTextResult = {
  queries: string[];
  totalMatches: number;
  returnedMatches: number;
  resultOffset: number;
  truncated: boolean;
  maxResults: number;
  nextOffset?: number;
  matches?: SearchResultMatch[];
  files?: SearchResultFile[];
};

type SearchFilters = {
  extensions: string[];
  includeGlobs: string[];
  excludeGlobs: string[];
  contextLines: number;
  maxResults: number;
};

type GlobFilesOptions = {
  pattern: string;
  path?: string;
  extensions?: string[];
  excludeGlobs?: string[];
  maxResults?: number;
  confirmed?: boolean;
};

type TextSearchOptions = {
  regex?: boolean;
  caseSensitive?: boolean;
  includeLineNumbers?: boolean;
  groupByFile?: boolean;
  matchMode?: "any" | "all";
  resultOffset?: number;
};

type ProjectMapRole = "entry" | "core" | "leaf" | "module";

type ProjectMapReference = {
  symbol: string;
  importedBy: string[];
};

type ProjectCallEdge = {
  caller: string;
  callee: string;
  via: string;
  receiver?: string;
};

type ProjectMapEntry = {
  path: string;
  symbols: string[];
  relations: string[];
  dependsOn: string[];
  externalDeps: string[];
  importedBy: string[];
  references: ProjectMapReference[];
  calls: string[];
  comments: string[];
  callEdges: ProjectCallEdge[];
  role: ProjectMapRole;
  score: number;
};

type ProjectMapBuildOptions = {
  maxFiles?: number;
  scanLimit?: number;
  useCache?: boolean;
};

type SemanticFinderOptions = {
  concept: string;
  path?: string;
  maxResults?: number;
  confirmed?: boolean;
  useCache?: boolean;
  embedding?: boolean;
  embeddingMode?: "tokens" | "vector";
};

type SemanticFinderResult = {
  concept: string;
  returnedResults: number;
  cache: "hit" | "miss" | "disabled";
  embedding: "disabled" | "fallback" | "provider";
  tokens: string[];
  results: Array<{
    path: string;
    score: number;
    role: ProjectMapRole;
    symbols: string[];
    calls: string[];
    comments: string[];
    callEdges: ProjectCallEdge[];
    reasons: string[];
  }>;
};

type ProjectMapCachePayload = {
  version: number;
  root: string;
  signature: string;
  entries: ProjectMapEntry[];
};

type SemanticVectorCachePayload = {
  version: number;
  root: string;
  provider: string;
  entries: Record<string, { textHash: string; vector: number[] }>;
};

type SemanticEmbeddingProvider = (concept: string) => Promise<string[]>;
type SemanticVectorProvider = (text: string) => Promise<number[]>;

type ImportBinding = {
  imported: string;
  local: string;
};

type SemanticEmbeddingModule = {
  embedConcept?: SemanticEmbeddingProvider;
  embedVector?: SemanticVectorProvider;
  default?:
    | SemanticEmbeddingProvider
    | {
        embedConcept?: SemanticEmbeddingProvider;
        embedVector?: SemanticVectorProvider;
      };
};

let lastProjectMapCacheStatus: "hit" | "miss" | "disabled" = "disabled";

function getProjectMapCachePath(targetPath: string): string {
  const key = createHash("sha1").update(path.resolve(targetPath)).digest("hex");
  return path.join(getWorkspaceStateDir(), "semantic-index", `${key}.json`);
}

function getVectorCachePath(targetPath: string, providerId: string): string {
  const key = createHash("sha1")
    .update(`${path.resolve(targetPath)}\n${providerId}`)
    .digest("hex");
  return path.join(getWorkspaceStateDir(), "semantic-vectors", `${key}.json`);
}

function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

async function getProjectMapSignature(files: string[]): Promise<string> {
  const parts: string[] = [];
  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      parts.push(`${file}:${stat.size}:${Math.trunc(stat.mtimeMs)}`);
    } catch {}
  }
  return createHash("sha1").update(parts.sort().join("\n")).digest("hex");
}

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
  const root = getRoot();
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

function compileSearchRegex(query: string, caseSensitive?: boolean): RegExp {
  try {
    return new RegExp(query, caseSensitive ? "" : "i");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无效正则表达式 "${query}": ${detail}`);
  }
}

function getSearchLineMatcher(query: string, options: TextSearchOptions = {}) {
  if (!options.regex) {
    const needle = options.caseSensitive ? query : query.toLowerCase();
    return (line: string) =>
      (options.caseSensitive ? line : line.toLowerCase()).includes(needle);
  }

  const regex = compileSearchRegex(query, options.caseSensitive);
  return (line: string) => regex.test(line);
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

function normalizeGlobMaxResults(maxResults?: number): number {
  return Number.isFinite(maxResults)
    ? Math.max(1, Math.min(500, maxResults || MAX_GLOB_FILES))
    : MAX_GLOB_FILES;
}

async function globFiles(options: GlobFilesOptions): Promise<string[]> {
  const resolved = resolveSearchRoot(options.path || ".", options.confirmed);
  const maxResults = normalizeGlobMaxResults(options.maxResults);
  const filters = normalizeSearchFilters({
    extensions: options.extensions,
    includeGlobs: [options.pattern],
    excludeGlobs: options.excludeGlobs,
    maxResults,
  });
  const files = await walk(resolved.fullPath, filters, resolved.fullPath, [], {
    limit: maxResults,
  });

  return files.map((file) => toDisplayPath(resolved.fullPath, file)).sort();
}

async function walk(
  dir: string,
  filters: SearchFilters,
  baseDir: string,
  result: string[] = [],
  options?: { limit?: number },
): Promise<string[]> {
  if (options?.limit && result.length >= options.limit) {
    return result;
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const sortedEntries = [...entries].sort((a, b) => {
    const aDirRank = a.isDirectory() ? 1 : 0;
    const bDirRank = b.isDirectory() ? 1 : 0;
    return aDirRank - bDirRank || a.name.localeCompare(b.name);
  });

  for (const entry of sortedEntries) {
    if (shouldSkipEntry(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, filters, baseDir, result, options);
    } else if (matchesSearchFilters(toDisplayPath(baseDir, full), filters)) {
      result.push(full);
    }

    if (options?.limit && result.length >= options.limit) {
      break;
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
  options: TextSearchOptions = {},
): Promise<SearchMatch[]> {
  if (options.regex) {
    compileSearchRegex(query, options.caseSensitive);
  }

  try {
    const result = await execa(
      "rg",
      [
        "--json",
        "--line-number",
        ...(options.regex ? [] : ["--fixed-strings"]),
        ...(options.caseSensitive ? [] : ["--ignore-case"]),
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
      if (options.regex) {
        throw new Error(
          `无效正则表达式 "${query}": ${result.stderr || `rg 退出码: ${result.exitCode}`}`,
        );
      }
      throw new Error(result.stderr || `rg 退出码: ${result.exitCode}`);
    }

    return sortMatches(
      parseRipgrepOutput(result.stdout, searchRoot, filters).filter(
        (match) => match.path && match.line > 0,
      ),
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
  options: TextSearchOptions = {},
): Promise<SearchMatch[]> {
  const matchesLine = getSearchLineMatcher(query, options);
  const files = await walk(searchRoot, filters, searchRoot);
  const matches: SearchMatch[] = [];

  for (const file of files) {
    try {
      const content = await fs.readFile(file, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, index) => {
        if (matchesLine(line)) {
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
    } catch {}
  }

  return sortMatches(matches, query);
}

function uniqueSearchQueries(query: string, queries?: string[]): string[] {
  return Array.from(
    new Set(
      [query, ...(queries || [])].map((item) => item.trim()).filter(Boolean),
    ),
  );
}

function dedupeSearchMatches(matches: SearchMatch[]): SearchMatch[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = `${match.path}\0${match.line}\0${match.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function filterMatchesByMode(
  matches: SearchMatch[],
  queries: string[],
  mode: "any" | "all" = "any",
): SearchMatch[] {
  if (mode !== "all" || queries.length <= 1) return matches;
  const matchedQueriesByLocation = new Map<string, Set<string>>();
  for (const match of matches) {
    const key = `${match.path}\0${match.line}`;
    const querySet = matchedQueriesByLocation.get(key) || new Set<string>();
    if (match.query) querySet.add(match.query);
    matchedQueriesByLocation.set(key, querySet);
  }
  return matches.filter((match) => {
    const querySet = matchedQueriesByLocation.get(
      `${match.path}\0${match.line}`,
    );
    return queries.every((query) => querySet?.has(query));
  });
}

function formatSearchTextResult(
  matches: SearchMatch[],
  queries: string[],
  filters: SearchFilters,
  options: TextSearchOptions = {},
  totalMatches = matches.length,
): SearchTextResult {
  const resultOffset = Math.max(0, options.resultOffset || 0);
  const returnedMatches = matches.slice(
    resultOffset,
    resultOffset + filters.maxResults,
  );
  const toResultMatch = (match: SearchMatch): SearchResultMatch => {
    const result: SearchResultMatch = {
      path: match.path,
      text: match.text,
      query: match.query,
      contextBefore: match.contextBefore,
      contextAfter: match.contextAfter,
    };
    if (options.includeLineNumbers !== false) {
      result.line = match.line;
    }
    if (queries.length <= 1) {
      delete result.query;
    }
    return result;
  };
  const nextOffset = resultOffset + returnedMatches.length;
  const result: SearchTextResult = {
    queries,
    totalMatches,
    returnedMatches: returnedMatches.length,
    resultOffset,
    truncated: totalMatches > nextOffset,
    maxResults: filters.maxResults,
    nextOffset: totalMatches > nextOffset ? nextOffset : undefined,
  };

  if (!options.groupByFile) {
    result.matches = returnedMatches.map(toResultMatch);
    return result;
  }

  const files = new Map<string, SearchResultMatch[]>();
  for (const match of returnedMatches) {
    const bucket = files.get(match.path) || [];
    bucket.push(toResultMatch(match));
    files.set(match.path, bucket);
  }
  result.files = Array.from(files.entries()).map(([filePath, fileMatches]) => ({
    path: filePath,
    matchCount: fileMatches.length,
    matches: fileMatches,
  }));
  return result;
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
    const maybeModifiers = (
      node as { modifiers?: ts.NodeArray<ts.ModifierLike> }
    ).modifiers;
    return Boolean(
      maybeModifiers?.some(
        (modifier: ts.ModifierLike) =>
          modifier.kind === ts.SyntaxKind.ExportKeyword,
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

function extractTopLevelSymbols(
  content: string,
  filePath = "file.ts",
): string[] {
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

function parseSourceFile(
  content: string,
  filePath = "file.ts",
): ts.SourceFile | null {
  const scriptKind = getScriptKind(filePath);
  if (scriptKind === ts.ScriptKind.Unknown) {
    return null;
  }
  return ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
}

function extractRelationsWithAst(
  content: string,
  filePath = "file.ts",
): string[] {
  const sourceFile = parseSourceFile(content, filePath);
  if (!sourceFile) {
    return [];
  }
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

function extractImportedSymbolsWithAst(
  content: string,
  filePath = "file.ts",
): Array<{ specifier: string; symbols: string[]; bindings: ImportBinding[] }> {
  const sourceFile = parseSourceFile(content, filePath);
  if (!sourceFile) {
    return [];
  }
  const imports: Array<{
    specifier: string;
    symbols: string[];
    bindings: ImportBinding[];
  }> = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier
        .getText(sourceFile)
        .slice(1, -1);
      if (!specifier.startsWith(".")) continue;
      const symbols: string[] = [];
      const bindings: ImportBinding[] = [];
      const clause = statement.importClause;
      if (clause?.name) {
        symbols.push(clause.name.text);
        bindings.push({ imported: "default", local: clause.name.text });
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const imported = element.propertyName?.text || element.name.text;
          symbols.push(imported);
          bindings.push({ imported, local: element.name.text });
        }
      } else if (
        clause?.namedBindings &&
        ts.isNamespaceImport(clause.namedBindings)
      ) {
        bindings.push({ imported: "*", local: clause.namedBindings.name.text });
      }
      imports.push({ specifier, symbols, bindings });
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      const specifier = statement.moduleSpecifier
        .getText(sourceFile)
        .slice(1, -1);
      if (!specifier.startsWith(".")) continue;
      const symbols: string[] = [];
      const bindings: ImportBinding[] = [];
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const imported = element.propertyName?.text || element.name.text;
          symbols.push(imported);
          bindings.push({ imported, local: element.name.text });
        }
      }
      imports.push({ specifier, symbols, bindings });
    }
  }

  return imports;
}

function extractAstCallsAndComments(
  content: string,
  filePath = "file.ts",
): { calls: string[]; comments: string[]; localCallEdges: ProjectCallEdge[] } {
  const sourceFile = parseSourceFile(content, filePath);
  const comments = Array.from(
    content.matchAll(/\/\/\s*(.+)|\/\*([\s\S]*?)\*\//g),
  )
    .map((match) => (match[1] || match[2] || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 12);
  if (!sourceFile) {
    return { calls: [], comments, localCallEdges: [] };
  }

  const calls = new Set<string>();
  const localCallEdges: ProjectCallEdge[] = [];
  let currentCaller = "<module>";
  const addCall = (name: string | undefined) => {
    if (!name) return;
    calls.add(name);
  };
  const getFunctionName = (node: ts.Node): string | null => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name
    ) {
      return node.name.text;
    }
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      return node.name.text;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    ) {
      return node.name.text;
    }
    return null;
  };
  const getCallInfo = (
    node: ts.CallExpression,
  ): { name: string; receiver?: string } | null => {
    const expression = node.expression;
    if (ts.isIdentifier(expression)) return { name: expression.text };
    if (ts.isPropertyAccessExpression(expression)) {
      return {
        name: expression.name.text,
        receiver: ts.isIdentifier(expression.expression)
          ? expression.expression.text
          : undefined,
      };
    }
    return null;
  };
  const visit = (node: ts.Node) => {
    const nextCaller = getFunctionName(node);
    const previousCaller = currentCaller;
    if (nextCaller) currentCaller = nextCaller;
    if (ts.isCallExpression(node)) {
      const callInfo = getCallInfo(node);
      addCall(callInfo?.name);
      if (callInfo) {
        localCallEdges.push({
          caller: currentCaller,
          callee: callInfo.name,
          via: "local",
          ...(callInfo.receiver ? { receiver: callInfo.receiver } : {}),
        });
      }
    }
    if (calls.size < 40) {
      ts.forEachChild(node, visit);
    }
    currentCaller = previousCaller;
  };
  visit(sourceFile);
  return {
    calls: Array.from(calls).sort().slice(0, 40),
    comments,
    localCallEdges: localCallEdges.slice(0, 80),
  };
}

function extractExternalDependenciesWithAst(
  content: string,
  filePath = "file.ts",
): string[] {
  const sourceFile = parseSourceFile(content, filePath);
  if (!sourceFile) {
    return [];
  }
  const dependencies = new Set<string>();

  const addDependency = (specifier: string | undefined) => {
    if (!specifier || specifier.startsWith(".")) return;
    dependencies.add(specifier);
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      addDependency(statement.moduleSpecifier.getText(sourceFile).slice(1, -1));
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      addDependency(statement.moduleSpecifier.getText(sourceFile).slice(1, -1));
    }
    if (dependencies.size >= 12) {
      return Array.from(dependencies).sort();
    }
  }

  return Array.from(dependencies).sort();
}

function resolveProjectRelation(fromPath: string, relation: string): string {
  const baseDir = path.posix.dirname(fromPath);
  return path.posix.normalize(path.posix.join(baseDir, relation));
}

function resolveCandidatePath(
  pathSet: Set<string>,
  fromPath: string,
  relation: string,
): string | null {
  const resolvedRelation = resolveProjectRelation(fromPath, relation);
  for (const candidate of [
    resolvedRelation,
    `${resolvedRelation}.ts`,
    `${resolvedRelation}.tsx`,
    `${resolvedRelation}.js`,
    `${resolvedRelation}.jsx`,
    `${resolvedRelation}/index.ts`,
    `${resolvedRelation}/index.js`,
  ]) {
    if (pathSet.has(candidate)) return candidate;
  }
  return null;
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
  externalDeps: string[] = [],
): number {
  const normalizedPath = filePath.replace(/\\/g, "/");
  let score = Math.max(1, 12 - normalizedPath.split("/").length);
  if (/\/index\.[^.]+$/.test(normalizedPath)) score += 3;
  if (/\/(cli|agent|tools|llm)\//.test(normalizedPath)) score += 2;
  if (
    /\/(package|tsconfig|vite|vitest|jest|eslint|biome|webpack|rollup|babel)(\.|$)/.test(
      normalizedPath,
    )
  ) {
    score += 3;
  }
  if (/\/(index|main|app|server|client|cli)\.[^.]+$/.test(normalizedPath)) {
    score += 2;
  }
  if (symbols.length > 0) score += Math.min(6, symbols.length);
  if (relations.length > 0) score += Math.min(4, relations.length);
  if (importedBy.length > 0) score += Math.min(4, importedBy.length);
  if (externalDeps.length > 0) score += Math.min(3, externalDeps.length);
  if (role === "entry") score += 3;
  if (role === "core") score += 4;
  if (role === "leaf") score += 2;
  return score;
}

function tokenizeConcept(concept: string): string[] {
  const expanded = concept
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
  const rawTokens = expanded
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  const stemmedTokens = rawTokens.flatMap((token) => [
    token,
    token.endsWith("s") && token.length > 3 ? token.slice(0, -1) : "",
    token.endsWith("ing") && token.length > 5 ? token.slice(0, -3) : "",
    token.endsWith("ed") && token.length > 4 ? token.slice(0, -2) : "",
  ]);
  return Array.from(new Set(stemmedTokens.filter(Boolean)));
}

function getEmbeddingTokens(concept: string): string[] {
  const aliases: Record<string, string[]> = {
    auth: ["approval", "policy", "token", "login"],
    restore: ["resume", "session", "load"],
    resume: ["restore", "session", "load"],
    validation: ["test", "lint", "build", "diagnostics", "check"],
    sandbox: ["worktree", "patch", "apply", "branch"],
    memory: ["remember", "summary", "preference", "context"],
    approval: ["confirm", "policy", "guard", "permission"],
    command: ["shell", "bash", "run", "execute"],
    task: ["todo", "plan", "graph", "subtask"],
  };
  return Array.from(
    new Set(
      tokenizeConcept(concept).flatMap((token) => [
        token,
        ...(aliases[token] || []),
      ]),
    ),
  );
}

async function importSemanticEmbeddingModule(): Promise<SemanticEmbeddingModule | null> {
  const providerPath = process.env.SEMANTIC_EMBEDDING_PROVIDER?.trim();
  if (!providerPath) return null;
  try {
    const modulePath = path.isAbsolute(providerPath)
      ? pathToFileURL(providerPath).href
      : providerPath;
    return (await import(modulePath)) as SemanticEmbeddingModule;
  } catch {
    return null;
  }
}

function getVectorProvider(
  mod: SemanticEmbeddingModule | null,
): SemanticVectorProvider | null {
  if (!mod) return null;
  if (mod.embedVector) return mod.embedVector;
  if (typeof mod.default === "object" && mod.default?.embedVector) {
    return mod.default.embedVector;
  }
  return null;
}

async function getProviderEmbeddingTokens(
  concept: string,
): Promise<string[] | null> {
  try {
    const mod = await importSemanticEmbeddingModule();
    const provider =
      mod?.embedConcept ||
      (typeof mod?.default === "function"
        ? mod.default
        : mod?.default?.embedConcept);
    if (!provider) return null;
    const tokens = await provider(concept);
    return Array.isArray(tokens) ? tokens.flatMap(tokenizeConcept) : null;
  } catch {
    return null;
  }
}

async function getSemanticTokens(
  concept: string,
  embedding?: boolean,
): Promise<{ tokens: string[]; mode: SemanticFinderResult["embedding"] }> {
  if (!embedding) return { tokens: tokenizeConcept(concept), mode: "disabled" };
  const providerTokens = await getProviderEmbeddingTokens(concept);
  if (providerTokens?.length) {
    return {
      tokens: Array.from(
        new Set([...tokenizeConcept(concept), ...providerTokens]),
      ),
      mode: "provider",
    };
  }
  return { tokens: getEmbeddingTokens(concept), mode: "fallback" };
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < length; index++) {
    dot += a[index] * b[index];
    aNorm += a[index] * a[index];
    bNorm += b[index] * b[index];
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function getEntryVectorText(entry: ProjectMapEntry): string {
  return [
    entry.path,
    entry.role,
    entry.symbols.join(" "),
    entry.calls.join(" "),
    entry.comments.join(" "),
    entry.dependsOn.join(" "),
    entry.importedBy.join(" "),
    entry.references.map((ref) => ref.symbol).join(" "),
  ].join(" ");
}

async function readVectorCache(
  cachePath: string,
  targetPath: string,
  providerId: string,
): Promise<SemanticVectorCachePayload> {
  try {
    const cached = JSON.parse(
      await fs.readFile(cachePath, "utf8"),
    ) as SemanticVectorCachePayload;
    if (
      cached.version === 1 &&
      cached.root === path.resolve(targetPath) &&
      cached.provider === providerId
    ) {
      return cached;
    }
  } catch {}
  return {
    version: 1,
    root: path.resolve(targetPath),
    provider: providerId,
    entries: {},
  };
}

async function writeVectorCache(
  cachePath: string,
  cache: SemanticVectorCachePayload,
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), "utf8");
  } catch {}
}

async function scoreVectorEntries(
  concept: string,
  entries: ProjectMapEntry[],
  options?: { targetPath?: string; useCache?: boolean },
): Promise<Map<string, { score: number; reason: string }> | null> {
  const providerPath = process.env.SEMANTIC_EMBEDDING_PROVIDER?.trim();
  const provider = getVectorProvider(await importSemanticEmbeddingModule());
  if (!provider) return null;
  try {
    const conceptVector = await provider(concept);
    const scored = new Map<string, { score: number; reason: string }>();
    const targetPath = options?.targetPath || ".";
    const providerId = providerPath || "default";
    const cachePath = getVectorCachePath(targetPath, providerId);
    const useCache = options?.useCache !== false;
    const cache = useCache
      ? await readVectorCache(cachePath, targetPath, providerId)
      : null;
    let cacheChanged = false;

    for (const entry of entries) {
      const text = getEntryVectorText(entry);
      const textHash = hashText(text);
      const cachedEntry = cache?.entries[entry.path];
      const vector =
        cachedEntry?.textHash === textHash
          ? cachedEntry.vector
          : await provider(text);
      if (cache && cachedEntry?.textHash !== textHash) {
        cache.entries[entry.path] = { textHash, vector };
        cacheChanged = true;
      }
      const similarity = cosineSimilarity(conceptVector, vector);
      if (similarity > 0) {
        scored.set(entry.path, {
          score: similarity * 20,
          reason: `vector similarity ${similarity.toFixed(2)}`,
        });
      }
    }
    if (cache && cacheChanged) {
      await writeVectorCache(cachePath, cache);
    }
    return scored;
  } catch {
    return null;
  }
}

function scoreSemanticEntry(
  entry: ProjectMapEntry,
  tokens: string[],
): {
  score: number;
  reasons: string[];
} {
  const haystacks = [
    { label: "path", value: entry.path },
    { label: "symbol", value: entry.symbols.join(" ") },
    { label: "dependency", value: entry.dependsOn.join(" ") },
    { label: "external", value: entry.externalDeps.join(" ") },
    { label: "call", value: entry.calls.join(" ") },
    { label: "comment", value: entry.comments.join(" ") },
    {
      label: "reference",
      value: entry.references.map((ref) => ref.symbol).join(" "),
    },
    {
      label: "callGraph",
      value: entry.callEdges
        .map((edge) => `${edge.caller} ${edge.callee} ${edge.via}`)
        .join(" "),
    },
    { label: "role", value: entry.role },
  ];
  let score = 0;
  const reasons: string[] = [];
  for (const token of tokens) {
    for (const haystack of haystacks) {
      if (haystack.value.toLowerCase().includes(token)) {
        score +=
          haystack.label === "symbol"
            ? 5
            : haystack.label === "path" || haystack.label === "call"
              ? 4
              : haystack.label === "comment" ||
                  haystack.label === "reference" ||
                  haystack.label === "callGraph"
                ? 3
                : 2;
        reasons.push(`${haystack.label} matches ${token}`);
      }
    }
  }
  score += Math.min(4, entry.importedBy.length);
  score += entry.role === "entry" || entry.role === "core" ? 2 : 0;
  return { score, reasons: Array.from(new Set(reasons)).slice(0, 8) };
}

async function semanticFind(
  options: SemanticFinderOptions,
): Promise<SemanticFinderResult> {
  const maxResults = Number.isFinite(options.maxResults)
    ? Math.max(1, Math.min(20, options.maxResults || 10))
    : 10;
  const { tokens, mode } = await getSemanticTokens(
    options.concept,
    options.embedding,
  );
  const entries = await buildProjectMap(
    options.path || ".",
    options.confirmed,
    {
      maxFiles: Math.max(40, maxResults * 4),
      scanLimit: 240,
      useCache: options.useCache !== false,
    },
  );
  const vectorScores =
    options.embedding && options.embeddingMode === "vector"
      ? await scoreVectorEntries(options.concept, entries, {
          targetPath: options.path || ".",
          useCache: options.useCache,
        })
      : null;
  const ranked = entries
    .map((entry) => {
      const scored = scoreSemanticEntry(entry, tokens);
      const vector = vectorScores?.get(entry.path);
      return {
        entry,
        score: scored.score + (vector?.score || 0),
        reasons: vector
          ? [...scored.reasons, vector.reason].slice(0, 8)
          : scored.reasons,
      };
    })
    .filter((item) => item.score > 0)
    .sort(
      (a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path),
    )
    .slice(0, maxResults);
  return {
    concept: options.concept,
    returnedResults: ranked.length,
    cache: lastProjectMapCacheStatus,
    embedding: vectorScores ? "provider" : mode,
    tokens: tokens.slice(0, 40),
    results: ranked.map((item) => ({
      path: item.entry.path,
      score: item.score,
      role: item.entry.role,
      symbols: item.entry.symbols,
      calls: item.entry.calls.slice(0, 12),
      comments: item.entry.comments.slice(0, 6),
      callEdges: item.entry.callEdges.slice(0, 8),
      reasons: item.reasons,
    })),
  };
}

async function buildProjectMap(
  targetPath: string,
  confirmed = false,
  options?: number | ProjectMapBuildOptions,
): Promise<ProjectMapEntry[]> {
  const maxFiles =
    typeof options === "number"
      ? options
      : options?.maxFiles || MAX_PROJECT_MAP_FILES;
  const scanLimit =
    typeof options === "number"
      ? Math.max(maxFiles, MAX_PROJECT_MAP_SCAN_FILES)
      : Math.max(maxFiles, options?.scanLimit || MAX_PROJECT_MAP_SCAN_FILES);
  const useCache = typeof options !== "number" && options?.useCache;
  lastProjectMapCacheStatus = useCache ? "miss" : "disabled";
  const resolved = resolveSearchRoot(targetPath, confirmed);
  const filters = normalizeSearchFilters({
    extensions: DEFAULT_PROJECT_MAP_EXTENSIONS,
    maxResults: scanLimit,
  });
  const files = await walk(resolved.fullPath, filters, resolved.fullPath, [], {
    limit: scanLimit,
  });
  const signature = await getProjectMapSignature(files);
  const cachePath = getProjectMapCachePath(resolved.fullPath);
  if (useCache) {
    try {
      const cached = JSON.parse(
        await fs.readFile(cachePath, "utf8"),
      ) as ProjectMapCachePayload;
      if (
        cached.version === 1 &&
        cached.root === resolved.fullPath &&
        cached.signature === signature
      ) {
        lastProjectMapCacheStatus = "hit";
        return cached.entries.slice(0, maxFiles);
      }
    } catch {}
  }
  const entries: ProjectMapEntry[] = [];

  for (const file of files) {
    try {
      const content = await fs.readFile(file, "utf8");
      const displayPath = toDisplayPath(resolved.fullPath, file);
      const symbols = extractTopLevelSymbols(content, file);
      const relations = extractRelationsWithAst(content, file);
      const astSignals = extractAstCallsAndComments(content, file);
      entries.push({
        path: displayPath,
        symbols,
        relations,
        dependsOn: [],
        externalDeps: extractExternalDependenciesWithAst(content, file),
        importedBy: [],
        references: [],
        calls: astSignals.calls,
        comments: astSignals.comments,
        callEdges: astSignals.localCallEdges,
        role: "module",
        score: 0,
      });
    } catch {}
  }

  const pathSet = new Set(entries.map((entry) => entry.path));
  const importedByMap = new Map<string, Set<string>>();
  const referenceMap = new Map<string, Map<string, Set<string>>>();
  const importedSymbolTargets = new Map<string, Map<string, string>>();

  for (const entry of entries) {
    for (const relation of entry.relations) {
      const candidate = resolveCandidatePath(pathSet, entry.path, relation);
      if (!candidate) continue;
      entry.dependsOn.push(candidate);
      const bucket = importedByMap.get(candidate) || new Set<string>();
      bucket.add(entry.path);
      importedByMap.set(candidate, bucket);
    }

    const absolutePath = path.resolve(resolved.fullPath, entry.path);
    try {
      const content = await fs.readFile(absolutePath, "utf8");
      const imports = extractImportedSymbolsWithAst(content, absolutePath);
      for (const imported of imports) {
        const candidate = resolveCandidatePath(
          pathSet,
          entry.path,
          imported.specifier,
        );
        if (!candidate) continue;
        const symbolMap =
          referenceMap.get(candidate) || new Map<string, Set<string>>();
        const importedTargets =
          importedSymbolTargets.get(entry.path) || new Map<string, string>();
        for (const symbol of imported.symbols) {
          const files = symbolMap.get(symbol) || new Set<string>();
          files.add(entry.path);
          symbolMap.set(symbol, files);
          importedTargets.set(symbol, candidate);
        }
        for (const binding of imported.bindings) {
          importedTargets.set(binding.local, candidate);
        }
        importedSymbolTargets.set(entry.path, importedTargets);
        referenceMap.set(candidate, symbolMap);
      }
    } catch {}
  }

  const symbolsToPath = new Map<string, string>();
  for (const entry of entries) {
    for (const symbol of entry.symbols) {
      symbolsToPath.set(symbol, entry.path);
    }
  }
  for (const entry of entries) {
    for (const relation of entry.relations) {
      const candidate = resolveCandidatePath(pathSet, entry.path, relation);
      const target = candidate
        ? entries.find((item) => item.path === candidate)
        : null;
      if (!candidate || !target) continue;
      const importedTargets =
        importedSymbolTargets.get(entry.path) || new Map<string, string>();
      for (const symbol of target.symbols) {
        importedTargets.set(symbol, candidate);
      }
      importedSymbolTargets.set(entry.path, importedTargets);
    }
  }

  for (const entry of entries) {
    entry.dependsOn = Array.from(new Set(entry.dependsOn)).sort();
    entry.importedBy = Array.from(importedByMap.get(entry.path) || []).sort();
    const importedTargets = importedSymbolTargets.get(entry.path);
    entry.callEdges = entry.callEdges.map((edge) => ({
      ...edge,
      via:
        (edge.receiver ? importedTargets?.get(edge.receiver) : undefined) ||
        importedTargets?.get(edge.callee) ||
        symbolsToPath.get(edge.callee) ||
        edge.via,
    }));
    entry.references = Array.from(referenceMap.get(entry.path)?.entries() || [])
      .filter(([symbol]) => entry.symbols.includes(symbol))
      .map(([symbol, files]) => ({
        symbol,
        importedBy: Array.from(files).sort(),
      }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
    entry.role = getProjectMapRole(
      entry.path,
      entry.relations,
      entry.importedBy,
    );
    entry.score = scoreProjectMapEntry(
      entry.path,
      entry.symbols,
      entry.relations,
      entry.importedBy,
      entry.role,
      entry.externalDeps,
    );
  }

  const sortedEntries = entries.sort(
    (a, b) => b.score - a.score || a.path.localeCompare(b.path),
  );
  if (useCache) {
    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(
        cachePath,
        JSON.stringify(
          {
            version: 1,
            root: resolved.fullPath,
            signature,
            entries: sortedEntries,
          } satisfies ProjectMapCachePayload,
          null,
          2,
        ),
        "utf8",
      );
    } catch {}
  }
  return sortedEntries.slice(0, maxFiles);
}

export type { ProjectMapEntry, SearchFilters, SearchMatch };
export {
  buildContext,
  buildProjectMap,
  dedupeSearchMatches,
  extractAstCallsAndComments,
  extractExternalDependenciesWithAst,
  extractImportedSymbolsWithAst,
  extractRelationsWithAst,
  extractTopLevelSymbols,
  extractTopLevelSymbolsWithAst,
  filterMatchesByMode,
  formatSearchTextResult,
  getEmbeddingTokens,
  getProjectMapRole,
  getSearchLineMatcher,
  getSemanticTokens,
  globFiles,
  globToRegExp,
  matchesGlobPattern,
  matchesSearchFilters,
  normalizeExtension,
  normalizeGlob,
  normalizeSearchFilters,
  parseRipgrepOutput,
  resolveCandidatePath,
  resolveProjectRelation,
  scoreMatch,
  scoreProjectMapEntry,
  scoreSemanticEntry,
  semanticFind,
  shouldSkipEntry,
  sortMatches,
};

export const searchTools: ToolDefinition[] = [
  createTool({
    name: "glob_files",
    description:
      "按 glob 模式查找文件路径；适合先定位文件，再用 read_file 或 search_text 深入查看；可限定工作区内或确认后的工作区外目录范围",
    schema: z.object({
      pattern: z.string().min(1, "glob 模式不能为空"),
      path: z.string().optional(),
      extensions: z.array(z.string()).optional(),
      excludeGlobs: z.array(z.string()).optional(),
      maxResults: z.number().int().min(1).max(500).optional(),
      confirmed: z.boolean().optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "glob 模式，如 '**/*.ts'、'src/**/*.test.ts' 或 'package.json'",
        },
        path: {
          type: "string",
          description: "可选，限定查找目录，默认当前工作区",
        },
        extensions: {
          type: "array",
          items: { type: "string" },
          description: "可选，只返回指定后缀，如 ['ts', '.md']",
        },
        excludeGlobs: {
          type: "array",
          items: { type: "string" },
          description: "可选，排除匹配这些 glob 的文件，如 ['**/*.test.ts']",
        },
        maxResults: {
          type: "number",
          description: "可选，最多返回多少个文件，范围 1-500",
        },
        confirmed: {
          type: "boolean",
          description: "仅当用户已明确确认查找工作区外目录时才传 true",
        },
      },
      required: ["pattern"],
    },
    async execute(input) {
      const files = await globFiles(input);
      return JSON.stringify(files, null, 2);
    },
  }),
  createTool({
    name: "search_text",
    description:
      "在文本文件中搜索关键词；可指定工作区内或确认后的工作区外目录范围，并支持多关键词、文件类型、glob 过滤、上下文、分组和结果数限制",
    schema: z.object({
      query: z.string().min(1, "搜索关键词不能为空"),
      queries: z.array(z.string().min(1)).optional(),
      path: z.string().optional(),
      extensions: z.array(z.string()).optional(),
      includeGlobs: z.array(z.string()).optional(),
      excludeGlobs: z.array(z.string()).optional(),
      contextLines: z.number().int().min(0).max(5).optional(),
      regex: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      includeLineNumbers: z.boolean().optional(),
      groupByFile: z.boolean().optional(),
      matchMode: z.enum(["any", "all"]).optional(),
      resultOffset: z.number().int().min(0).optional(),
      maxResults: z.number().int().min(1).max(200).optional(),
      confirmed: z.boolean().optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        queries: {
          type: "array",
          items: { type: "string" },
          description: "可选，额外搜索关键词；会与 query 合并去重",
        },
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
        regex: {
          type: "boolean",
          description:
            "可选，true 时把 query 当正则表达式搜索；默认 false（固定字符串）",
        },
        caseSensitive: {
          type: "boolean",
          description: "可选，是否区分大小写；默认 false",
        },
        includeLineNumbers: {
          type: "boolean",
          description: "可选，是否在结果中包含行号；默认 true",
        },
        groupByFile: {
          type: "boolean",
          description: "可选，是否按文件聚合返回命中；默认 false",
        },
        matchMode: {
          type: "string",
          enum: ["any", "all"],
          description:
            "可选，多 query 时 any=任一关键词命中，all=同一行需命中所有关键词；默认 any",
        },
        resultOffset: {
          type: "number",
          description:
            "可选，搜索结果分页偏移（0-based），配合 maxResults 读取后续页",
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
      const searchOptions = {
        regex: input.regex,
        caseSensitive: input.caseSensitive,
        includeLineNumbers: input.includeLineNumbers,
        groupByFile: input.groupByFile,
        matchMode: input.matchMode,
        resultOffset: input.resultOffset,
      };
      const queries = uniqueSearchQueries(input.query, input.queries);
      const allMatches: SearchMatch[] = [];
      for (const query of queries) {
        const rgMatches = await searchWithRipgrep(
          query,
          resolved.fullPath,
          filters,
          searchOptions,
        );
        const matches =
          rgMatches.length > 0
            ? rgMatches
            : await searchWithFallback(
                query,
                resolved.fullPath,
                filters,
                searchOptions,
              );
        allMatches.push(...matches.map((match) => ({ ...match, query })));
      }
      const sortedMatches = sortMatches(
        filterMatchesByMode(
          dedupeSearchMatches(allMatches),
          queries,
          searchOptions.matchMode,
        ),
        input.query,
      );
      const resultOffset = Math.max(0, input.resultOffset || 0);
      const enrichedMatches = await enrichMatchesWithContext(
        sortedMatches.slice(resultOffset, resultOffset + filters.maxResults),
        resolved.fullPath,
        filters.contextLines,
      );
      return JSON.stringify(
        formatSearchTextResult(
          enrichedMatches,
          queries,
          filters,
          searchOptions,
          sortedMatches.length,
        ),
        null,
        2,
      );
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
  createTool({
    name: "semantic_find",
    description:
      "按业务概念、行为或模块职责定位最相关源码文件；基于 project_map 的路径、符号、调用、注释、依赖和角色进行轻量语义打分",
    schema: z.object({
      concept: z.string().min(1, "概念不能为空"),
      path: z.string().optional(),
      maxResults: z.number().int().min(1).max(20).optional(),
      confirmed: z.boolean().optional(),
      useCache: z.boolean().optional(),
      embedding: z.boolean().optional(),
      embeddingMode: z.enum(["tokens", "vector"]).optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        concept: {
          type: "string",
          description:
            "要定位的业务概念、行为或模块职责，例如 session restore、approval policy",
        },
        path: { type: "string", description: "可选，限定查找目录" },
        maxResults: {
          type: "number",
          description: "可选，最多返回 1-20 个候选",
        },
        confirmed: {
          type: "boolean",
          description: "仅当用户已明确确认读取工作区外目录时才传 true",
        },
        useCache: {
          type: "boolean",
          description: "可选，是否使用本地语义索引缓存；默认 true",
        },
        embedding: {
          type: "boolean",
          description:
            "可选，启用 embedding provider（SEMANTIC_EMBEDDING_PROVIDER）或轻量 fallback 词义扩展；默认 false",
        },
        embeddingMode: {
          type: "string",
          enum: ["tokens", "vector"],
          description:
            "可选，tokens=使用 provider/fallback 扩展关键词；vector=使用 provider 的 embedVector 做向量相似度 rerank",
        },
      },
      required: ["concept"],
      additionalProperties: false,
    },
    async execute(input) {
      const result = await semanticFind(input);
      return JSON.stringify(result, null, 2);
    },
  }),
];
