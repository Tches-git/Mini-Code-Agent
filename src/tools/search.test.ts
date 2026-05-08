import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
  type SearchFilters,
  type SearchMatch,
  scoreMatch,
  scoreProjectMapEntry,
  scoreSemanticEntry,
  semanticFind,
  shouldSkipEntry,
  sortMatches,
} from "./search.js";

let tempDir: string | null = null;

beforeEach(() => {
  tempDir = null;
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("shouldSkipEntry", () => {
  it("跳过 node_modules", () =>
    expect(shouldSkipEntry("node_modules")).toBe(true));
  it("跳过 .git", () => expect(shouldSkipEntry(".git")).toBe(true));
  it("跳过 dist", () => expect(shouldSkipEntry("dist")).toBe(true));
  it("跳过 .backup", () => expect(shouldSkipEntry(".backup")).toBe(true));
  it("跳过 .imports", () => expect(shouldSkipEntry(".imports")).toBe(true));
  it("跳过 dotfile", () => expect(shouldSkipEntry(".hidden")).toBe(true));
  it("跳过 .bak 文件", () => expect(shouldSkipEntry("file.bak")).toBe(true));
  it("不跳过普通文件", () => expect(shouldSkipEntry("index.ts")).toBe(false));
  it("不跳过普通目录", () => expect(shouldSkipEntry("src")).toBe(false));
});

describe("normalizeGlob", () => {
  it("去除首尾空白", () => expect(normalizeGlob("  src/**  ")).toBe("src/**"));
  it("反斜杠转正斜杠", () =>
    expect(normalizeGlob("src\\**\\*.ts")).toBe("src/**/*.ts"));
});

describe("normalizeExtension", () => {
  it("无点时自动加点", () => expect(normalizeExtension("ts")).toBe(".ts"));
  it("有点不重复加", () => expect(normalizeExtension(".ts")).toBe(".ts"));
  it("转小写", () => expect(normalizeExtension("TS")).toBe(".ts"));
  it("空字符串返回空", () => expect(normalizeExtension("")).toBe(""));
  it("去除空白", () => expect(normalizeExtension("  ts  ")).toBe(".ts"));
});

describe("globToRegExp", () => {
  it("* 匹配非斜杠字符", () => {
    const re = globToRegExp("*.ts");
    expect(re.test("index.ts")).toBe(true);
    expect(re.test("src/index.ts")).toBe(false);
  });

  it("** 匹配含斜杠字符", () => {
    const re = globToRegExp("**");
    expect(re.test("src/index.ts")).toBe(true);
  });

  it("**/ 匹配零或多级目录", () => {
    const re = globToRegExp("**/*.ts");
    expect(re.test("index.ts")).toBe(true);
    expect(re.test("src/index.ts")).toBe(true);
    expect(re.test("src/deep/index.ts")).toBe(true);
  });

  it("? 匹配单个非斜杠字符", () => {
    const re = globToRegExp("?.ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("ab.ts")).toBe(false);
  });

  it("转义正则元字符", () => {
    const re = globToRegExp("file.test.ts");
    expect(re.test("file.test.ts")).toBe(true);
    expect(re.test("filextest.ts")).toBe(false);
  });

  it("复杂模式 src/**/*.test.ts", () => {
    const re = globToRegExp("src/**/*.test.ts");
    expect(re.test("src/index.test.ts")).toBe(true);
    expect(re.test("src/agent/approval.test.ts")).toBe(true);
    expect(re.test("lib/index.test.ts")).toBe(false);
  });
});

describe("matchesGlobPattern", () => {
  it("匹配成功", () =>
    expect(matchesGlobPattern("src/index.ts", "src/**/*.ts")).toBe(true));
  it("匹配失败", () =>
    expect(matchesGlobPattern("lib/index.ts", "src/**/*.ts")).toBe(false));
  it("反斜杠路径也能匹配", () =>
    expect(matchesGlobPattern("src\\index.ts", "src/*.ts")).toBe(true));
});

describe("normalizeSearchFilters", () => {
  it("默认值", () => {
    const f = normalizeSearchFilters({});
    expect(f.extensions).toEqual([]);
    expect(f.includeGlobs).toEqual([]);
    expect(f.excludeGlobs).toEqual([]);
    expect(f.contextLines).toBe(0);
    expect(f.maxResults).toBe(50);
  });

  it("contextLines 钳制到 0-5", () => {
    expect(normalizeSearchFilters({ contextLines: -1 }).contextLines).toBe(0);
    expect(normalizeSearchFilters({ contextLines: 10 }).contextLines).toBe(5);
    expect(normalizeSearchFilters({ contextLines: 3 }).contextLines).toBe(3);
  });

  it("maxResults 钳制到 1-200", () => {
    expect(normalizeSearchFilters({ maxResults: 0 }).maxResults).toBe(50); // 0 is falsy, falls back to MAX_MATCHES
    expect(normalizeSearchFilters({ maxResults: 500 }).maxResults).toBe(200);
    expect(normalizeSearchFilters({ maxResults: 100 }).maxResults).toBe(100);
  });

  it("扩展名去重", () => {
    const f = normalizeSearchFilters({ extensions: ["ts", ".ts", "TS"] });
    expect(f.extensions).toEqual([".ts"]);
  });

  it("glob 去重", () => {
    const f = normalizeSearchFilters({ includeGlobs: ["src/**", "src/**"] });
    expect(f.includeGlobs).toEqual(["src/**"]);
  });
});

describe("matchesSearchFilters", () => {
  const emptyFilters: SearchFilters = {
    extensions: [],
    includeGlobs: [],
    excludeGlobs: [],
    contextLines: 0,
    maxResults: 50,
  };

  it("空过滤器匹配所有", () => {
    expect(matchesSearchFilters("anything.ts", emptyFilters)).toBe(true);
  });

  it("扩展名过滤", () => {
    const f = { ...emptyFilters, extensions: [".ts"] };
    expect(matchesSearchFilters("index.ts", f)).toBe(true);
    expect(matchesSearchFilters("index.js", f)).toBe(false);
  });

  it("include glob 过滤", () => {
    const f = { ...emptyFilters, includeGlobs: ["src/**"] };
    expect(matchesSearchFilters("src/index.ts", f)).toBe(true);
    expect(matchesSearchFilters("lib/index.ts", f)).toBe(false);
  });

  it("exclude glob 过滤", () => {
    const f = { ...emptyFilters, excludeGlobs: ["**/*.test.ts"] };
    expect(matchesSearchFilters("src/index.ts", f)).toBe(true);
    expect(matchesSearchFilters("src/index.test.ts", f)).toBe(false);
  });

  it("组合过滤", () => {
    const f = {
      ...emptyFilters,
      extensions: [".ts"],
      excludeGlobs: ["**/*.test.ts"],
    };
    expect(matchesSearchFilters("src/index.ts", f)).toBe(true);
    expect(matchesSearchFilters("src/index.test.ts", f)).toBe(false);
    expect(matchesSearchFilters("src/index.js", f)).toBe(false);
  });
});

describe("globFiles", () => {
  it("按 glob 查找文件并稳定排序", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "glob-files-"));
    await fs.mkdir(path.join(tempDir, "src", "agent"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "dist"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "src", "index.ts"), "", "utf8");
    await fs.writeFile(
      path.join(tempDir, "src", "agent", "run.ts"),
      "",
      "utf8",
    );
    await fs.writeFile(
      path.join(tempDir, "src", "agent", "run.test.ts"),
      "",
      "utf8",
    );
    await fs.writeFile(path.join(tempDir, "dist", "built.ts"), "", "utf8");

    await expect(
      globFiles({
        pattern: "**/*.ts",
        path: tempDir,
        excludeGlobs: ["**/*.test.ts"],
        confirmed: true,
      }),
    ).resolves.toEqual(["src/agent/run.ts", "src/index.ts"]);
  });

  it("遵守 maxResults 上限", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "glob-files-limit-"));
    await fs.writeFile(path.join(tempDir, "a.ts"), "", "utf8");
    await fs.writeFile(path.join(tempDir, "b.ts"), "", "utf8");

    const result = await globFiles({
      pattern: "**/*.ts",
      path: tempDir,
      maxResults: 1,
      confirmed: true,
    });

    expect(result).toHaveLength(1);
  });

  it("工作区外路径未确认时拒绝查找", async () => {
    await expect(
      globFiles({ pattern: "**/*.ts", path: os.tmpdir() }),
    ).rejects.toThrow("搜索工作区外目录前需要用户确认");
  });
});

