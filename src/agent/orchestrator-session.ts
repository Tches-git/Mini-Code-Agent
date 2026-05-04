import type { OrchestratorState } from "./orchestrator-state.js";
import { clearSession, loadSession, saveSession } from "./session.js";

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
  return true;
}

export async function persistSession(state: OrchestratorState): Promise<void> {
  try {
    state.sessionId = await saveSession({
      id: state.sessionId,
      messages: state.messages,
      summaryLines: state.summaryLines,
      summaryFocus: state.summaryFocus,
    });
  } catch {
    // 保存失败时静默忽略，不影响正常执行
  }
}
