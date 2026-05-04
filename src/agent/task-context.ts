import type { AgentTaskGraph } from "./task-graph.js";

let activeTaskGraph: AgentTaskGraph | null = null;

export function setActiveTaskGraph(taskGraph: AgentTaskGraph | null) {
  activeTaskGraph = taskGraph;
}

export function getActiveTaskGraph(): AgentTaskGraph | null {
  return activeTaskGraph;
}
