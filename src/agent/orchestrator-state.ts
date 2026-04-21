import type { ChatMessage } from "../types/agent.js";
import {
  estimateTotalTokens,
  isSummaryMessage,
  SUMMARY_MESSAGE_PREFIX,
  trimMessagesWithMetadata,
} from "../utils/token.js";
import {
  compactSummaryLines,
  deriveFocusFromMessage,
  deriveFocusFromPaths,
  mergeSummaryFocus,
  type SummaryFocus,
  summarizeRemovedMessage,
} from "./summary.js";
import { MAX_CONTEXT_TOKENS, MAX_SUMMARY_LINES } from "./orchestrator-config.js";

export class OrchestratorState {
  messages: ChatMessage[];
  sessionId?: string;
  summaryLines: string[] = [];
  summaryFocus: SummaryFocus = { files: [], keywords: [] };

  constructor(systemPrompt: string) {
    this.messages = [{ role: "system", content: systemPrompt }];
  }

  clear(systemPrompt: string) {
    this.summaryLines = [];
    this.summaryFocus = { files: [], keywords: [] };
    this.messages = [{ role: "system", content: systemPrompt }];
    this.sessionId = undefined;
  }

  restore(data: {
    id: string;
    messages: ChatMessage[];
    summaryLines: string[];
    summaryFocus: SummaryFocus;
  }) {
    this.sessionId = data.id;
    this.messages = data.messages;
    this.summaryLines = data.summaryLines;
    this.summaryFocus = data.summaryFocus;
  }

  get turnCount(): number {
    return this.messages.filter((m) => m.role === "user").length;
  }

  syncSummaryMessage() {
    this.messages = this.messages.filter(
      (message, index) => index === 0 || !isSummaryMessage(message),
    );
    if (this.summaryLines.length === 0) return;

    this.messages.splice(1, 0, {
      role: "assistant",
      content: `${SUMMARY_MESSAGE_PREFIX}\n${this.summaryLines.map((line) => `- ${line}`).join("\n")}`,
    });
  }

  mergeSummary(removedMessages: ChatMessage[]) {
    const newLines = removedMessages.flatMap((message) => summarizeRemovedMessage(message));
    if (newLines.length === 0) return;

    this.summaryLines = compactSummaryLines(
      [...this.summaryLines, ...newLines],
      this.summaryFocus,
      MAX_SUMMARY_LINES,
    );
    this.syncSummaryMessage();
  }

  rememberMessageFocus(message: ChatMessage) {
    this.summaryFocus = mergeSummaryFocus(
      this.summaryFocus,
      deriveFocusFromMessage(message),
    );
  }

  rememberPathFocus(paths: Iterable<string>) {
    this.summaryFocus = mergeSummaryFocus(
      this.summaryFocus,
      deriveFocusFromPaths(paths),
    );
  }

  trimContextIfNeeded(
    emit: (event: { type: "context_trimmed"; removed: number; totalTokens: number }) => void,
  ) {
    let removedCount = 0;

    for (let attempt = 0; attempt < 3; attempt++) {
      const trimResult = trimMessagesWithMetadata(
        this.messages,
        MAX_CONTEXT_TOKENS,
      );
      this.messages = trimResult.messages;
      removedCount += trimResult.removed.length;
      if (trimResult.removed.length === 0) break;
      this.mergeSummary(trimResult.removed);
    }

    if (removedCount > 0) {
      emit({
        type: "context_trimmed",
        removed: removedCount,
        totalTokens: estimateTotalTokens(this.messages),
      });
    }
  }
}
