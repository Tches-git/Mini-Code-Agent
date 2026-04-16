import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPathInsideWorkspace,
  isPathOutsideWorkspace,
  normalizeFilePath,
} from "./path.js";

const root = process.cwd();

describe("isPathInsideWorkspace", () => {
  it("相对路径返回 true", () => {
    expect(isPathInsideWorkspace("src/index.ts")).toBe(true);
  });

  it("绝对路径在工作区内返回 true", () => {
    expect(isPathInsideWorkspace(path.join(root, "src/index.ts"))).toBe(true);
  });

  it("../ 逃逸返回 false", () => {
    expect(isPathInsideWorkspace("../outside")).toBe(false);
  });

  it("绝对路径在工作区外返回 false", () => {
    expect(isPathInsideWorkspace("/tmp/outside")).toBe(false);
  });

  it("当前目录返回 true", () => {
    expect(isPathInsideWorkspace(".")).toBe(true);
  });
});

describe("isPathOutsideWorkspace", () => {
  it("工作区内路径返回 false", () => {
    expect(isPathOutsideWorkspace("src/index.ts")).toBe(false);
  });

  it("工作区外路径返回 true", () => {
    expect(isPathOutsideWorkspace("/tmp/outside")).toBe(true);
  });
});

describe("normalizeFilePath", () => {
  it("反斜杠转正斜杠", () => {
    expect(normalizeFilePath("src\\agent\\orchestrator.ts")).toBe(
      "src/agent/orchestrator.ts",
    );
  });

  it("正斜杠不变", () => {
    expect(normalizeFilePath("src/index.ts")).toBe("src/index.ts");
  });
});
