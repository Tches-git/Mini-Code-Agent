export const MODIFYING_TOOLS = new Set([
  "create_file",
  "write_file",
  "append_text",
  "insert_after",
  "replace_range",
  "replace_text",
  "import_external_file",
]);

export const MAX_AUTO_FIX_ROUNDS = 2;
export const MAX_CONTEXT_TOKENS = parseInt(
  process.env.MAX_CONTEXT_TOKENS || "100000",
  10,
);
export const MAX_SUMMARY_LINES = 18;
export const DEFAULT_EXECUTION_ROUND_LIMIT = parseInt(
  process.env.MAX_EXECUTION_ROUNDS || "12",
  10,
);
export const MIXED_EXECUTION_ROUND_LIMIT = Math.max(
  DEFAULT_EXECUTION_ROUND_LIMIT,
  parseInt(process.env.MAX_MIXED_EXECUTION_ROUNDS || "16", 10),
);
export const ANALYSIS_EXECUTION_ROUND_LIMIT = Math.max(
  MIXED_EXECUTION_ROUND_LIMIT,
  parseInt(process.env.MAX_ANALYSIS_EXECUTION_ROUNDS || "20", 10),
);
export const EXTERNAL_ANALYSIS_EXECUTION_ROUND_LIMIT = Math.max(
  ANALYSIS_EXECUTION_ROUND_LIMIT,
  parseInt(process.env.MAX_EXTERNAL_ANALYSIS_EXECUTION_ROUNDS || "24", 10),
);
export const READ_ONLY_TOOLS = new Set([
  "list_files",
  "tree_files",
  "read_file",
  "inspect_file",
  "glob_files",
  "search_text",
  "project_map",
  "read_command_output",
  "import_external_file",
]);
export const PARALLELIZABLE_TOOLS = new Set([
  "list_files",
  "tree_files",
  "read_file",
  "inspect_file",
  "glob_files",
  "search_text",
  "project_map",
  "read_command_output",
]);
