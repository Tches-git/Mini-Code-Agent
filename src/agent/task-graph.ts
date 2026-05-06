import type { AgentTaskItem, AgentTaskStatus } from "../types/agent.js";

export type AgentTaskUpdateInput = {
  id?: number;
  title?: string;
  status: AgentTaskStatus;
  note?: string;
  dependsOn?: number[];
  blockedReason?: string;
  retrySuggestion?: string;
};

function normalizeTaskTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

function getRetrySuggestion(reason?: string): string {
  if (!reason) return "检查任务上下文后重试。";
  if (/验证|test|build|lint|校验/i.test(reason)) {
    return "先阅读最后一次验证输出，修复目标文件后重跑 focused 验证。";
  }
  if (/依赖|depends/i.test(reason)) {
    return "先完成依赖任务，再继续执行当前任务。";
  }
  return "缩小任务范围，补充阻塞信息后重试。";
}

export class AgentTaskGraph {
  private tasks: AgentTaskItem[] = [];
  private nextId = 1;

  reset(taskTitle?: string) {
    this.tasks = [];
    this.nextId = 1;
    if (taskTitle) {
      this.add(taskTitle, "doing");
    }
  }

  restore(tasks: AgentTaskItem[] = []) {
    this.tasks = tasks
      .filter(
        (task) =>
          Number.isInteger(task.id) &&
          task.id > 0 &&
          normalizeTaskTitle(task.title) &&
          ["todo", "doing", "done", "blocked"].includes(task.status),
      )
      .map((task) => ({
        id: task.id,
        title: normalizeTaskTitle(task.title),
        status: task.status,
        ...(task.note ? { note: normalizeTaskTitle(task.note) } : {}),
        ...(Array.isArray(task.dependsOn)
          ? { dependsOn: task.dependsOn.filter(Number.isInteger) }
          : {}),
        ...(task.blockedReason
          ? { blockedReason: normalizeTaskTitle(task.blockedReason) }
          : {}),
        ...(Number.isInteger(task.failureCount)
          ? { failureCount: Math.max(0, task.failureCount || 0) }
          : {}),
        ...(task.retrySuggestion
          ? { retrySuggestion: normalizeTaskTitle(task.retrySuggestion) }
          : {}),
        ...(Array.isArray(task.history)
          ? {
              history: task.history
                .filter((entry) =>
                  ["todo", "doing", "done", "blocked"].includes(entry.status),
                )
                .slice(-20),
            }
          : {}),
      }));
    this.nextId = Math.max(0, ...this.tasks.map((task) => task.id)) + 1;
  }

  add(
    title: string,
    status: AgentTaskStatus = "todo",
    note?: string,
    dependsOn?: number[],
    blockedReason?: string,
  ): AgentTaskItem | null {
    const normalized = normalizeTaskTitle(title);
    if (!normalized) {
      return null;
    }
    const task: AgentTaskItem = {
      id: this.nextId,
      title: normalized,
      status,
      ...(note ? { note: normalizeTaskTitle(note) } : {}),
      ...(dependsOn ? { dependsOn: dependsOn.filter(Number.isInteger) } : {}),
      ...(blockedReason
        ? { blockedReason: normalizeTaskTitle(blockedReason) }
        : {}),
    };
    this.nextId += 1;
    this.tasks.push(task);
    return task;
  }

  get(id: number): AgentTaskItem | null {
    const task = this.tasks.find((item) => item.id === id);
    return task
      ? { ...task, history: task.history?.map((entry) => ({ ...entry })) }
      : null;
  }

  private recordHistory(task: AgentTaskItem, retrySuggestion?: string) {
    const history = task.history || [];
    history.push({
      at: new Date().toISOString(),
      status: task.status,
      ...(task.note ? { note: task.note } : {}),
      ...(task.failureCount ? { failureCount: task.failureCount } : {}),
      ...(retrySuggestion || task.retrySuggestion
        ? { retrySuggestion: retrySuggestion || task.retrySuggestion }
        : {}),
    });
    task.history = history.slice(-20);
  }

  update(
    id: number,
    status: AgentTaskStatus,
    note?: string,
    dependsOn?: number[],
    blockedReason?: string,
    retrySuggestion?: string,
  ): AgentTaskItem | null {
    const task = this.tasks.find((item) => item.id === id);
    if (!task) {
      return null;
    }
    task.status = status;
    if (note !== undefined) {
      task.note = normalizeTaskTitle(note);
    }
    if (dependsOn !== undefined) {
      task.dependsOn = dependsOn.filter(Number.isInteger);
    }
    if (blockedReason !== undefined) {
      task.blockedReason = normalizeTaskTitle(blockedReason);
    }
    if (status === "blocked") {
      task.failureCount = (task.failureCount || 0) + 1;
      task.retrySuggestion = normalizeTaskTitle(
        retrySuggestion || getRetrySuggestion(blockedReason || note),
      );
    } else if (status === "done") {
      task.blockedReason = undefined;
      task.retrySuggestion = undefined;
    }
    this.recordHistory(task, retrySuggestion);
    return task;
  }

  apply(input: AgentTaskUpdateInput): AgentTaskItem | null {
    if (input.id !== undefined) {
      return this.update(
        input.id,
        input.status,
        input.note,
        input.dependsOn,
        input.blockedReason,
        input.retrySuggestion,
      );
    }
    return this.add(
      input.title || "未命名任务",
      input.status,
      input.note,
      input.dependsOn,
      input.blockedReason,
    );
  }

  completeActive(taskId?: number) {
    for (const task of this.tasks) {
      if (taskId !== undefined && task.id !== taskId) continue;
      if (task.status === "doing" || task.status === "todo") {
        task.status = "done";
      }
    }
  }

  blockActive(taskId?: number, blockedReason?: string) {
    for (const task of this.tasks) {
      if (taskId !== undefined && task.id !== taskId) continue;
      if (task.status === "doing" || task.status === "todo") {
        this.update(
          task.id,
          "blocked",
          task.note,
          task.dependsOn,
          blockedReason || task.blockedReason,
        );
      }
    }
  }

  getUnmetDependencies(taskId: number): AgentTaskItem[] {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task?.dependsOn?.length) return [];
    return task.dependsOn
      .map((id) => this.tasks.find((item) => item.id === id))
      .filter((item): item is AgentTaskItem => Boolean(item))
      .filter((item) => item.status !== "done")
      .map((item) => ({ ...item }));
  }

  getRunnableBlockedTask(): AgentTaskItem | null {
    const task = this.tasks.find(
      (item) =>
        item.status === "blocked" &&
        this.getUnmetDependencies(item.id).length === 0,
    );
    return task
      ? { ...task, history: task.history?.map((entry) => ({ ...entry })) }
      : null;
  }

  list(): AgentTaskItem[] {
    return this.tasks.map((task) => ({ ...task }));
  }

  format(): string[] {
    const labels: Record<AgentTaskStatus, string> = {
      todo: "待办",
      doing: "进行中",
      done: "完成",
      blocked: "阻塞",
    };
    return this.tasks.map((task) => {
      const details = [
        task.note,
        task.dependsOn?.length ? `依赖: ${task.dependsOn.join(",")}` : "",
        task.blockedReason ? `阻塞: ${task.blockedReason}` : "",
        task.failureCount ? `失败次数: ${task.failureCount}` : "",
        task.retrySuggestion ? `重试建议: ${task.retrySuggestion}` : "",
      ].filter(Boolean);
      const suffix = details.length > 0 ? ` — ${details.join("; ")}` : "";
      return `**${task.id}.** [${labels[task.status]}] ${task.title}${suffix}`;
    });
  }
}
