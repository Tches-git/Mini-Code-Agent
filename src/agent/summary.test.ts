import { describe, it, expect } from "vitest";
import type { ChatMessage } from "../types/agent.js";
import {
  summarizeRemovedMessage,
  deriveFocusFromMessage,
  deriveFocusFromPaths,
  mergeSummaryFocus,
  compactSummaryLines,
  type SummaryFocus
} from "./summary.js";

describe("summarizeRemovedMessage", () => {
  it("用户消息生成任务摘要", () => {
    const msg: ChatMessage = { role: "user", content: "修复 src/index.ts 里的 bug" };
    const lines = summarizeRemovedMessage(msg);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("用户任务:");
    expect(lines[0]).toContain("修复");
  });

  it("assistant 纯文本消息生成结论摘要", () => {
    const msg: ChatMessage = { role: "assistant", content: "已完成修复，构建通过。" };
    const lines = summarizeRemovedMessage(msg);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("助手结论:");
  });

  it("assistant 带 tool_calls 生成工具调用摘要", () => {
    const msg: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "1", type: "function", function: { name: "read_file", arguments: '{"path":"src/index.ts"}' } }
      ]
    };
    const lines = summarizeRemovedMessage(msg);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("文件操作:");
    expect(lines[0]).toContain("src/index.ts");
  });

  it("assistant 带搜索工具生成搜索摘要", () => {
    const msg: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "1", type: "function", function: { name: "search_text", arguments: '{"query":"TODO"}' } }
      ]
    };
    const lines = summarizeRemovedMessage(msg);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("代码搜索:");
    expect(lines[0]).toContain("TODO");
  });

  it("assistant 带命令工具生成命令摘要", () => {
    const msg: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "1", type: "function", function: { name: "run_command", arguments: '{"command":"npm run build"}' } }
      ]
    };
    const lines = summarizeRemovedMessage(msg);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("计划命令:");
  });

  it("tool run_command 结果生成命令结果摘要", () => {
    const msg: ChatMessage = {
      role: "tool",
      tool_call_id: "1",
      name: "run_command",
      content: '{"command":"npm run build","exitCode":0,"stdout":"ok","stderr":""}'
    };
    const lines = summarizeRemovedMessage(msg);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("命令结果:");
    expect(lines[0]).toContain("exit 0");
  });

  it("tool 普通结果生成工具摘要", () => {
    const msg: ChatMessage = {
      role: "tool",
      tool_call_id: "1",
      name: "read_file",
      content: "文件内容..."
    };
    const lines = summarizeRemovedMessage(msg);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("工具 read_file:");
  });

  it("摘要消息本身返回空数组", () => {
    const msg: ChatMessage = {
      role: "assistant",
      content: "[会话摘要]\n- 之前做了一些事情"
    };
    const lines = summarizeRemovedMessage(msg);
    expect(lines).toHaveLength(0);
  });

  it("空内容消息返回空数组", () => {
    const msg: ChatMessage = { role: "assistant", content: null };
    const lines = summarizeRemovedMessage(msg);
    expect(lines).toHaveLength(0);
  });

  it("长文本被截断", () => {
    const msg: ChatMessage = { role: "user", content: "a".repeat(500) };
    const lines = summarizeRemovedMessage(msg);
    expect(lines).toHaveLength(1);
    expect(lines[0].length).toBeLessThan(200);
    expect(lines[0]).toContain("...");
  });
});

describe("deriveFocusFromMessage", () => {
  it("用户消息提取关键词", () => {
    const msg: ChatMessage = { role: "user", content: "修复 estimateTokens 函数" };
    const focus = deriveFocusFromMessage(msg);
    expect(focus.keywords).toContain("estimatetokens");
  });

  it("用户消息提取文件路径", () => {
    const msg: ChatMessage = { role: "user", content: "读取 src/utils/token.ts" };
    const focus = deriveFocusFromMessage(msg);
    expect(focus.files.some((f) => f.includes("token.ts"))).toBe(true);
  });

  it("assistant tool_calls 提取文件参数", () => {
    const msg: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "1", type: "function", function: { name: "read_file", arguments: '{"path":"src/agent/orchestrator.ts"}' } }
      ]
    };
    const focus = deriveFocusFromMessage(msg);
    expect(focus.files.some((f) => f.includes("orchestrator.ts"))).toBe(true);
    expect(focus.keywords).toContain("read_file");
  });

  it("assistant tool_calls 提取搜索关键词", () => {
    const msg: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "1", type: "function", function: { name: "search_text", arguments: '{"query":"getRunCommandPolicy"}' } }
      ]
    };
    const focus = deriveFocusFromMessage(msg);
    expect(focus.keywords).toContain("getruncommandpolicy");
  });

  it("tool run_command 提取命令关键词", () => {
    const msg: ChatMessage = {
      role: "tool",
      tool_call_id: "1",
      name: "run_command",
      content: '{"command":"npm run build","exitCode":0}'
    };
    const focus = deriveFocusFromMessage(msg);
    expect(focus.keywords.some((k) => k.includes("npm"))).toBe(true);
  });

  it("空消息返回空焦点", () => {
    const msg: ChatMessage = { role: "assistant", content: null };
    const focus = deriveFocusFromMessage(msg);
    expect(focus.files).toHaveLength(0);
    expect(focus.keywords).toHaveLength(0);
  });
});