describe("buildContext", () => {
  const lines = ["line0", "line1", "line2", "line3", "line4"];

  it("contextLines=0 返回空对象", () => {
    expect(buildContext(lines, 3, 0)).toEqual({});
  });

  it("正常返回前后行", () => {
    const ctx = buildContext(lines, 3, 1);
    expect(ctx.before).toEqual(["line1"]);
    expect(ctx.after).toEqual(["line3"]);
  });

  it("文件头边界不越界", () => {
    const ctx = buildContext(lines, 1, 2);
    expect(ctx.before).toBeUndefined();
    expect(ctx.after).toEqual(["line1", "line2"]);
  });

  it("文件尾边界不越界", () => {
    const ctx = buildContext(lines, 5, 2);
    expect(ctx.before).toEqual(["line2", "line3"]);
    expect(ctx.after).toBeUndefined();
  });
});

describe("getSearchLineMatcher", () => {
  it("默认不区分大小写并按固定字符串匹配", () => {
    const matcher = getSearchLineMatcher("hello.world");
    expect(matcher("HELLO.WORLD")).toBe(true);
    expect(matcher("hello-world")).toBe(false);
  });

  it("支持大小写敏感", () => {
    const matcher = getSearchLineMatcher("Hello", { caseSensitive: true });
    expect(matcher("Hello world")).toBe(true);
    expect(matcher("hello world")).toBe(false);
  });

  it("支持正则匹配", () => {
    const matcher = getSearchLineMatcher("hello\\s+world", { regex: true });
    expect(matcher("HELLO   world")).toBe(true);
    expect(matcher("hello-world")).toBe(false);
  });
});

