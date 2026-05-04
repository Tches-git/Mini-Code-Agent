import type { ChatMessage } from "../types/agent.js";

export const SUMMARY_MESSAGE_PREFIX = "[会话摘要]";

export function isSummaryMessage(message: ChatMessage | undefined): boolean {
  return Boolean(
    message &&
      message.role === "assistant" &&
      message.content?.startsWith(SUMMARY_MESSAGE_PREFIX),
  );
}

/**
 * 粗略估算一条消息的 token 数。
 * 规则：英文字符按 0.3/token 估算，中文每字 ≈ 2 token，
 * 加上角色 / tool_call 等元数据的固定开销。
 * 这不是精确计数，但足以做窗口管理。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  const ENGLISH_CHAR_WEIGHT = 0.3;
  let englishChars = 0;
  let nonEnglishTokens = 0;

  for (const char of text) {
    if (char.charCodeAt(0) > 0x2fff) {
      nonEnglishTokens += 2;
    } else {
      englishChars += 1;
    }
  }

  const englishTokens =
    englishChars > 0
      ? Math.max(1, Math.ceil(englishChars * ENGLISH_CHAR_WEIGHT))
      : 0;

  return englishTokens + nonEnglishTokens;
}

export function estimateMessageTokens(msg: ChatMessage): number {
  const META_OVERHEAD = 4;
  let tokens = META_OVERHEAD;
  if (msg.content) {
    tokens += estimateTokens(msg.content);
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      tokens +=
        estimateTokens(tc.function.name) +
        estimateTokens(tc.function.arguments) +
        4;
    }
  }
  if (msg.name) tokens += estimateTokens(msg.name);
  return tokens;
}

export function estimateTotalTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

export function trimMessages(
  messages: ChatMessage[],
  maxTokens: number,
): ChatMessage[] {
  return trimMessagesWithMetadata(messages, maxTokens).messages;
}

export function trimMessagesWithMetadata(
  messages: ChatMessage[],
  maxTokens: number,
): { messages: ChatMessage[]; removed: ChatMessage[] } {
  let total = estimateTotalTokens(messages);
  if (total <= maxTokens) {
    return { messages, removed: [] };
  }

  const trimmed = [...messages];
  const removed: ChatMessage[] = [];
  const protectedCount = isSummaryMessage(trimmed[1]) ? 2 : 1;

  const i = protectedCount;
  while (total > maxTokens && i < trimmed.length) {
    const msg = trimmed[i];

    if (trimmed.length - i <= 4) break;

    if (
      msg.role === "assistant" &&
      msg.tool_calls &&
      msg.tool_calls.length > 0
    ) {
      const toolCallIds = new Set(msg.tool_calls.map((tc) => tc.id));
      let removeCount = 1;
      for (let j = i + 1; j < trimmed.length; j++) {
        const candidate = trimmed[j];
        if (
          candidate.role === "tool" &&
          candidate.tool_call_id &&
          toolCallIds.has(candidate.tool_call_id)
        ) {
          removeCount += 1;
        } else {
          break;
        }
      }
      if (trimmed.length - removeCount - protectedCount < 4) break;

      const batch = trimmed.splice(i, removeCount);
      removed.push(...batch);
      for (const entry of batch) total -= estimateMessageTokens(entry);
      continue;
    }

    total -= estimateMessageTokens(msg);
    removed.push(...trimmed.splice(i, 1));
  }

  return { messages: trimmed, removed };
}
