import { describe, expect, it } from "vitest";
import {
  buildContext,
  buildProjectMap,
  extractExternalDependenciesWithAst,
  extractImportedSymbolsWithAst,
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
  resolveCandidatePath,
  resolveProjectRelation,
  type SearchFilters,
  type SearchMatch,
  scoreMatch,
  scoreProjectMapEntry,
  shouldSkipEntry,
  sortMatches,
} from "./search.js";

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
      { specifier: "./agent", symbols: ["defaultAgent", "createAgent", "runAgent"] },
      { specifier: "../utils/helper", symbols: ["helper", "format"] },
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

  it("非 TS/JS 文件仍回退到正则提取", () => {
    const content = "export function load() {}\nexport class Widget {}";
    expect(extractTopLevelSymbols(content, "component.svelte")).toEqual([
      "load",
      "Widget",
    ]);
  });

  it("可以解析并命中工作区内依赖目标", () => {
    const pathSet = new Set(["src/agent/orchestrator.ts", "src/tools/index.ts"]);
    expect(resolveProjectRelation("src/agent/orchestrator.ts", "../tools/index")).toBe("src/tools/index");
    expect(resolveCandidatePath(pathSet, "src/agent/orchestrator.ts", "../tools/index")).toBe("src/tools/index.ts");
  });

  it("可以推断 entry/core/leaf 角色", () => {
    expect(getProjectMapRole("src/cli/index.ts", ["../agent/orchestrator"], [])).toBe("entry");
    expect(getProjectMapRole("src/agent/orchestrator.ts", ["../tools/index"], ["src/cli/index.ts"])).toBe("core");
    expect(getProjectMapRole("src/types/agent.ts", [], ["src/agent/orchestrator.ts"])).toBe("leaf");
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
    expect(result[0]).toHaveProperty("role");
    expect(result[0]).toHaveProperty("score");
  });
});
