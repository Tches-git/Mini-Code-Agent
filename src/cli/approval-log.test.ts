import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReadCommandAuditEntries = vi.hoisted(() => vi.fn());

vi.mock("../utils/command-audit.js", () => ({
  readCommandAuditEntries: mockReadCommandAuditEntries,
}));

import { parseApprovalLogQueryText, printApprovalLog } from "./approval-log.js";

describe("printApprovalLog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockReadCommandAuditEntries.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("renders structured approval log output", async () => {
    mockReadCommandAuditEntries.mockResolvedValue([
      {
        timestamp: "2026-04-20T10:00:00.000Z",
        command: "npm run lint -- --fix",
        reason: "### 需要确认",
        decision: "approved",
        source: "tool",
        kind: "command",
        action: "run",
        targetPath: "src/index.ts",
      },
    ]);

    await printApprovalLog({}, { stats: true });

    const calls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(calls).toContain("命令审批记录");
    expect(calls).toContain("npm run lint -- --fix");
    expect(calls).toContain("总记录数");
    expect(calls).toContain("路径");
    expect(calls).toContain("需要确认");
    expect(calls).not.toContain("###");
  });

  it("renders empty approval log state", async () => {
    mockReadCommandAuditEntries.mockResolvedValue([]);

    await printApprovalLog({}, {});

    const calls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(calls).toContain("命令审批记录");
    expect(calls).toContain("暂无匹配的审批记录");
  });

  it("parses structured approval query text", () => {
    const parsed = parseApprovalLogQueryText(
      'decision:approved path:src/index.ts page:2 limit:5 stats json "lint --fix"',
    );

    expect(parsed.filters.decision).toBe("approved");
    expect(parsed.filters.path).toBe("src/index.ts");
    expect(parsed.filters.page).toBe(2);
    expect(parsed.filters.limit).toBe(5);
    expect(parsed.filters.contains).toBe("lint --fix");
    expect(parsed.options.stats).toBe(true);
    expect(parsed.options.json).toBe(true);
  });

  it("paginates approval log output and compresses long reason text", async () => {
    mockReadCommandAuditEntries.mockResolvedValue([
      {
        timestamp: "2026-04-20T10:00:00.000Z",
        command: "cmd-1",
        reason: "很长很长的原因 ".repeat(20),
        decision: "approved",
        source: "tool",
        kind: "command",
        action: "run",
        targetPath: "src/1.ts",
      },
      {
        timestamp: "2026-04-20T09:00:00.000Z",
        command: "cmd-2",
        reason: "reason-2",
        decision: "rejected",
        source: "tool",
        kind: "command",
        action: "run",
        targetPath: "src/2.ts",
      },
    ]);

    await printApprovalLog({ limit: 1, page: 2 }, {});

    const calls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(calls).toContain("页码");
    expect(calls).toContain("2/2");
    expect(calls).toContain("cmd-2");
  });
});