describe("scoreMatch", () => {
  const makeMatch = (overrides: Partial<SearchMatch>): SearchMatch => ({
    path: "src/index.ts",
    line: 1,
    text: "hello world",
    ...overrides,
  });

  it("精确匹配分数最高", () => {
    const exact = scoreMatch(makeMatch({ text: "hello" }), "hello");
    const partial = scoreMatch(makeMatch({ text: "hello world" }), "hello");
    expect(exact).toBeGreaterThan(partial);
  });

  it("startsWith 有加分", () => {
    const starts = scoreMatch(makeMatch({ text: "hello world" }), "hello");
    const middle = scoreMatch(makeMatch({ text: "say hello" }), "hello");
    expect(starts).toBeGreaterThan(middle);
  });

  it("文件名匹配有加分", () => {
    const fileMatch = scoreMatch(makeMatch({ path: "src/hello.ts" }), "hello");
    const noFileMatch = scoreMatch(
      makeMatch({ path: "src/other.ts" }),
      "hello",
    );
    expect(fileMatch).toBeGreaterThan(noFileMatch);
  });

  it("浅路径分数更高", () => {
    const shallow = scoreMatch(makeMatch({ path: "index.ts" }), "hello");
    const deep = scoreMatch(makeMatch({ path: "a/b/c/d/index.ts" }), "hello");
    expect(shallow).toBeGreaterThan(deep);
  });
});

describe("sortMatches", () => {
  const makeMatch = (
    path: string,
    line: number,
    text: string,
  ): SearchMatch => ({ path, line, text });

  it("按分数降序排列", () => {
    const matches = [
      makeMatch("deep/a/b/c/file.ts", 100, "other"),
      makeMatch("index.ts", 1, "query"),
    ];
    const sorted = sortMatches(matches, "query");
    expect(sorted[0].path).toBe("index.ts");
  });

  it("同分按路径字母序", () => {
    const matches = [makeMatch("b.ts", 1, "x"), makeMatch("a.ts", 1, "x")];
    const sorted = sortMatches(matches, "q");
    expect(sorted[0].path).toBe("a.ts");
  });

  it("同路径按行号升序", () => {
    const matches = [makeMatch("a.ts", 10, "x"), makeMatch("a.ts", 1, "x")];
    const sorted = sortMatches(matches, "q");
    expect(sorted[0].line).toBe(1);
  });
});

describe("search result helpers", () => {
  it("按文件、行号和文本稳定去重", () => {
    expect(
      dedupeSearchMatches([
        { path: "a.ts", line: 1, text: "hello", query: "hello" },
        { path: "a.ts", line: 1, text: "hello", query: "world" },
        { path: "a.ts", line: 2, text: "hello", query: "hello" },
      ]),
    ).toEqual([
      { path: "a.ts", line: 1, text: "hello", query: "hello" },
      { path: "a.ts", line: 2, text: "hello", query: "hello" },
    ]);
  });

  it("all 模式只保留同一行命中所有 query 的结果", () => {
    const matches = [
      { path: "a.ts", line: 1, text: "hello world", query: "hello" },
      { path: "a.ts", line: 1, text: "hello world", query: "world" },
      { path: "a.ts", line: 2, text: "hello", query: "hello" },
    ];

    expect(filterMatchesByMode(matches, ["hello", "world"], "all")).toEqual([
      { path: "a.ts", line: 1, text: "hello world", query: "hello" },
      { path: "a.ts", line: 1, text: "hello world", query: "world" },
    ]);
  });
});

