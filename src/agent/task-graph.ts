import type { AgentTaskItem, AgentTaskStatus } from "../types/agent.js";

export type AgentTaskUpdateInput = {
  id?: number;
  title?: string;
  status: AgentTaskStatus;
  note?: string;
  dependsOn?: number[];
  blockedReason?: string;
};

function normalizeTaskTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
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

  update(
    id: number,
    status: AgentTaskStatus,
    note?: string,
    dependsOn?: number[],
    blockedReason?: string,
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

  completeActive() {
    for (const task of this.tasks) {
      if (task.status === "doing" || task.status === "todo") {
        task.status = "done";
      }
    }
  }

  blockActive() {
    for (const task of this.tasks) {
      if (task.status === "doing" || task.status === "todo") {
        task.status = "blocked";
      }
    }
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
      ].filter(Boolean);
      const suffix = details.length > 0 ? ` — ${details.join("; ")}` : "";
      return `**${task.id}.** [${labels[task.status]}] ${task.title}${suffix}`;
    });
  }
}
