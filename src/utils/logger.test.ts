import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  logCard,
  logCardList,
  logDetailEntries,
  logDiffHeader,
  logDiffLine,
  logHint,
  logKeyValue,
  logLine,
  logListItem,
  logRenderedText,
  logStatusLine,
  logStep,
  renderRichTextLines,
} from "./logger.js";

describe("renderRichTextLines", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("removes raw markdown heading markers", () => {
    const lines = renderRichTextLines("### 标题");
    expect(lines.join("\n")).toContain("标题");
    expect(lines.join("\n")).not.toContain("###");
  });

  it("renders markdown tables into box-style rows", () => {
    const lines = renderRichTextLines(
      ["| 列1 | 列2 |", "| --- | --- |", "| 值A | 值B |"].join("\n"),
    );
    const output = lines.join("\n");
    expect(output).toContain("┌");
    expect(output).toContain("│");
    expect(output).toContain("列1");
    expect(output).toContain("值A");
  });

  it("wraps long plain text into multiple lines", () => {
    const originalColumns = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", {
      value: 60,
      configurable: true,
    });

    const lines = renderRichTextLines(
      "这是一段很长很长的纯文本，用来验证 terminal rendering automatically wraps long English segments instead of overflowing into a single line.",
    );

    expect(lines.length).toBeGreaterThan(1);

    Object.defineProperty(process.stdout, "columns", {
      value: originalColumns,
      configurable: true,
    });
  });

  it("wraps table cells instead of hard truncating them", () => {
    const originalColumns = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", {
      value: 60,
      configurable: true,
    });

    const lines = renderRichTextLines(
      [
        "| 列1 | 列2 |",
        "| --- | --- |",
        "| short | supercalifragilisticexpialidocious |",
      ].join("\n"),
    );

    expect(lines.join("\n")).toContain("superc");
    expect(lines.length).toBeGreaterThan(5);

    Object.defineProperty(process.stdout, "columns", {
      value: originalColumns,
      configurable: true,
    });
  });

  it("keeps code blocks rendered as code sections", () => {
    const lines = renderRichTextLines(
      ["```ts", "const path = '/very/long/path';", "```"].join("\n"),
    );
    expect(lines.join("\n")).toContain("┌─ code");
    expect(lines.join("\n")).toContain("const path");
  });

  it("degrades wide multi-column tables into card layout on narrow terminals", () => {
    const originalColumns = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", {
      value: 60,
      configurable: true,
    });

    const lines = renderRichTextLines(
      [
        "| 项目方向 | 简介 | 亮点 | 所需技能 |",
        "| --- | --- | --- | --- |",
        "| 文档问答系统 | 用户上传 PDF/Word 等文档，系统自动提取内容并回答问题 | 接近真实业务场景，可展示端到端能力 | 文本分块、向量化、向量数据库 |",
      ].join("\n"),
    );

    const output = lines.join("\n");
    expect(output).toContain("┌─ 文档问答系统");
    expect(output).toContain("简介:");
    expect(output).toContain("所需技能:");
    expect(output).not.toContain("┬");

    Object.defineProperty(process.stdout, "columns", {
      value: originalColumns,
      configurable: true,
    });
  });
});

describe("logger console helpers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("logRenderedText prints rendered lines without raw markdown markers", () => {
    logRenderedText("**加粗标题**\n- 列表项");
    const calls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(calls).toContain("加粗标题");
    expect(calls).toContain("列表项");
    expect(calls).not.toContain("**");
  });

  it("logLine uses rich text rendering", () => {
    logLine("### 小节");
    const calls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(calls).toContain("小节");
    expect(calls).not.toContain("###");
  });

  it("logStep wraps long text into indented continuation lines", () => {
    const originalColumns = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", {
      value: 60,
      configurable: true,
    });

    logStep(
      1,
      "这是一个很长的步骤描述，用来验证 step output automatically wraps long English guidance and keeps indentation aligned across multiple lines.",
    );
    expect(vi.mocked(console.log).mock.calls.length).toBeGreaterThan(1);

    Object.defineProperty(process.stdout, "columns", {
      value: originalColumns,
      configurable: true,
    });
  });

  it("logListItem keeps markdown headings out of bullet output", () => {
    logListItem("### 条目标题");
    const calls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(calls).toContain("条目标题");
    expect(calls).not.toContain("###");
  });

  it("logKeyValue strips heading markers from values", () => {
    logKeyValue("说明", "### 已整理");
    const calls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(calls).toContain("已整理");
    expect(calls).not.toContain("###");
  });

  it("logStatusLine renders unified status tags", () => {
    logStatusLine("PASS", "### 已通过");
    const calls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(calls).toContain("[PASS]");
    expect(calls).toContain("已通过");
    expect(calls).not.toContain("###");
  });

  it("logHint strips markdown heading markers", () => {
    logHint("### 提示信息");
    const calls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(calls).toContain("提示信息");
    expect(calls).not.toContain("###");
  });

  it("logCard renders section title and body together", () => {
    logCard("### 卡片", "**内容**");
    const calls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(calls).toContain("卡片");
    expect(calls).toContain("内容");
    expect(calls).not.toContain("###");
  });

  it("logCardList renders empty state and list items", () => {
    logCardList("列表卡片", []);
    logCardList("列表卡片", ["### 条目 A"]);
    const calls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(calls).toContain("暂无内容");
    expect(calls).toContain("条目 A");
    expect(calls).not.toContain("###");
  });

  it("logDetailEntries renders grouped key values", () => {
    logDetailEntries([{ label: "风险", value: "### 高" }]);
    const calls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(calls).toContain("风险");
    expect(calls).toContain("高");
    expect(calls).not.toContain("###");
  });

  it("logDiffHeader truncates very long paths", () => {
    logDiffHeader(`/very/long/path/${"segment/".repeat(20)}file.ts`, "summary");
    const calls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(calls).toContain("文件");
    expect(calls).toContain("summary");
    expect(calls).toContain("…");
  });

  it("logDiffLine wraps long diff lines", () => {
    const originalColumns = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", {
      value: 60,
      configurable: true,
    });

    logDiffLine(`+ ${"abcdef ".repeat(20)}`);
    expect(vi.mocked(console.log).mock.calls.length).toBeGreaterThan(1);

    Object.defineProperty(process.stdout, "columns", {
      value: originalColumns,
      configurable: true,
    });
  });
});