describe("formatSearchTextResult", () => {
  const filters: SearchFilters = {
    extensions: [],
    includeGlobs: [],
    excludeGlobs: [],
    contextLines: 0,
    maxResults: 2,
  };

  it("返回总命中数、截断信息和默认行号", () => {
    const result = formatSearchTextResult(
      [
        { path: "a.ts", line: 1, text: "hello" },
        { path: "b.ts", line: 2, text: "hello" },
      ],
      ["hello"],
      { ...filters, maxResults: 1 },
    );

    expect(result.totalMatches).toBe(2);
    expect(result.returnedMatches).toBe(1);
    expect(result.resultOffset).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.nextOffset).toBe(1);
    expect(result.matches?.[0]).toEqual({
      path: "a.ts",
      line: 1,
      text: "hello",
    });
  });

  it("支持传入完整总数计算截断", () => {
    const result = formatSearchTextResult(
      [{ path: "a.ts", line: 1, text: "hello" }],
      ["hello"],
      filters,
      {},
      5,
    );

    expect(result.totalMatches).toBe(5);
    expect(result.returnedMatches).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("支持 resultOffset 分页", () => {
    const result = formatSearchTextResult(
      [
        { path: "a.ts", line: 1, text: "a" },
        { path: "a.ts", line: 2, text: "b" },
        { path: "a.ts", line: 3, text: "c" },
      ],
      ["a"],
      { ...filters, maxResults: 1 },
      { resultOffset: 1 },
    );

    expect(result.resultOffset).toBe(1);
    expect(result.matches?.[0]?.text).toBe("b");
    expect(result.nextOffset).toBe(2);
  });

  it("可隐藏行号并按文件聚合", () => {
    const result = formatSearchTextResult(
      [
        { path: "a.ts", line: 1, text: "hello", query: "hello" },
        { path: "a.ts", line: 3, text: "world", query: "world" },
      ],
      ["hello", "world"],
      filters,
      { includeLineNumbers: false, groupByFile: true },
    );

    expect(result.files).toEqual([
      {
        path: "a.ts",
        matchCount: 2,
        matches: [
          { path: "a.ts", text: "hello", query: "hello" },
          { path: "a.ts", text: "world", query: "world" },
        ],
      },
    ]);
  });
});

describe("getSearchLineMatcher", () => {
  it("正则无效时返回友好错误", () => {
    expect(() => getSearchLineMatcher("[", { regex: true })).toThrow(
      '无效正则表达式 "["',
    );
  });
});

describe("parseRipgrepOutput", () => {
  const emptyFilters: SearchFilters = {
    extensions: [],
    includeGlobs: [],
    excludeGlobs: [],
    contextLines: 0,
    maxResults: 50,
  };
  const baseDir = process.cwd();

  it("解析有效 JSON match", () => {
    const line = JSON.stringify({
      type: "match",
      data: {
        path: { text: "src/index.ts" },
        line_number: 10,
        lines: { text: "hello world\n" },
      },
    });
    const result = parseRipgrepOutput(line, baseDir, emptyFilters);
    expect(result).toHaveLength(1);
    expect(result[0].line).toBe(10);
    expect(result[0].text).toBe("hello world");
  });

  it("跳过非 match 类型", () => {
    const line = JSON.stringify({ type: "summary", data: {} });
    expect(parseRipgrepOutput(line, baseDir, emptyFilters)).toHaveLength(0);
  });

  it("跳过不匹配过滤条件的结果", () => {
    const line = JSON.stringify({
      type: "match",
      data: {
        path: { text: "src/index.js" },
        line_number: 1,
        lines: { text: "x" },
      },
    });
    const tsOnly = { ...emptyFilters, extensions: [".ts"] };
    expect(parseRipgrepOutput(line, baseDir, tsOnly)).toHaveLength(0);
  });

  it("畸形 JSON 行容错", () => {
    const output =
      "not json\n" +
      JSON.stringify({
        type: "match",
        data: { path: { text: "a.ts" }, line_number: 1, lines: { text: "ok" } },
      });
    expect(parseRipgrepOutput(output, baseDir, emptyFilters)).toHaveLength(1);
  });

  it("空输出返回空数组", () => {
    expect(parseRipgrepOutput("", baseDir, emptyFilters)).toEqual([]);
  });
});

describe("project map helpers", () => {
  it("提取顶层导出符号", () => {
    const content = [
      "export function run() {}",
      "export const createAgent = () => {};",
      "export class Agent {}",
      "export type AgentConfig = {};",
    ].join("\n");
    expect(extractTopLevelSymbols(content, "file.ts")).toEqual([
      "run",
      "createAgent",
      "Agent",
      "AgentConfig",
    ]);
  });

  it("AST 提取支持解构和重导出符号", () => {
    const content = [
      "export const { createAgent, runAgent: run } = factory();",
      "export { default as AgentOrchestrator, helper } from './agent';",
      "const internal = 1;",
      "const localFactory = () => {};",
    ].join("\n");
    expect(extractTopLevelSymbolsWithAst(content, "file.ts")).toEqual([
      "createAgent",
      "run",
      "AgentOrchestrator",
      "helper",
      "localFactory",
    ]);
  });

  it("AST 提取支持内部相对依赖关系", () => {
    const content = [
      "import { readFile } from './filesystem';",
      "import { z } from 'zod';",
      "export { helper } from '../utils/helper';",
      "export * from './types';",
    ].join("\n");
    expect(extractRelationsWithAst(content, "file.ts")).toEqual([
      "./filesystem",
      "../utils/helper",
      "./types",
    ]);
  });

  it("AST 提取支持符号级 import/export 关系", () => {
    const content = [
      "import defaultAgent, { createAgent, runAgent as run } from './agent';",
      "export { helper, format as print } from '../utils/helper';",
    ].join("\n");
    expect(extractImportedSymbolsWithAst(content, "file.ts")).toEqual([
      {
        specifier: "./agent",
        symbols: ["defaultAgent", "createAgent", "runAgent"],
        bindings: [
          { imported: "default", local: "defaultAgent", typeOnly: false },
          { imported: "createAgent", local: "createAgent", typeOnly: false },
          { imported: "runAgent", local: "run", typeOnly: false },
        ],
      },
      {
        specifier: "../utils/helper",
        symbols: ["helper", "format"],
        bindings: [
          { imported: "helper", local: "helper", typeOnly: false },
          { imported: "format", local: "print", typeOnly: false },
        ],
      },
    ]);
  });

  it("AST 提取标记 type-only import/export 绑定", () => {
    const content = [
      "import type { SessionApi } from './session';",
      "export type { SessionConfig } from './config';",
    ].join("\n");
    expect(extractImportedSymbolsWithAst(content, "file.ts")).toEqual([
      {
        specifier: "./session",
        symbols: ["SessionApi"],
        bindings: [
          { imported: "SessionApi", local: "SessionApi", typeOnly: true },
        ],
      },
      {
        specifier: "./config",
        symbols: ["SessionConfig"],
        bindings: [
          {
            imported: "SessionConfig",
            local: "SessionConfig",
            typeOnly: true,
          },
        ],
      },
    ]);
  });

  it("AST 提取支持外部依赖", () => {
    const content = [
      "import ts from 'typescript';",
      "import { execa } from 'execa';",
      "export { z } from 'zod';",
      "import { helper } from './local';",
    ].join("\n");
    expect(extractExternalDependenciesWithAst(content, "file.ts")).toEqual([
      "execa",
      "typescript",
      "zod",
    ]);
  });

  it("AST 提取支持调用、别名调用和注释信号", () => {
    const content = [
      "// restores persisted session state",
      "export function run(flag: boolean) {",
      "  const useRestore = true;",
      "  const restoreAlias = useRestore ? restorePersistedSessionById : loadSession;",
      "  let later = restorePersistedSessionById;",
      "  later = loadSession;",
      "  const factoryAlias = makeSessionFactory();",
      "  const graph = taskGraph;",
      "  const { restore: runRestore } = taskGraph;",
      "  const casted = (restorePersistedSessionById as () => void);",
      "  const saveKey = 'sa' + 've';",
      "  const validateKey = `vali$" + "{'date'}`;",
      "  const keys = { archive: 'archive' };",
      "  const handlers = [restorePersistedSessionById, saveSession];",
      "  const handlerEntries = [{ run: validateSession }, { run: archiveSession }];",
      "  function chooseSession() { return restorePersistedSessionById; }",
      "  const chooseLater = () => loadSession;",
      "  function identity(fn: () => void) { return fn; }",
      "  function invoke(fn: () => void) { fn(); }",
      "  function nestedInvoke(fn: () => void) { invoke(fn); }",
      "  const invokeLater = (fn: () => void) => () => fn;",
      "  const wrapNested = (fn: () => void) => { const inner = () => fn; return () => inner(); };",
      "  const registry = { restore: restorePersistedSessionById, ['load']: loadSession, [saveKey]: saveSession, [validateKey]: validateSession, [keys.archive]: archiveSession };",
      "  factoryAlias.create();",
      "  registry.restore();",
      "  registry['load']();",
      "  registry[saveKey]();",
      "  registry[validateKey]();",
      "  registry[keys.archive]();",
      "  registry[dynamicKey]();",
      "  if (useRestore) { restorePersistedSessionById(); } else { loadSession(); }",
      "  if (!useRestore) { neverSession(); } else { saveSession(); }",
      "  for (const item of sessions) { item.restore(); }",
      "  for (const handler of handlers) { handler(); }",
      "  for (const entry of handlerEntries) { entry.run(); }",
      "  chooseSession()();",
      "  chooseLater()();",
      "  identity(saveSession)();",
      "  invoke(validateSession);",
      "  nestedInvoke(archiveSession);",
      "  invokeLater(loadSession)()();",
      "  wrapNested(validateSession)()();",
      "  casted();",
      "  restoreAlias();",
      "  later();",
      "  runRestore();",
      "  graph.restore();",
      "}",
    ].join("\n");
    expect(extractAstCallsAndComments(content, "file.ts")).toEqual({
      calls: [
        "archiveSession",
        "chooseLater",
        "chooseSession",
        "create",
        "fn",
        "identity",
        "inner",
        "invoke",
        "invokeLater",
        "loadSession",
        "makeSessionFactory",
        "nestedInvoke",
        "restore",
        "restorePersistedSessionById",
        "saveSession",
        "validateSession",
        "wrapNested",
      ],
      comments: ["restores persisted session state"],
      localCallEdges: [
        { caller: "run", callee: "makeSessionFactory", via: "local" },
        { caller: "invoke", callee: "fn", via: "local" },
        { caller: "nestedInvoke", callee: "invoke", via: "local" },
        { caller: "nestedInvoke", callee: "fn", via: "local" },
        { caller: "wrapNested", callee: "inner", via: "local" },
        {
          caller: "run",
          callee: "create",
          via: "local",
          receiver: "makeSessionFactory",
        },
        { caller: "run", callee: "restorePersistedSessionById", via: "local" },
        { caller: "run", callee: "loadSession", via: "local" },
        { caller: "run", callee: "saveSession", via: "local" },
        { caller: "run", callee: "validateSession", via: "local" },
        { caller: "run", callee: "archiveSession", via: "local" },
        { caller: "run", callee: "restorePersistedSessionById", via: "local" },
        { caller: "run", callee: "loadSession", via: "local" },
        { caller: "run", callee: "saveSession", via: "local" },
        { caller: "run", callee: "validateSession", via: "local" },
        { caller: "run", callee: "archiveSession", via: "local" },
        { caller: "run", callee: "restorePersistedSessionById", via: "local" },
        { caller: "run", callee: "saveSession", via: "local" },
        { caller: "run", callee: "restore", via: "local", receiver: "item" },
        { caller: "run", callee: "restorePersistedSessionById", via: "local" },
        { caller: "run", callee: "saveSession", via: "local" },
        { caller: "run", callee: "validateSession", via: "local" },
        { caller: "run", callee: "archiveSession", via: "local" },
        { caller: "run", callee: "restorePersistedSessionById", via: "local" },
        { caller: "run", callee: "chooseSession", via: "local" },
        { caller: "run", callee: "loadSession", via: "local" },
        { caller: "run", callee: "chooseLater", via: "local" },
        { caller: "run", callee: "saveSession", via: "local" },
        { caller: "run", callee: "identity", via: "local" },
        { caller: "run", callee: "invoke", via: "local" },
        { caller: "run", callee: "validateSession", via: "local" },
        { caller: "run", callee: "nestedInvoke", via: "local" },
        { caller: "run", callee: "archiveSession", via: "local" },
        { caller: "run", callee: "loadSession", via: "local" },
        { caller: "run", callee: "loadSession", via: "local" },
        { caller: "run", callee: "invokeLater", via: "local" },
        { caller: "run", callee: "validateSession", via: "local" },
        { caller: "run", callee: "validateSession", via: "local" },
        { caller: "run", callee: "wrapNested", via: "local" },
        { caller: "run", callee: "restorePersistedSessionById", via: "local" },
        { caller: "run", callee: "restorePersistedSessionById", via: "local" },
        { caller: "run", callee: "loadSession", via: "local" },
        {
          caller: "run",
          callee: "restore",
          via: "local",
          receiver: "taskGraph",
        },
        {
          caller: "run",
          callee: "restore",
          via: "local",
          receiver: "taskGraph",
        },
      ],
    });
  });

  it("非 TS/JS 文件仍回退到正则提取", () => {
    const content = "export function load() {}\nexport class Widget {}";
    expect(extractTopLevelSymbols(content, "component.svelte")).toEqual([
      "load",
      "Widget",
    ]);
  });

  it("可以解析并命中工作区内依赖目标", () => {
    const pathSet = new Set([
      "src/agent/orchestrator.ts",
      "src/tools/index.ts",
    ]);
    expect(
      resolveProjectRelation("src/agent/orchestrator.ts", "../tools/index"),
    ).toBe("src/tools/index");
    expect(
      resolveCandidatePath(
        pathSet,
        "src/agent/orchestrator.ts",
        "../tools/index",
      ),
    ).toBe("src/tools/index.ts");
  });

  it("可以推断 entry/core/leaf 角色", () => {
    expect(
      getProjectMapRole("src/cli/index.ts", ["../agent/orchestrator"], []),
    ).toBe("entry");
    expect(
      getProjectMapRole(
        "src/agent/orchestrator.ts",
        ["../tools/index"],
        ["src/cli/index.ts"],
      ),
    ).toBe("core");
    expect(
      getProjectMapRole(
        "src/types/agent.ts",
        [],
        ["src/agent/orchestrator.ts"],
      ),
    ).toBe("leaf");
  });

  it("关键文件、符号和关系越多分数越高", () => {
    expect(
      scoreProjectMapEntry(
        "src/agent/index.ts",
        ["a", "b"],
        ["./dep"],
        ["src/cli/index.ts"],
        "core",
        ["typescript"],
      ),
    ).toBeGreaterThan(scoreProjectMapEntry("src/deep/nested/file.ts", []));
  });

  it("可以生成当前项目的 project map", async () => {
    const result = await buildProjectMap("src", false, 5);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(5);
    expect(result[0]).toHaveProperty("path");
    expect(result[0]).toHaveProperty("symbols");
    expect(result[0]).toHaveProperty("relations");
    expect(result[0]).toHaveProperty("dependsOn");
    expect(result[0]).toHaveProperty("externalDeps");
    expect(result[0]).toHaveProperty("importedBy");
    expect(result[0]).toHaveProperty("references");
    expect(result[0]).toHaveProperty("calls");
    expect(result[0]).toHaveProperty("comments");
    expect(result[0]).toHaveProperty("callEdges");
    expect(result[0]).toHaveProperty("role");
    expect(result[0]).toHaveProperty("score");
  });

  it("project map 可以把导入函数调用边解析到跨文件目标并忽略类型导入", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "project-map-calls-"));
    await fs.writeFile(
      path.join(tempDir, "session.ts"),
      "export function restoreSession() {}\nexport type SessionApi = {};\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tempDir, "runner.ts"),
      [
        "import { restoreSession } from './session';",
        "import type { SessionApi } from './session';",
        "export function run() { restoreSession(); SessionApi(); }",
      ].join("\n"),
      "utf8",
    );

    const result = await buildProjectMap(tempDir, true, { maxFiles: 10 });
    const runner = result.find((entry) => entry.path === "runner.ts");

    expect(runner?.callEdges).toContainEqual({
      caller: "run",
      callee: "restoreSession",
      via: "session.ts",
    });
    expect(runner?.callEdges).toContainEqual({
      caller: "run",
      callee: "SessionApi",
      via: "local",
    });
  });

  it("project map 可以通过重导出解析调用边目标", async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "project-map-reexport-calls-"),
    );
    await fs.writeFile(
      path.join(tempDir, "session.ts"),
      "export function restoreSession() {}\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tempDir, "index.ts"),
      "export { restoreSession } from './session';\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tempDir, "runner.ts"),
      [
        "import { restoreSession } from './index';",
        "export function run() { restoreSession(); }",
      ].join("\n"),
      "utf8",
    );

    const result = await buildProjectMap(tempDir, true, { maxFiles: 10 });
    const runner = result.find((entry) => entry.path === "runner.ts");

    expect(runner?.callEdges).toContainEqual({
      caller: "run",
      callee: "restoreSession",
      via: "session.ts",
    });
  });

  it("project map 可以解析多级默认导出重导出调用边目标", async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "project-map-default-reexport-calls-"),
    );
    await fs.writeFile(
      path.join(tempDir, "session.ts"),
      "export default function restoreSession() {}\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tempDir, "middle.ts"),
      "export { default as restoreSession } from './session';\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tempDir, "index.ts"),
      "export { restoreSession } from './middle';\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tempDir, "runner.ts"),
      [
        "import { restoreSession } from './index';",
        "export function run(flag: boolean) {",
        "  const resume = flag ? restoreSession : fallbackSession;",
        "  resume();",
        "}",
      ].join("\n"),
      "utf8",
    );

    const result = await buildProjectMap(tempDir, true, { maxFiles: 10 });
    const runner = result.find((entry) => entry.path === "runner.ts");

    expect(runner?.callEdges).toContainEqual({
      caller: "run",
      callee: "restoreSession",
      via: "session.ts",
    });
    expect(runner?.callEdges).toContainEqual({
      caller: "run",
      callee: "fallbackSession",
      via: "local",
    });
  });

  it("project map 可以把命名空间属性调用边解析到跨文件目标", async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "project-map-property-calls-"),
    );
    await fs.writeFile(
      path.join(tempDir, "session.ts"),
      "export function restore() {}\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tempDir, "runner.ts"),
      [
        "import * as session from './session';",
        "export function run() { session.restore(); }",
      ].join("\n"),
      "utf8",
    );

    const result = await buildProjectMap(tempDir, true, { maxFiles: 10 });
    const runner = result.find((entry) => entry.path === "runner.ts");

    expect(runner?.callEdges).toContainEqual({
      caller: "run",
      callee: "restore",
      receiver: "session",
      via: "session.ts",
    });
  });

  it("project map 在大目录下遵守扫描上限并优先返回更关键文件", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "project-map-"));
    const srcDir = path.join(tempDir, "src");
    const deepDir = path.join(srcDir, "features", "deep");
    await fs.mkdir(deepDir, { recursive: true });
    await fs.writeFile(
      path.join(srcDir, "index.ts"),
      "export { feature0 } from './features/deep/feature0';\n",
      "utf8",
    );
    for (let index = 0; index < 12; index++) {
      await fs.writeFile(
        path.join(deepDir, `feature${index}.ts`),
        `export const feature${index} = ${index};\n`,
        "utf8",
      );
    }

    const result = await buildProjectMap(srcDir, true, {
      maxFiles: 3,
      scanLimit: 5,
    });

    expect(result.length).toBeLessThanOrEqual(3);
    expect(result.some((entry) => entry.path === "index.ts")).toBe(true);
  });
});

