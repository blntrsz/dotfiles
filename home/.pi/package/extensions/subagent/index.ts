import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { childToolCeiling } from "./capabilities.ts";
import { LIMITS, SubagentError, type Completion, type ContextMode, type ExecutionSnapshot } from "./domain.ts";
import { SubagentFleetUi } from "./fleet-ui.ts";
import { renderCard, renderLiveCard } from "./render.ts";
import { ChildRegistry, type LaunchRequest } from "./registry.ts";
import { RunController, RunStore } from "./run-store.ts";
import { canonicalModelRuntime, PiChildSessionFactory } from "./sdk-adapter.ts";
import { WorkflowInvoker } from "./workflow.ts";
import { PiWorkflowBackend } from "./workflow-backend.ts";

const extensionPath = fileURLToPath(import.meta.url);
const workflowContractPath = join(dirname(extensionPath), "workflow-contract.d.ts");

interface Runtime {
  registry: ChildRegistry;
  store: RunStore;
  controller: RunController;
  workflows: WorkflowInvoker;
  fleetUi?: SubagentFleetUi;
}

interface ParsedLaunch {
  context: ContextMode;
  model?: string;
  task: string;
}

async function closeRuntime(runtime: Runtime | undefined): Promise<void> {
  if (!runtime) return;
  runtime.fleetUi?.dispose();
  runtime.store.dispose();
  const deadline = Date.now() + LIMITS.shutdownMs;
  await Promise.allSettled([
    runtime.workflows.shutdown({ deadline }),
    runtime.registry.shutdown({ deadline }),
  ]);
}

export function shellWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of input) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (/\s/.test(character)) {
      if (current) { words.push(current); current = ""; }
    } else current += character;
  }
  if (escaped || quote) throw new SubagentError("invalid-arguments", "Unterminated quote or escape");
  if (current) words.push(current);
  return words;
}

export function parseLaunchArguments(input: string): ParsedLaunch {
  const words = shellWords(input);
  let context: ContextMode = "fresh";
  let model: string | undefined;
  const task: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === "--context") {
      const value = words[++index];
      if (value !== "fresh" && value !== "fork") throw new SubagentError("invalid-arguments", "--context must be fresh or fork");
      context = value;
    } else if (word === "--model") {
      model = words[++index];
      if (!model?.includes("/")) throw new SubagentError("invalid-arguments", "--model must be provider/model");
    } else if (word.startsWith("--")) throw new SubagentError("invalid-arguments", `Unknown option: ${word}`);
    else task.push(word);
  }
  if (task.length === 0) throw new SubagentError("invalid-arguments", "A task is required");
  return { context, model, task: task.join(" ") };
}

function completionText(completion: Completion): string {
  if (completion.status === "succeeded") return completion.text ?? "";
  return `[${completion.error?.code ?? completion.status}] ${completion.error?.message ?? completion.status}`;
}

