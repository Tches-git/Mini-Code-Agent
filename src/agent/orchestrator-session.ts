import type { AgentTaskItem } from "../types/agent.js";
import type { OrchestratorState } from "./orchestrator-state.js";
import {
  buildRelevantSessionContextMessage,
  clearSession,
  findRelevantSessionContext,
  isRelevantSessionContextMessage,
  loadSession,
  saveSession,
} from "./session.js";

export async function clearPersistedSession() {
  await clearSession();
}

export async function restorePersistedSessionById(
  state: OrchestratorState,
  id?: string,
): Promise<boolean> {
  const data = await loadSession(id);
  if (!data || data.messages.length === 0) return false;
  state.restore(data);
  state.messages = state.messages.filter(
    (message) => !isRelevantSessionContextMessage(message),
  );
  const contextMessage = buildRelevantSessionContextMessage(
    await findRelevantSessionContext({
      sessionId: data.id,
      focus: state.summaryFocus,
      taskIds: data.tasks?.map((task) => task.id),
    }),
  );
  if (contextMessage) {
    const insertAt = state.messages.findIndex(
      (message, index) => index > 0 && message.role !== "assistant",
    );
    state.messages.splice(insertAt > 0 ? insertAt : 1, 0, contextMessage);
  }
  return true;
}

export async function loadPersistedSession(id?: string) {
  return loadSession(id);
}

export async function persistSession(
  state: OrchestratorState,
  options?: { tasks?: AgentTaskItem[] },
): Promise<void> {
  try {
    state.sessionId = await saveSession({
      id: state.sessionId,
      messages: state.messages,
      summaryLines: state.summaryLines,
      summaryFocus: state.summaryFocus,
      tasks: options?.tasks,
    });
  } catch {
    // 保存失败时静默忽略，不影响正常执行
  }
}