describe("deriveFocusFromPaths", () => {
  it("单路径提取文件名和目录", () => {
    const focus = deriveFocusFromPaths(["src/utils/token.ts"]);
    expect(focus.files.some((f) => f.includes("token.ts"))).toBe(true);
    expect(focus.keywords.some((k) => k === "token")).toBe(true);
  });

  it("多路径合并", () => {
    const focus = deriveFocusFromPaths(["src/a.ts", "src/b.ts"]);
    expect(focus.files.some((f) => f.includes("a.ts"))).toBe(true);
    expect(focus.files.some((f) => f.includes("b.ts"))).toBe(true);
  });

  it("空路径返回空焦点", () => {
    const focus = deriveFocusFromPaths([]);
    expect(focus.files).toHaveLength(0);
    expect(focus.keywords).toHaveLength(0);
  });
});

describe("mergeSummaryFocus", () => {
  it("合并两个焦点对象", () => {
    const a: SummaryFocus = { files: ["a.ts"], keywords: ["hello"] };
    const b: SummaryFocus = { files: ["b.ts"], keywords: ["world"] };
    const merged = mergeSummaryFocus(a, b);
    expect(merged.files).toContain("a.ts");
    expect(merged.files).toContain("b.ts");
    expect(merged.keywords).toContain("hello");
    expect(merged.keywords).toContain("world");
  });

  it("去重", () => {
    const a: SummaryFocus = { files: ["a.ts"], keywords: ["hello"] };
    const b: SummaryFocus = { files: ["a.ts"], keywords: ["hello"] };
    const merged = mergeSummaryFocus(a, b);
    expect(merged.files.filter((f) => f === "a.ts")).toHaveLength(1);
    expect(merged.keywords.filter((k) => k === "hello")).toHaveLength(1);
  });

  it("合并空焦点", () => {
    const a: SummaryFocus = { files: [], keywords: [] };
    const b: SummaryFocus = { files: ["b.ts"], keywords: ["test"] };
    const merged = mergeSummaryFocus(a, b);
    expect(merged.files).toEqual(["b.ts"]);
    expect(merged.keywords).toEqual(["test"]);
  });
});

describe("compactSummaryLines", () => {
  const emptyFocus: SummaryFocus = { files: [], keywords: [] };

  it("行数未超限直接返回", () => {
    const lines = ["line1", "line2", "line3"];
    const result = compactSummaryLines(lines, emptyFocus, 10);
    expect(result).toEqual(lines);
  });

  it("超限时裁剪到指定行数", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
    const result = compactSummaryLines(lines, emptyFocus, 10);
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it("优先保留与焦点文件匹配的行", () => {
    const irrelevantLines = Array.from({ length: 30 }, (_, i) => `完全无关的操作-${i}`);
    const lines = [
      ...irrelevantLines.slice(0, 15),
      "文件操作: read_file src/utils/token.ts",
      "文件操作: write_file src/utils/token.ts",
      ...irrelevantLines.slice(15)
    ];
    const focus: SummaryFocus = { files: ["src/utils/token.ts", "token.ts"], keywords: ["token"] };
    const result = compactSummaryLines(lines, focus, 8);
    const tokenLines = result.filter((l) => l.includes("token.ts"));
    expect(tokenLines.length).toBeGreaterThanOrEqual(1);
  });

  it("优先保留与焦点关键词匹配的行", () => {
    const lines = [
      "命令结果: npm run build -> exit 0",
      ...Array.from({ length: 20 }, (_, i) => `无关行-${i}`),
      "命令结果: npm run test -> exit 1"
    ];
    const focus: SummaryFocus = { files: [], keywords: ["npm", "build"] };
    const result = compactSummaryLines(lines, focus, 5);
    const npmLines = result.filter((l) => l.includes("npm"));
    expect(npmLines.length).toBeGreaterThanOrEqual(1);
  });

  it("去重后再裁剪", () => {
    const lines = ["重复行", "重复行", "重复行", "唯一行"];
    const result = compactSummaryLines(lines, emptyFocus, 10);
    expect(result.filter((l) => l === "重复行")).toHaveLength(1);
    expect(result).toContain("唯一行");
  });
});
