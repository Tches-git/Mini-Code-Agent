import { beforeEach, describe, expect, it, vi } from "vitest";

const mockModelsList = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
  default: class {
    models = { list: mockModelsList };
    chat = {
      completions: {
        create: mockCreate,
      },
    };
  },
}));

beforeEach(() => {
  vi.restoreAllMocks();
  mockModelsList.mockReset();
  mockCreate.mockReset();
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.OPENAI_BASE_URL;
  process.env.MODEL_NAME = "gpt-5.4";
});

describe("LlmClient.checkConnectivity", () => {
  it("requires both model discovery and tool-calling probe success", async () => {
    const { LlmClient } = await import("./client.js");
    mockModelsList.mockResolvedValue({
      data: [{ id: "gpt-5.4" }],
    });
    mockCreate.mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: {
                      name: "ping",
                      arguments: '{"message":"ok"}',
                    },
                  },
                ],
              },
            },
          ],
        };
      },
    });

    const result = await new LlmClient().checkConnectivity();

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("chat/tool-calling 探测");
  });

  it("reports partial success when model exists but tool-calling probe fails", async () => {
    const { LlmClient } = await import("./client.js");
    mockModelsList.mockResolvedValue({
      data: [{ id: "gpt-5.4" }],
    });
    mockCreate.mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          choices: [{ delta: { content: "pong" } }],
        };
      },
    });

    const result = await new LlmClient().checkConnectivity();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("tool-calling 探测未通过");
  });

  it("accepts providers where models.list fails but chat tool-calling works", async () => {
    const { LlmClient } = await import("./client.js");
    mockModelsList.mockRejectedValue(new Error("404 models unsupported"));
    mockCreate.mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: {
                      name: "ping",
                      arguments: '{"message":"ok"}',
                    },
                  },
                ],
              },
            },
          ],
        };
      },
    });

    const result = await new LlmClient().checkConnectivity();

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("models.list 不可用");
  });
});
