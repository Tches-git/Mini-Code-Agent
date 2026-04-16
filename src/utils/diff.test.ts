import { describe, expect, it } from "vitest";
import { buildDiffPreview } from "./diff.js";

describe("buildDiffPreview", () => {
  it("returns (no changes) when before and after are identical", () => {
    const result = buildDiffPreview("hello\nworld", "hello\nworld");
    expect(result).toContain("(no changes)");
    expect(result).toContain("--- before");
    expect(result).toContain("+++ after");
  });

  it("shows all lines as additions for a new file", () => {
    const result = buildDiffPreview("", "line1\nline2\nline3");
    const lines = result.split("\n");
    const contentLines = lines.filter(
      (l) => l.startsWith("+") && !l.startsWith("+++"),
    );
    expect(contentLines).toEqual(["+line1", "+line2", "+line3"]);
  });

  it("shows all lines as deletions when deleting all content", () => {
    const result = buildDiffPreview("line1\nline2\nline3", "");
    const lines = result.split("\n");
    const contentLines = lines.filter(
      (l) => l.startsWith("-") && !l.startsWith("---"),
    );
    expect(contentLines).toEqual(["-line1", "-line2", "-line3"]);
  });

  it("produces unified diff with @@ hunk header for a simple replacement", () => {
    const before = "aaa\nbbb\nccc";
    const after = "aaa\nBBB\nccc";
    const result = buildDiffPreview(before, after);
    expect(result).toMatch(/@@ .+ @@/);
    expect(result).toContain("-bbb");
    expect(result).toContain("+BBB");
  });

  it("uses a/path and b/path headers when path is provided", () => {
    const result = buildDiffPreview("a", "b", "src/foo.ts");
    expect(result).toContain("--- a/src/foo.ts");
    expect(result).toContain("+++ b/src/foo.ts");
  });

  it("uses --- before / +++ after headers when path is omitted", () => {
    const result = buildDiffPreview("a", "b");
    expect(result).toContain("--- before");
    expect(result).toContain("+++ after");
  });

  it("shows context lines around changes (default 3)", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`);
    const before = lines.join("\n");
    const afterLines = [...lines];
    afterLines[5] = "CHANGED";
    const after = afterLines.join("\n");

    const result = buildDiffPreview(before, after);
    // 3 context lines before the change
    expect(result).toContain(" line2");
    expect(result).toContain(" line3");
    expect(result).toContain(" line4");
    // the change itself
    expect(result).toContain("-line5");
    expect(result).toContain("+CHANGED");
    // up to 3 context lines after the change
    expect(result).toContain(" line7");
    expect(result).toContain(" line8");
    expect(result).toContain(" line9");
    // line1 should NOT appear (too far before change; only 3 context lines kept)
    expect(result).not.toMatch(/^ line1$/m);
    expect(result).not.toMatch(/^ line0$/m);
  });

  it("handles insertion of a line in the middle", () => {
    const before = "aaa\nccc";
    const after = "aaa\nbbb\nccc";
    const result = buildDiffPreview(before, after);
    expect(result).toContain("+bbb");
    const deletions = result
      .split("\n")
      .filter((l) => l.startsWith("-") && !l.startsWith("---"));
    expect(deletions).toHaveLength(0);
  });

  it("produces separate @@ hunks for changes far apart", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
    const before = lines.join("\n");
    const afterLines = [...lines];
    afterLines[1] = "CHANGED1";
    afterLines[18] = "CHANGED18";
    const after = afterLines.join("\n");

    const result = buildDiffPreview(before, after);
    const hunkHeaders = result.split("\n").filter((l) => l.startsWith("@@"));
    expect(hunkHeaders.length).toBe(2);
  });

  it("produces inline change hints with [-...-] and {+...+} markers", () => {
    const before = "hello world foo";
    const after = "hello earth foo";
    const result = buildDiffPreview(before, after);
    expect(result).toContain("? old inline:");
    expect(result).toContain("? new inline:");
    expect(result).toMatch(/\[-.*-\]/);
    expect(result).toMatch(/\{\+.*\+\}/);
  });
});
