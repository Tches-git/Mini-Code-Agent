import { beforeEach, describe, expect, it, vi } from "vitest";

const mockBuildStandaloneExecutable = vi.hoisted(() => vi.fn());
const mockLogHint = vi.hoisted(() => vi.fn());
const mockLogKeyValue = vi.hoisted(() => vi.fn());
const mockLogSection = vi.hoisted(() => vi.fn());
const mockLogSuccess = vi.hoisted(() => vi.fn());

vi.mock("../release/standalone.js", () => ({
  buildStandaloneExecutable: mockBuildStandaloneExecutable,
}));

vi.mock("../utils/logger.js", () => ({
  logHint: mockLogHint,
  logKeyValue: mockLogKeyValue,
  logSection: mockLogSection,
  logSuccess: mockLogSuccess,
}));

describe("runReleaseStandaloneCommand", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockBuildStandaloneExecutable.mockReset().mockResolvedValue({
      outputPath: "/tmp/out/mini-claude-code",
      artifactFileName: "mini-claude-code-darwin-arm64",
      configPath: "/tmp/sea-config.json",
    });
    mockLogHint.mockReset();
    mockLogKeyValue.mockReset();
    mockLogSection.mockReset();
    mockLogSuccess.mockReset();
  });

  it("logs output path and artifact name", async () => {
    const { runReleaseStandaloneCommand } = await import("./release.js");

    await runReleaseStandaloneCommand();

    expect(mockLogKeyValue).toHaveBeenCalledWith("可执行文件", "/tmp/out/mini-claude-code");
    expect(mockLogKeyValue).toHaveBeenCalledWith("发布文件名", "mini-claude-code-darwin-arm64");
  });
});