function forkSnapshot(ctx: ExtensionContext): readonly unknown[] {
  try {
    const manager = ctx.sessionManager as typeof ctx.sessionManager & { buildSessionContext(): { messages: unknown[] } };
    return structuredClone(manager.buildSessionContext().messages);
  } catch (error) {
    throw new SubagentError(
      "fork-materialization-failed",
      `Could not snapshot parent branch: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function resolveLaunch(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  input: { task: string; context?: ContextMode; model?: string; label?: string },
): Promise<LaunchRequest> {
  const requested = input.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  if (!requested) throw new SubagentError("model-unavailable", "Parent has no active model");
  const slash = requested.indexOf("/");
  if (slash < 1 || slash === requested.length - 1) throw new SubagentError("invalid-arguments", "Model must be provider/model");
  const provider = requested.slice(0, slash);
  const modelId = requested.slice(slash + 1);
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) throw new SubagentError("model-unavailable", `Model is unavailable: ${requested}`);
  if (ctx.scopedModels.length > 0 && !ctx.scopedModels.some((entry) => entry.model.provider === provider && entry.model.id === modelId)) {
    throw new SubagentError("model-out-of-scope", `Model is outside the parent's scope: ${requested}`);
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new SubagentError("model-unauthenticated", `Model is not authenticated: ${requested}`);

  const context = input.context ?? "fresh";
  return {
    task: input.task,
    label: input.label,
    context,
    model: requested,
    thinkingLevel: ctx.thinkingLevel ?? "off",
    cwd: ctx.cwd,
    tools: Object.freeze(childToolCeiling(pi.getActiveTools())),
    forkMessages: context === "fork" ? forkSnapshot(ctx) : undefined,
  };
}

function toolResult(text: string, details: unknown = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

const ToolParameters = Type.Object({
  action: StringEnum(["launch", "wait", "steer", "follow_up", "cancel", "inspect", "list"] as const),
  task: Type.Optional(Type.String()),
  context: Type.Optional(StringEnum(["fresh", "fork"] as const)),
  model: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  executionId: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number({ minimum: 0 })),
});
type ToolInput = Static<typeof ToolParameters>;

export default function subagentExtension(pi: ExtensionAPI) {
  let current: Runtime | undefined;
  let workflowNames: string[] = [];
  const runtime = (): Runtime => {
    if (!current) throw new SubagentError("parent-closed", "Subagent runtime is not active");
    return current;
  };

  pi.registerEntryRenderer("subagent-output", (entry, _options, theme) => {
    const data = entry.data as { text: string };
    return new Text(data.text, 0, 0);
  });
  pi.registerEntryRenderer("workflow-output", (entry) => {
    const data = entry.data as { text: string };
    return new Text(data.text, 0, 0);
  });
  pi.registerEntryRenderer("subagent-launch", (entry, { expanded }, theme) => {
    const data = entry.data as { executionId: string };
    try {
      const initial = runtime().store.lookup(data.executionId);
      return renderLiveCard(() => {
        try { return runtime().store.lookup(data.executionId); }
        catch { return initial; }
      }, expanded, theme);
    } catch {
      return new Text(theme.fg("dim", `Subagent ${data.executionId}`), 0, 0);
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    // Session replacement normally emits shutdown first. Keep this defensive
    // barrier so a host cannot overwrite a still-owned runtime.
    const previous = current;
    current = undefined;
    await closeRuntime(previous);

    const factory = new PiChildSessionFactory({
      modelRuntime: canonicalModelRuntime(ctx.modelRegistry),
      projectTrusted: ctx.isProjectTrusted(),
      extensionPath,
    });
    const registry = new ChildRegistry({
      factory,
      delivery: {
        inject(completion, snapshot) {
          pi.sendMessage({
            customType: "subagent-delivery",
            content: `Subagent ${snapshot.label} (${completion.executionId}) ${completion.status}:\n${completionText(completion)}`,
            display: true,
            details: { childId: completion.childId, executionId: completion.executionId, delivery: "injected" },
          }, { deliverAs: "followUp", triggerTurn: true });
        },
      },
    });
    const store = new RunStore(registry);
    const workflows = new WorkflowInvoker({
      cwd: ctx.cwd,
      trusted: () => ctx.isProjectTrusted(),
      backend: new PiWorkflowBackend({
        registry,
        resolve: async (config) => ({
          ...await resolveLaunch(pi, ctx, {
            task: `Workflow Handle ${config.label}`,
            label: config.label,
            context: "fresh",
            model: config.model,
          }),
          forcedSkills: config.skills,
        }),
      }),
    });
    current = { registry, store, controller: new RunController(registry), workflows };
    workflowNames = (await workflows.list()).entries.map((entry) => entry.name);
    if (ctx.mode === "tui") current.fleetUi = new SubagentFleetUi(ctx, store, current.controller);
  });

  pi.on("agent_settled", () => current?.registry.retryPendingDelivery());
  pi.on("session_shutdown", async () => {
    const closing = current;
    current = undefined;
    await closeRuntime(closing);
  });

  pi.registerCommand("subagent", {
    description: "Launch asynchronous one-shot Child work",
    handler: async (args, ctx) => {
      try {
        const parsed = parseLaunchArguments(args);
        const request = await resolveLaunch(pi, ctx, parsed);
        const launched = runtime().registry.launch(request);
        if (ctx.mode === "tui") pi.appendEntry("subagent-launch", { executionId: launched.executionId });
        if (ctx.hasUI) ctx.ui.notify(`Child ${launched.childId} · Execution ${launched.executionId}`, "info");
      } catch (error) {
        const normalized = error instanceof SubagentError ? error : new SubagentError("child-startup-failed", error instanceof Error ? error.message : String(error));
        if (ctx.hasUI) ctx.ui.notify(`[${normalized.code}] ${normalized.message}`, "error");
        else throw normalized;
      }
    },
  });

  pi.registerCommand("btw", {
    description: "Ask a synchronous side question outside parent model context",
    handler: async (args, ctx) => {
      const parsed = parseLaunchArguments(args);
      const request = await resolveLaunch(pi, ctx, { ...parsed, label: "btw" });
      const launched = runtime().registry.launch(request);
      const result = await runtime().controller.wait(launched.executionId);
      if (ctx.mode === "tui") pi.appendEntry("subagent-output", { text: completionText(result.completion) });
    },
  });

  pi.registerCommand("workflow", {
    description: "Collaboratively author a trusted project-local JavaScript workflow",
    handler: async (goal, ctx) => {
      if (!goal.trim()) throw new SubagentError("invalid-arguments", "A workflow goal is required");
      if (!ctx.isProjectTrusted()) throw new SubagentError("capability-violation", "Project workflows are available only in trusted projects");
      if (!ctx.isIdle()) throw new SubagentError("inactive-execution", "Wait for the main agent to become idle before authoring a workflow");
      const discovered = await runtime().workflows.list();
      const existing = discovered.entries.map((entry) => entry.name).join(", ") || "(none)";
      pi.sendUserMessage(
        `Collaboratively author a trusted project-local JavaScript workflow for this goal:\n\n${goal.trim()}\n\n` +
        `Inspect the project context and direct entries in .pi/workflow/ first. Existing runnable workflows: ${existing}. ` +
        `Create or edit one kebab-case .js entry. Clearly identify when you edit an existing workflow. Enable JSDoc checking with // @ts-check and use the canonical declaration at ${workflowContractPath}; ` +
        `copy it to .pi/workflow/workflow.d.ts only when no local declaration exists. Never overwrite an incompatible existing declaration silently. ` +
        `Use @typedef imports from ./workflow.js (TypeScript resolves workflow.d.ts) and export a default workflow function. ` +
        `After saving, present the workflow identity, behavior, positional string argument contract, non-whitespace text return contract, and an example /run-workflow invocation. ` +
        `Do not execute it automatically. Ask once before running the exact saved source and exact arguments; if either changes, ask again.`,
      );
    },
  });

  pi.registerCommand("run-workflow", {
    description: "Run an authorized trusted project-local JavaScript workflow",
    getArgumentCompletions(prefix) {
      const first = prefix.trimStart();
      if (/\s/.test(first)) return null;
      const matches = workflowNames.filter((name) => name.startsWith(first));
      return matches.length ? matches.map((name) => ({ value: name, label: name })) : null;
    },
    handler: async (input, ctx) => {
      const words = shellWords(input);
      const name = words.shift();
      if (!name) throw new SubagentError("invalid-arguments", "Usage: /run-workflow <name> [args...]");
      const result = await runtime().workflows.invoke(name, words, undefined, "command");
      if (ctx.mode === "tui") pi.appendEntry("workflow-output", { text: result.text });
    },
  });

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: "Run one authorized trusted project-local JavaScript workflow. Pass positional strings directly. Returns only the exact successful workflow text. A direct user request is authorization; otherwise ask once before calling, and ask again if source or arguments change.",
    promptSnippet: "Run an authorized trusted project-local JavaScript workflow",
    promptGuidelines: [
      "Use workflow only after a direct user request or one explicit approval for the exact saved source and arguments; changed source or arguments require renewed approval.",
      "Treat workflow results as the one public value; do not separately inject internal Child outcomes.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Kebab-case workflow identity" }),
      args: Type.Array(Type.String(), { description: "Positional string arguments passed directly to the workflow" }),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await runtime().workflows.invoke(params.name, params.args, signal, "tool");
      return toolResult(result.text, { name: result.name, digest: result.digest, sourcePath: result.sourcePath, args: result.args });
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Manage isolated in-process Child executions by stable executionId. Actions: launch, wait, steer, follow_up, cancel, inspect, list.",
    promptSnippet: "Launch and manage isolated Child executions",
    promptGuidelines: ["Use subagent executionId values, never labels, for control actions."],
    parameters: ToolParameters,
    async execute(_toolCallId, params: ToolInput, signal, onUpdate, ctx) {
      const executionId = params.executionId;
      switch (params.action) {
        case "launch": {
          if (!params.task) throw new SubagentError("invalid-arguments", "launch requires task");
          const request = await resolveLaunch(pi, ctx, params as ToolInput & { task: string });
          const launched = runtime().registry.launch(request);
          const snapshot = runtime().store.lookup(launched.executionId);
          onUpdate?.(toolResult(`Child ${launched.childId} · Execution ${launched.executionId} · ${launched.state}`, snapshot));
          return toolResult(JSON.stringify(launched), snapshot);
        }
        case "list": {
          const snapshots = runtime().store.list();
          return toolResult(JSON.stringify(snapshots.map((run) => ({ childId: run.childId, executionId: run.executionId, state: run.executionState, delivery: run.delivery.state }))), { snapshots });
        }
        case "wait": {
          if (!executionId) throw new SubagentError("invalid-arguments", "wait requires executionId");
          const result = await runtime().controller.wait(executionId, { timeoutMs: params.timeoutMs, signal });
          return toolResult(completionText(result.completion), { ...result, snapshot: runtime().store.lookup(executionId) });
        }
        case "steer":
        case "follow_up": {
          if (!executionId || !params.message) throw new SubagentError("invalid-arguments", `${params.action} requires executionId and message`);
          if (params.action === "steer") await runtime().controller.steer(executionId, params.message);
          else await runtime().controller.followUp(executionId, params.message);
          return toolResult(`${params.action} accepted for ${executionId}`, runtime().store.lookup(executionId));
        }
        case "cancel": {
          if (!executionId) throw new SubagentError("invalid-arguments", "cancel requires executionId");
          const snapshot = await runtime().controller.cancel(executionId);
          return toolResult(`${executionId}: ${snapshot.executionState}`, snapshot);
        }
        case "inspect": {
          if (!executionId) throw new SubagentError("invalid-arguments", "inspect requires executionId");
          const snapshot = runtime().store.lookup(executionId);
          return toolResult(JSON.stringify(snapshot), snapshot);
        }
      }
    },
    renderShell: "self",
    renderCall(args, theme) {
      const title = args.action === "launch" ? args.label || "subagent" : args.executionId || "subagent";
      return new Text(`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("muted", `${args.action} · ${title}`)}`, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as { snapshot?: ExecutionSnapshot } | ExecutionSnapshot | undefined;
      const snapshot = details && "executionId" in details ? details : details?.snapshot;
      if (snapshot) {
        return renderLiveCard(() => {
          try { return runtime().store.lookup(snapshot.executionId); }
          catch { return snapshot; }
        }, expanded, theme);
      }
      const block = result.content.find((part) => part.type === "text");
      return new Text(block?.type === "text" ? block.text : "", 0, 0);
    },
  });
}
