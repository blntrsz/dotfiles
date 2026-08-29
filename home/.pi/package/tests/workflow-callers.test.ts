import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import subagentExtension from "../extensions/subagent/index.ts";

void test("command, tool, and authoring callers share passive discovery and exact presentation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-callers-"));
  await mkdir(join(cwd, ".pi/workflow"), { recursive: true });
  (globalThis as any).__callerWorkflowEvaluated = 0;
  await writeFile(join(cwd, ".pi/workflow/exact-output.js"), `
    globalThis.__callerWorkflowEvaluated += 1;
    export default (_runtime, args) => args.join("|");
  `);

  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const events = new Map<string, Array<(...args: any[]) => unknown>>();
  const entries: Array<{ type: string; data: unknown }> = [];
  const messages: string[] = [];
  const deliveries: unknown[] = [];
  const pi = {
    registerEntryRenderer() {},
    registerCommand(name: string, definition: unknown) { commands.set(name, definition); },
    registerTool(definition: any) { tools.set(definition.name, definition); },
    on(name: string, handler: (...args: any[]) => unknown) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    getActiveTools() { return ["read"]; },
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
    sendUserMessage(text: string) { messages.push(text); },
    sendMessage(...args: unknown[]) { deliveries.push(args); },
  };
  subagentExtension(pi as any);

  const ctx = {
    cwd,
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => true,
    modelRegistry: { runtime: {} },
  };
  for (const mode of ["rpc", "json", "print"] as const) {
    const headless = { ...ctx, mode, hasUI: mode === "rpc" };
    for (const handler of events.get("session_start") ?? []) await handler({}, headless);
  }
  assert.equal((globalThis as any).__callerWorkflowEvaluated, 0);

  await commands.get("workflow").handler("compare two implementations", {
    ...ctx,
    isIdle: () => true,
  });
  assert.equal((globalThis as any).__callerWorkflowEvaluated, 0);
  assert.match(messages[0] ?? "", /Do not execute it automatically/);
  assert.match(messages[0] ?? "", /Ask once before running the exact saved source and exact arguments/);

  await commands.get("run-workflow").handler(`exact-output "two words" tail`, ctx);
  assert.deepEqual(entries, [], "print mode must not append manual workflow presentation");
  assert.equal(deliveries.length, 0);

  const result = await tools.get("workflow").execute("call", {
    name: "exact-output",
    args: ["tool", "result"],
  }, new AbortController().signal);
  assert.equal(result.content[0]?.text, "tool|result");
  assert.equal(deliveries.length, 0);

  for (const handler of events.get("session_shutdown") ?? []) await handler({}, ctx);
});
