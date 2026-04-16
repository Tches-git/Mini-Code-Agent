import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../types/agent.js";
import {
  estimateMessageTokens,
  estimateTokens,
  estimateTotalTokens,
  isSummaryMessage,
  SUMMARY_MESSAGE_PREFIX,
  trimMessagesWithMetadata,
} from "./token.js";

const msg = (
  role: ChatMessage["role"],
  content: string | null,
  extra?: Partial<ChatMessage>,
): ChatMessage => ({
  role,
  content,
  ...extra,
});

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates English text at ~0.3 per char", () => {
    // "hello" = 5 chars * 0.3 = 1.5 → ceil → 2, max(1,2)=2
    expect(estimateTokens("hello")).toBe(2);
  });

  it("estimates Chinese text at 2 per char", () => {
    // "你好" = 2 chars * 2 = 4
    expect(estimateTokens("你好")).toBe(4);
  });

  it("handles mixed text", () => {
    // "hi你" = 2*0.3 + 1*2 = 2.6 → ceil → 3
    expect(estimateTokens("hi你")).toBe(3);
  });
});

describe("estimateMessageTokens", () => {
  it("adds META_OVERHEAD=4 to content tokens", () => {
    const m = msg("user", "hello");
    expect(estimateMessageTokens(m)).toBe(estimateTokens("hello") + 4);
  });

  it("includes tool_calls tokens", () => {
    const m = msg("assistant", null, {
      tool_calls: [
        {
          id: "1",
          type: "function",
          function: { name: "read", arguments: '{"a":1}' },
        },
      ],
    });
    // 4 (overhead) + 0 (null content) + estimateTokens("read") + estimateTokens('{"a":1}') + 4
    const expected = 4 + estimateTokens("read") + estimateTokens('{"a":1}') + 4;
    expect(estimateMessageTokens(m)).toBe(expected);
  });

  it("handles null content", () => {
    const m = msg("assistant", null);
    expect(estimateMessageTokens(m)).toBe(4);
  });
});

describe("estimateTotalTokens", () => {
  it("sums all message tokens", () => {
    const msgs = [msg("system", "sys"), msg("user", "hi")];
    expect(estimateTotalTokens(msgs)).toBe(
      estimateMessageTokens(msgs[0]) + estimateMessageTokens(msgs[1]),
    );
  });
});

describe("isSummaryMessage", () => {
  it("returns true for assistant message starting with SUMMARY_MESSAGE_PREFIX", () => {
    expect(
      isSummaryMessage(msg("assistant", `${SUMMARY_MESSAGE_PREFIX}内容`)),
    ).toBe(true);
  });

  it("returns false for user message with prefix", () => {
    expect(isSummaryMessage(msg("user", `${SUMMARY_MESSAGE_PREFIX}内容`))).toBe(
      false,
    );
  });

  it("returns false for undefined", () => {
    expect(isSummaryMessage(undefined)).toBe(false);
  });

  it("returns false for assistant message without prefix", () => {
    expect(isSummaryMessage(msg("assistant", "normal reply"))).toBe(false);
  });
});

describe("trimMessagesWithMetadata", () => {
  const longContent = "a".repeat(1000);

  it("returns all messages unchanged when under budget", () => {
    const msgs = [msg("system", "s"), msg("user", "hi")];
    const result = trimMessagesWithMetadata(msgs, 99999);
    expect(result.messages).toBe(msgs);
    expect(result.removed).toEqual([]);
  });

  it("removes oldest non-protected messages when over budget", () => {
    const msgs = [
      msg("system", "s"),
      msg("user", longContent), // index 1 — removable
      msg("user", "a"), // index 2
      msg("user", "b"), // index 3
      msg("user", "c"), // index 4
      msg("user", "d"), // index 5
      msg("user", "e"), // index 6 — last 4 protected
    ];
    const budget = estimateTotalTokens(msgs) - 1;
    const result = trimMessagesWithMetadata(msgs, budget);
    expect(result.removed.length).toBeGreaterThan(0);
    expect(result.removed[0].content).toBe(longContent);
  });

  it("protects system message at index 0 and last 4 messages", () => {
    const msgs = [
      msg("system", "sys"),
      msg("user", longContent),
      msg("user", "k1"),
      msg("user", "k2"),
      msg("user", "k3"),
      msg("user", "k4"),
    ];
    const budget = estimateMessageTokens(msgs[0]) + 4 * 5; // very tight
    const result = trimMessagesWithMetadata(msgs, budget);
    expect(result.messages[0].role).toBe("system");
    expect(result.messages.length).toBeGreaterThanOrEqual(5); // system + last 4
  });

  it("protects summary message at index 1", () => {
    const summary = msg("assistant", `${SUMMARY_MESSAGE_PREFIX}摘要`);
    const msgs = [
      msg("system", "sys"),
      summary,
      msg("user", longContent),
      msg("user", "a"),
      msg("user", "b"),
      msg("user", "c"),
      msg("user", "d"),
    ];
    const budget = estimateTotalTokens(msgs) - 1;
    const result = trimMessagesWithMetadata(msgs, budget);
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[1]).toBe(summary);
    expect(result.removed.some((m) => m === summary)).toBe(false);
  });

  it("removes assistant+tool message pairs together", () => {
    const toolCallMsg = msg("assistant", null, {
      tool_calls: [
        {
          id: "tc1",
          type: "function",
          function: { name: "f", arguments: "{}" },
        },
      ],
    });
    const toolResultMsg = msg("tool", "result", { tool_call_id: "tc1" });
    const msgs = [
      msg("system", "sys"),
      toolCallMsg,
      toolResultMsg,
      msg("user", "a"),
      msg("user", "b"),
      msg("user", "c"),
      msg("user", "d"),
    ];
    const budget = estimateTotalTokens(msgs) - 1;
    const result = trimMessagesWithMetadata(msgs, budget);
    expect(result.removed).toContain(toolCallMsg);
    expect(result.removed).toContain(toolResultMsg);
  });

  it("returns removed messages in the removed array", () => {
    const msgs = [
      msg("system", "sys"),
      msg("user", longContent),
      msg("user", "x1"),
      msg("user", "x2"),
      msg("user", "x3"),
      msg("user", "x4"),
      msg("user", "x5"),
    ];
    const budget = estimateTotalTokens(msgs) - estimateMessageTokens(msgs[1]);
    const result = trimMessagesWithMetadata(msgs, budget);
    expect(result.removed).toContainEqual(msgs[1]);
    expect(result.messages).not.toContainEqual(msgs[1]);
  });
});
