import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWriteEnvTemplate = vi.hoisted(() => vi.fn());
const mockGetRuntimeEnvInfo = vi.hoisted(() => vi.fn());
const mockCheckConnectivity = vi.hoisted(() => vi.fn());
const mockExeca = vi.hoisted(() => vi.fn());
const mockAgentRun = vi.hoisted(() => vi.fn());
const mockStartInteractive = vi.hoisted(() => vi.fn());
const mockPrintApprovalLog = vi.hoisted(() => vi.fn());
const mockPrintSessions = vi.hoisted(() => vi.fn());
const mockPrintSessionDetail = vi.hoisted(() => vi.fn());
const mockRunBenchmarkCommand = vi.hoisted(() => vi.fn());
const mockSetWorkspaceRoot = vi.hoisted(() => vi.fn());
const mockGetWorkspaceRoot = vi.hoisted(() => vi.fn(() => "/tmp/workspace"));
const mockGetAppDataDir = vi.hoisted(() => vi.fn(() => "/tmp/home/.mini-claude-code"));

vi.mock("../llm/env.js", () => ({
  writeEnvTemplate: mockWriteEnvTemplate,
  getRuntimeEnvInfo: mockGetRuntimeEnvInfo,
}));

vi.mock("../llm/client.js", () => ({
  LlmClient: class {
    checkConnectivity = mockCheckConnectivity;
  },
}));

vi.mock("execa", () => ({
  execa: mockExeca,
}));

vi.mock("../agent/orchestrator.js", () => ({
  AgentOrchestrator: class {
    run = mockAgentRun;
  },
}));

vi.mock("./interactive.js", () => ({
  startInteractive: mockStartInteractive,
}));

vi.mock("./approval-log.js", async () => {
  const actual = await vi.importActual<typeof import("./approval-log.js")>("./approval-log.js");
  return {
    ...actual,
    printApprovalLog: mockPrintApprovalLog,
  };
});

vi.mock("./sessions.js", () => ({
  printSessions: mockPrintSessions,
  printSessionDetail: mockPrintSessionDetail,
}));

vi.mock("./benchmark.js", () => ({
  runBenchmarkCommand: mockRunBenchmarkCommand,
}));

vi.mock("../utils/runtime.js", () => ({
  setWorkspaceRoot: mockSetWorkspaceRoot,
  getWorkspaceRoot: mockGetWorkspaceRoot,
  getAppDataDir: mockGetAppDataDir,
  getWorkspaceStateDir: () => "/tmp/home/.mini-claude-code/workspaces/demo",
}));

import { runCli, runDoctorCommand, runInitCommand, runTaskCommand } from "./index.js";

describe("cli index output", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockWriteEnvTemplate.mockReset();
    mockGetRuntimeEnvInfo.mockReset().mockReturnValue({
      hasEnvFile: false,
      envFilePath: ".env",
      openaiApiKeyConfigured: false,
      openaiBaseUrl: "",
      modelName: "gpt-test",
    });
    mockCheckConnectivity.mockReset().mockResolvedValue({ ok: true, detail: "ok" });
    mockExeca.mockReset().mockResolvedValue({ stdout: "ripgrep 14.1.0" });
    mockAgentRun.mockReset().mockResolvedValue({
      steps: [],
      diffs: [],
      finalText: "### 已完成",
    });
    mockStartInteractive.mockReset();
    mockPrintApprovalLog.mockReset();
    mockPrintSessions.mockReset();
    mockPrintSessionDetail.mockReset();
    mockRunBenchmarkCommand.mockReset();
    mockSetWorkspaceRoot.mockReset();
    mockGetWorkspaceRoot.mockReset().mockReturnValue("/tmp/workspace");
    mockGetAppDataDir.mockReset().mockReturnValue("/tmp/home/.mini-claude-code");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("renders init output with key-value and hint blocks", async () => {
    mockWriteEnvTemplate.mockResolvedValue({
      overwritten: false,
      path: "### .env",
    });

    await runInitCommand({ cwd: "/tmp/workspace" });

    const calls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(calls).toContain("初始化完成");
    expect(calls).toContain("结果");
    expect(calls).toContain("路径");
    expect(calls).toContain("工作区");
    expect(calls).toContain("用户数据目录");
    expect(calls).toContain("下一步");
    expect(calls).not.toContain("###");
    expect(mockSetWorkspaceRoot).toHaveBeenCalledWith("/tmp/workspace");
  });

  it("renders doctor output as status blocks and hint", async () => {
    await runDoctorCommand({ ping: false, cwd: "/tmp/workspace" });

    const calls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(calls).toContain("环境自检");
    expect(calls).toContain("工作区");
    expect(calls).toContain("用户数据目录");
    expect(calls).toContain("整体状态");
    expect(calls).toContain("检查详情");
    expect(calls).toContain("[FAIL]");
    expect(calls).toContain("OPENAI_API_KEY");
    expect(calls).toContain("可先运行");
  });

  it("supports doctor json output without formatted blocks", async () => {
    await runDoctorCommand({ json: true });

    const payload = vi.mocked(console.log).mock.calls[0]?.[0];
    expect(typeof payload).toBe("string");
    expect(String(payload)).toContain('"checks"');
    expect(String(payload)).toContain('"ok"');
  });

  it("renders single-run empty states and cleaned final text", async () => {
    await runTaskCommand("### 调整输出", { yes: false, cwd: "/tmp/workspace" });

    const calls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(calls).toContain("用户任务");
    expect(calls).toContain("工作区");
    expect(calls).toContain("用户数据目录");
    expect(calls).toContain("目标");
    expect(calls).toContain("变更预览");
    expect(calls).toContain("本次执行未修改文件");
    expect(calls).toContain("已完成");
    expect(calls).not.toContain("###");
  });

  it("runCli routes approvals query text through parser-aware filters", async () => {
    await runCli([
      "node",
      "mini-claude-code",
      "approvals",
      "decision:approved stats json path:src/index.ts page:2",
    ]);

    expect(mockPrintApprovalLog).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "approved",
        path: "src/index.ts",
        page: 2,
      }),
      expect.objectContaining({ json: true, stats: true }),
    );
  });

  it("runCli routes sessions json command to sessions printer", async () => {
    await runCli(["node", "mini-claude-code", "sessions", "--json", "--sort", "turns"]);
    expect(mockPrintSessions).toHaveBeenCalledWith({ json: true, limit: 10, page: 1, sort: "turns" });
  });

  it("runCli routes session detail json command", async () => {
    await runCli(["node", "mini-claude-code", "session", "session-1", "--json"]);
    expect(mockPrintSessionDetail).toHaveBeenCalledWith("session-1", { json: true });
  });

  it("runCli enters interactive mode when no task is provided", async () => {
    await runCli(["node", "mini-claude-code"]);
    expect(mockStartInteractive).toHaveBeenCalled();
  });

  it("runCli forwards explicit workspace to interactive mode", async () => {
    await runCli(["node", "mini-claude-code", "--cwd", "/tmp/demo", "-i"]);
    expect(mockStartInteractive).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/demo" }),
    );
  });

  it("package scripts include terminal ui guard command", async () => {
    const packageJson = await import("../../package.json", { with: { type: "json" } });
    expect(packageJson.default.scripts["guard:terminal-ui"]).toBe("npm test && npm run build");
  });
});
