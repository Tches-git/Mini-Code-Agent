import { beforeEach, describe, expect, it, vi } from "vitest";

const mockConfig = vi.hoisted(() => vi.fn());

vi.mock("dotenv", () => ({
  default: {
    config: mockConfig,
  },
}));

describe("loadWorkspaceEnv", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    mockConfig.mockReset();
    delete process.env.MINI_CLAUDE_CODE_WORKSPACE_ROOT;
  });

  it("loads .env from the configured workspace root", async () => {
    process.env.MINI_CLAUDE_CODE_WORKSPACE_ROOT = "/tmp/workspace";
    const { loadWorkspaceEnv } = await import("./env.js");

    loadWorkspaceEnv();

    expect(mockConfig).toHaveBeenCalledWith({
      path: "/tmp/workspace/.env",
      override: false,
    });
  });
});
