import { describe, expect, it } from "vitest";
import { getSubtaskTools, subtaskTools } from "./subtask.js";

describe("subtask tools", () => {
  it("only exposes read-only tools to subagents", () => {
    const names = getSubtaskTools().map((tool) => tool.name);
    expect(names).toContain("read_file");
    expect(names).toContain("search_text");
    expect(names).toContain("project_map");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("run_command");
    expect(names).not.toContain("git_commit");
  });

  it("includes single and batch task tools", () => {
    expect(subtaskTools.map((tool) => tool.name)).toEqual([
      "task",
      "task_batch",
    ]);
  });
});
