import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  logCard,
  logCardList,
  logDiffHeader,
  logDiffLine,
  logRenderedText,
} from "./logger.js";

describe("logger terminal canary snapshots", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "columns", {
      value: undefined,
      configurable: true,
    });
  });

  it("renders stable layout at 60 columns", () => {
    Object.defineProperty(process.stdout, "columns", {
      value: 60,
      configurable: true,
    });

    logCard("终端快照", "### 标题\n- 第一项\n- 第二项");
    logCardList("会话列表", [
      "**session-1** · 修复一个很长很长的标题需要观察换行效果 · 2026-04-21 · 3 轮",
    ]);
    logDiffHeader(`/very/long/path/${"segment/".repeat(8)}file.ts`, "summary");
    logDiffLine(`+ ${"abcdef ".repeat(12)}`);
    logRenderedText(
      [
        "| 字段 | 值 |",
        "| --- | --- |",
        "| 路径 | supercalifragilisticexpialidocious |",
      ].join("\n"),
    );

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toMatchInlineSnapshot(`"
┌─ 终端快照
  标题
  • 第一项
  • 第二项

┌─ 会话列表
  • session-1 · 修复一个很长很长的标题需要观察换行效果 · 2026-04-21 · 3 轮
[INFO] 文件 /very/long/path/segment/segme… · summary
+ abcdef abcdef abcdef abcdef abcdef abcdef abcdef
  abcdef abcdef abcdef abcdef abcdef
  ┌────┬──────────────────────────┐
  │ 字段 │ 值                        │
  ├────┼──────────────────────────┤
  │ 路径 │ supercalifragilisticexpi │
  │    │ alidocious               │
  └────┴──────────────────────────┘"`);
  });

  it("renders stable layout at 100 columns", () => {
    Object.defineProperty(process.stdout, "columns", {
      value: 100,
      configurable: true,
    });

    logRenderedText("### 宽终端\n```ts\nconst value = 1;\n```");
    logDiffLine(`- ${"path/".repeat(20)}`);

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toMatchInlineSnapshot(`"  宽终端
  ┌─ code
    const value = 1;
  └─
- path/path/path/path/path/path/path/path/path/path/path/path/path/path/path/path/path/path/path
  /path/"`);
  });

  it("renders wide tables as cards at 60 columns", () => {
    Object.defineProperty(process.stdout, "columns", {
      value: 60,
      configurable: true,
    });

    logRenderedText(
      [
        "| 项目方向 | 简介 | 亮点 | 所需技能 |",
        "| --- | --- | --- | --- |",
        "| 文档问答系统 | 用户上传 PDF/Word 等文档，系统自动提取内容并回答问题 | 接近真实业务场景，可展示端到端能力 | 文本分块、向量化、向量数据库 |",
      ].join("\n"),
    );

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toMatchInlineSnapshot(`"  ┌─ 文档问答系统
  │ 简介: 用户上传 PDF/Word 等文档，系统自动提取内容并回答问题
  │ 亮点: 接近真实业务场景，可展示端到端能力
  │ 所需技能: 文本分块、向量化、向量数据库
  └─"`);
  });
});