describe("semantic finder", () => {
  it("can rank files by concept", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "semantic-find-"));
    await fs.mkdir(path.join(tempDir, "src", "agent"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "src", "cli"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "src", "agent", "session.ts"),
      "export function restoreSession() {}\nexport function saveSession() {}\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tempDir, "src", "cli", "index.ts"),
      "export function runCli() {}\n",
      "utf8",
    );

    const result = await semanticFind({
      concept: "session restore",
      path: tempDir,
      confirmed: true,
      maxResults: 2,
    });

    expect(result.returnedResults).toBeGreaterThan(0);
    expect(result.results[0]?.path).toContain("session.ts");
    expect(result.cache).toBe("miss");
    expect(result.embedding).toBe("disabled");
    expect(result.results[0]?.calls).toEqual([]);
    expect(result.results[0]?.comments).toEqual([]);
    expect(result.results[0]?.callEdges).toEqual([]);
    expect(result.results[0]?.reasons.length).toBeGreaterThan(0);
  });

  it("uses semantic index cache on repeated lookups", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "semantic-cache-"));
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "semantic-state-"),
    );
    process.env.LOCAL_CODE_AGENT_STATE_DIR = stateDir;
    await fs.writeFile(
      path.join(tempDir, "session.ts"),
      "export function restoreSession() {}\n",
      "utf8",
    );

    const first = await semanticFind({
      concept: "session restore",
      path: tempDir,
      confirmed: true,
      maxResults: 2,
    });
    const second = await semanticFind({
      concept: "session restore",
      path: tempDir,
      confirmed: true,
      maxResults: 2,
    });

    expect(first.cache).toBe("miss");
    expect(second.cache).toBe("hit");
    await fs.rm(stateDir, { recursive: true, force: true });
    delete process.env.LOCAL_CODE_AGENT_STATE_DIR;
  });

  it("embedding fallback expands related concepts", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "semantic-embedding-"));
    await fs.writeFile(
      path.join(tempDir, "approval.ts"),
      "export function approvalPolicy() {}\n",
      "utf8",
    );

    const result = await semanticFind({
      concept: "auth",
      path: tempDir,
      confirmed: true,
      embedding: true,
    });

    expect(result.embedding).toBe("fallback");
    expect(result.tokens).toContain("approval");
    expect(result.results[0]?.path).toBe("approval.ts");
  });

  it("tokenizer handles camelCase, stems simple suffixes, and expands aliases", () => {
    expect(getEmbeddingTokens("sessionRestores validated tasks")).toEqual(
      expect.arrayContaining([
        "session",
        "restore",
        "validated",
        "validat",
        "task",
      ]),
    );
  });

  it("uses optional embedding provider when configured", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "semantic-provider-"));
    const providerPath = path.join(tempDir, "embedding-provider.mjs");
    await fs.writeFile(
      providerPath,
      "export async function embedConcept() { return ['approval policy']; }\n",
      "utf8",
    );
    process.env.SEMANTIC_EMBEDDING_PROVIDER = providerPath;

    const result = await getSemanticTokens("auth", true);

    expect(result.mode).toBe("provider");
    expect(result.tokens).toEqual(
      expect.arrayContaining(["auth", "approval", "policy"]),
    );
    delete process.env.SEMANTIC_EMBEDDING_PROVIDER;
  });

  it("uses vector embedding provider to rerank semantic results", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "semantic-vector-"));
    await fs.writeFile(
      path.join(tempDir, "billing.ts"),
      "export function reconcileInvoices() {}\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tempDir, "theme.ts"),
      "export function renderPalette() {}\n",
      "utf8",
    );
    const providerPath = path.join(tempDir, "vector-provider.mjs");
    await fs.writeFile(
      providerPath,
      `export async function embedVector(text) {
  if (text.includes("customer intent") || text.includes("reconcileInvoices")) return [1, 0];
  if (text.includes("renderPalette")) return [0, 1];
  return [0, 0];
}\n`,
      "utf8",
    );
    process.env.SEMANTIC_EMBEDDING_PROVIDER = providerPath;

    const result = await semanticFind({
      concept: "customer intent",
      path: tempDir,
      confirmed: true,
      embedding: true,
      embeddingMode: "vector",
      maxResults: 2,
      useCache: false,
    });

    expect(result.embedding).toBe("provider");
    expect(result.results[0]?.path).toBe("billing.ts");
    expect(result.results[0]?.reasons).toContain("vector similarity 1.00");
    delete process.env.SEMANTIC_EMBEDDING_PROVIDER;
  });

  it("caches vector embeddings for unchanged entries", async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "semantic-vector-cache-"),
    );
    const sourceDir = path.join(tempDir, "src");
    const stateDir = path.join(tempDir, "state");
    const callsPath = path.join(tempDir, "calls.log");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, "billing.ts"),
      "export function reconcileInvoices() {}\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(sourceDir, "theme.ts"),
      "export function renderPalette() {}\n",
      "utf8",
    );
    const providerPath = path.join(tempDir, "cached-vector-provider.mjs");
    await fs.writeFile(
      providerPath,
      `import { appendFileSync } from "node:fs";
const callsPath = ${JSON.stringify(callsPath)};
export async function embedVector(text) {
  const kind = text.includes("customer intent")
    ? "concept"
    : text.includes("reconcileInvoices")
      ? "billing"
      : "theme";
  appendFileSync(callsPath, kind + "\\n");
  if (kind === "concept" || kind === "billing") return [1, 0];
  return [0, 1];
}\n`,
      "utf8",
    );
    process.env.LOCAL_CODE_AGENT_STATE_DIR = stateDir;
    process.env.SEMANTIC_EMBEDDING_PROVIDER = providerPath;

    await semanticFind({
      concept: "customer intent",
      path: sourceDir,
      confirmed: true,
      embedding: true,
      embeddingMode: "vector",
      maxResults: 2,
    });
    await semanticFind({
      concept: "customer intent",
      path: sourceDir,
      confirmed: true,
      embedding: true,
      embeddingMode: "vector",
      maxResults: 2,
    });

    const calls = (await fs.readFile(callsPath, "utf8")).trim().split("\n");
    expect(calls.filter((call) => call === "concept")).toHaveLength(2);
    expect(calls.filter((call) => call === "billing")).toHaveLength(1);
    expect(calls.filter((call) => call === "theme")).toHaveLength(1);
    delete process.env.LOCAL_CODE_AGENT_STATE_DIR;
    delete process.env.SEMANTIC_EMBEDDING_PROVIDER;
  });

  it("semantic score explains matched reasons", () => {
    const scored = scoreSemanticEntry(
      {
        path: "src/agent/session.ts",
        symbols: ["restoreSession"],
        relations: [],
        dependsOn: [],
        externalDeps: [],
        importedBy: [],
        references: [],
        calls: ["restorePersistedSessionById"],
        comments: ["restore session state after restart"],
        callEdges: [
          {
            caller: "restoreSession",
            callee: "loadSession",
            via: "src/agent/session.ts",
          },
        ],
        role: "core",
        score: 0,
      },
      ["session", "restart"],
    );
    expect(scored.score).toBeGreaterThan(0);
    expect(scored.reasons.some((reason) => reason.includes("session"))).toBe(
      true,
    );
    expect(scored.reasons).toContain("comment matches restart");
  });
});
