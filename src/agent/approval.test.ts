import { beforeEach, describe, expect, it, vi } from "vitest";

const { getRunCommandPolicyMock, appendCommandAuditMock } = vi.hoisted(() => ({
  getRunCommandPolicyMock: vi.fn(),
  appendCommandAuditMock: vi.fn(),
}));

vi.mock("../tools/command.js", () => ({
  getRunCommandPolicy: getRunCommandPolicyMock,
}));

vi.mock("../utils/command-audit.js", () => ({
  appendCommandAudit: appendCommandAuditMock,
}));

import { ApprovalManager } from "./approval.js";

describe("ApprovalManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRunCommandPolicyMock.mockResolvedValue({
      decision: "confirm",
      reason: "需要确认",
      executable: "npm",
    });
  });

  it("命令无需确认时直接通过", async () => {
    getRunCommandPolicyMock.mockResolvedValueOnce({
      decision: "allow",
      reason: "安全",
      executable: "ls",
    });
    const manager = new ApprovalManager();
    await expect(manager.confirmCommand("ls", [], "tool")).resolves.toBe(true);
    expect(appendCommandAuditMock).not.toHaveBeenCalled();
  });

  it("无确认回调时拒绝守卫命令并写审计", async () => {
    const steps: string[] = [];
    const manager = new ApprovalManager();
    await expect(
      manager.confirmCommand("npm install", steps, "tool"),
    ).resolves.toBe(false);
    expect(steps).toContain("命令已拒绝: npm install");
    expect(appendCommandAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "npm install",
        decision: "rejected",
        source: "tool",
      }),
    );
  });

  it("用户确认后允许守卫命令", async () => {
    const onConfirm = vi.fn().mockResolvedValue(true);
    const manager = new ApprovalManager(onConfirm);
    const steps: string[] = [];
    await expect(
      manager.confirmCommand("npm install", steps, "auto_validate"),
    ).resolves.toBe(true);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "command", command: "npm install" }),
    );
    expect(appendCommandAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "approved",
        source: "auto_validate",
      }),
    );
  });

  it("无确认回调时拒绝工作区外路径访问", async () => {
    const steps: string[] = [];
    const manager = new ApprovalManager();
    await expect(
      manager.confirmExternalPathAccess("read_file", "/tmp/a.txt", steps),
    ).resolves.toBe(false);
    expect(
      steps.some(
        (step) =>
          step.includes("工作区外路径") || step.includes("工作区外文件"),
      ),
    ).toBe(true);
    expect(appendCommandAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "file_access read_file /tmp/a.txt",
        decision: "rejected",
      }),
    );
  });

  it("project_map 访问工作区外目录时也要求确认", async () => {
    const steps: string[] = [];
    const manager = new ApprovalManager();
    await expect(
      manager.confirmExternalPathAccess("project_map", "/tmp/project", steps),
    ).resolves.toBe(false);
    expect(
      steps.some(
        (step) => step.includes("工作区外路径") || step.includes("读取"),
      ),
    ).toBe(true);
  });

  it("glob_files 访问工作区外目录时按列目录确认", async () => {
    const onConfirm = vi.fn().mockResolvedValue(true);
    const steps: string[] = [];
    const manager = new ApprovalManager(onConfirm);

    await expect(
      manager.confirmExternalPathAccess("glob_files", "/tmp/project", steps),
    ).resolves.toBe(true);

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "external_path",
        path: "/tmp/project",
        action: "list",
      }),
    );
  });

  it("外部文件导入确认通过后记录 approved", async () => {
    const onConfirm = vi.fn().mockResolvedValue(true);
    const manager = new ApprovalManager(onConfirm);
    await expect(
      manager.confirmExternalFileImport(
        "/tmp/a.docx",
        undefined,
        "extract_text",
        [],
      ),
    ).resolves.toBe(true);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "external_file",
        path: "/tmp/a.docx",
        mode: "extract_text",
      }),
    );
    expect(appendCommandAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "import_external_file /tmp/a.docx",
        decision: "approved",
      }),
    );
  });
});
