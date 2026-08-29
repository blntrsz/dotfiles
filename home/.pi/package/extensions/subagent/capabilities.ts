const PARENT_ONLY_TOOLS = new Set([
  "subagent",
  "workflow",
  "run_workflow",
  "mcpScript",
  "mcp",
  "task",
  "tasks",
]);

export function isParentOnlyTool(name: string): boolean {
  return PARENT_ONLY_TOOLS.has(name);
}

export function childToolCeiling(activeTools: readonly string[]): string[] {
  return activeTools.filter((name) => !isParentOnlyTool(name));
}
