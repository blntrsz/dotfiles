import { readFileSync } from "node:fs";
import type { Model, AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { childToolCeiling, isParentOnlyTool } from "./capabilities.ts";
import { SubagentError } from "./domain.ts";
import type {
  AdapterCompletion,
  ChildSession,
  ChildSessionFactory,
  LaunchRequest,
} from "./registry.ts";

/** A per-loader marker captured by the inline Child factory. It never touches globals or process.env. */
export interface ChildRuntimeMarker {
  readonly kind: "subagent-child";
  readonly childId: string;
}

function childRegistration(marker: ChildRuntimeMarker): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", (event) => ({
      systemPrompt: `${event.systemPrompt}\n\nYou are an isolated Child (${marker.childId}). Complete the assigned task. You cannot delegate, manage workflows, or interact with the parent UI.`,
    }));
  };
}

export function filterForkMessages(messages: readonly unknown[]): AgentMessage[] {
  const result: AgentMessage[] = [];
  for (const value of messages) {
    if (!value || typeof value !== "object" || !("role" in value)) continue;
    const message = structuredClone(value) as AgentMessage;
    if (message.role === "custom" && (message.customType === "subagent" || message.customType === "subagent-delivery")) continue;
    if (message.role === "toolResult" && isParentOnlyTool(message.toolName)) continue;
    if (message.role === "assistant") {
      message.content = message.content.filter((part) => part.type !== "toolCall" || !isParentOnlyTool(part.name));
      if (message.content.length === 0) continue;
    }
    result.push(message);
  }
  return result;
}

function finalAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function toolActivity(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return name;
  const values = args as Record<string, unknown>;
  const detail = values.path ?? values.file_path ?? values.command ?? values.query;
  if (typeof detail !== "string" || !detail.trim()) return name;
  const normalized = detail.replace(/\s+/g, " ").trim();
  return `${name}: ${normalized.length > 120 ? `${normalized.slice(0, 119)}…` : normalized}`;
}

function assistantText(message: AssistantMessage | undefined): string {
  if (!message) return "";
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

interface SkillResource {
  name: string;
  filePath: string;
  baseDir: string;
}

interface SkillDiagnostic {
  type: string;
  collision?: { resourceType: string; name: string };
}

export function forcedSkillsPrompt(
  selected: readonly string[],
  resources: { skills: readonly SkillResource[]; diagnostics: readonly SkillDiagnostic[] },
  load: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string | undefined {
  if (selected.length === 0) return undefined;
  const blocks: string[] = [];
  for (const name of selected) {
    const collision = resources.diagnostics.find((diagnostic) =>
      diagnostic.type === "collision" &&
      diagnostic.collision?.resourceType === "skill" &&
      diagnostic.collision.name === name
    );
    if (collision) throw new SubagentError("skill-ambiguous", `Forced skill is ambiguous: ${name}`);
    const matches = resources.skills.filter((skill) => skill.name === name);
    if (matches.length === 0) throw new SubagentError("skill-missing", `Forced skill is missing: ${name}`);
    if (matches.length > 1) throw new SubagentError("skill-ambiguous", `Forced skill is ambiguous: ${name}`);
    const skill = matches[0]!;
    blocks.push(`<forced_skill name=${JSON.stringify(name)} base_dir=${JSON.stringify(skill.baseDir)}>\n${load(skill.filePath)}\n</forced_skill>`);
  }
  return `The following skills are forced for this Child. Follow them in call order and resolve their relative paths from each declared base_dir.\n\n${blocks.join("\n\n")}`;
}

export interface PiChildSessionFactoryOptions {
  modelRuntime: ModelRuntime;
  projectTrusted: boolean;
  extensionPath: string;
}

export class PiChildSessionFactory implements ChildSessionFactory {
  constructor(private readonly options: PiChildSessionFactoryOptions) {}

  async create(
    request: LaunchRequest & { childId: string; executionId: string },
    emit: (type: string, data?: unknown) => void,
  ): Promise<ChildSession> {
    const [provider, ...modelParts] = request.model.split("/");
    const modelId = modelParts.join("/");
    const model = this.options.modelRuntime.getModel(provider!, modelId) as Model<any> | undefined;
    if (!model) throw new SubagentError("model-unavailable", `Model is unavailable: ${request.model}`, request.executionId);

    const settingsManager = SettingsManager.create(request.cwd, getAgentDir(), {
      projectTrusted: this.options.projectTrusted,
    });
    const eventBus = createEventBus();
    const marker: ChildRuntimeMarker = Object.freeze({ kind: "subagent-child", childId: request.childId });
    let forcedSkillPrompt: string | undefined;
    const loader = new DefaultResourceLoader({
      cwd: request.cwd,
      agentDir: getAgentDir(),
      settingsManager,
      eventBus,
      extensionFactories: [{ name: `subagent-child:${request.childId}`, hidden: true, factory: childRegistration(marker) }],
      extensionsOverride: (base) => ({
        ...base,
        extensions: base.extensions.filter((extension) => extension.resolvedPath !== this.options.extensionPath),
      }),
      skillsOverride: (base) => {
        try {
          forcedSkillPrompt = forcedSkillsPrompt(request.forcedSkills ?? [], base);
        } catch (error) {
          const normalized = error instanceof SubagentError ? error : new SubagentError("child-startup-failed", String(error));
          throw new SubagentError(normalized.code, normalized.message, request.executionId);
        }
        return base;
      },
      appendSystemPromptOverride: (base) => forcedSkillPrompt ? [...base, forcedSkillPrompt] : base,
    });
    await loader.reload();

    const sessionManager = SessionManager.inMemory(request.cwd);
    if ((request.context ?? "fresh") === "fork") {
      if (!request.forkMessages) {
        throw new SubagentError("fork-materialization-failed", "Fork snapshot is unavailable; fresh fallback is forbidden", request.executionId);
      }
      try {
        for (const message of filterForkMessages(request.forkMessages)) {
          // SessionManager's public append union omits summary messages even though
          // its in-memory context builder accepts the canonical AgentMessage union.
          sessionManager.appendMessage(message as Parameters<typeof sessionManager.appendMessage>[0]);
        }
      } catch (error) {
        throw new SubagentError(
          "fork-materialization-failed",
          `Could not materialize fork snapshot: ${error instanceof Error ? error.message : String(error)}`,
          request.executionId,
        );
      }
    }

    const { session } = await createAgentSession({
      cwd: request.cwd,
      agentDir: getAgentDir(),
      modelRuntime: this.options.modelRuntime,
      model,
      thinkingLevel: request.thinkingLevel as any,
      tools: childToolCeiling(request.tools),
      resourceLoader: loader,
      settingsManager,
      sessionManager,
    });

    let disposed = false;
    const unsubscribe = session.subscribe((event) => {
      if (disposed) return;
      switch (event.type) {
        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta") emit("activity", event.assistantMessageEvent.delta.slice(-240));
          break;
        case "tool_execution_start":
          emit("activity", toolActivity(event.toolName, event.args));
          emit("tool-start", { name: event.toolName, args: event.args });
          break;
        case "tool_execution_end":
          emit("tool-end", { name: event.toolName, isError: event.isError });
          break;
        case "turn_end": {
          if (event.message.role === "assistant") {
            const usage = event.message.usage;
            emit("usage", {
              input: usage.input,
              output: usage.output,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
              cost: usage.cost.total,
              turns: 1,
            });
          }
          break;
        }
        default:
          emit(event.type);
      }
    });

    const completion = (): AdapterCompletion => {
      const last = finalAssistant(session.messages);
      if (!last) return { status: "failed", errorCode: "child-execution-failed", errorMessage: "Child settled without an assistant message" };
      if (last.stopReason === "aborted") return { status: "cancelled", errorMessage: last.errorMessage ?? "Child was cancelled" };
      if (last.stopReason === "error") {
        return {
          status: "failed",
          errorCode: "child-execution-failed",
          errorMessage: last.errorMessage ?? "Child model execution failed",
          diagnostic: assistantText(last),
        };
      }
      return { status: "succeeded", text: assistantText(last) };
    };

    return {
      async start(task) {
        await session.prompt(task, { expandPromptTemplates: false });
        await session.agent.waitForIdle();
        return completion();
      },
      async steer(message) { await session.steer(message); },
      async followUp(message) { await session.followUp(message); },
      async abort() { await session.abort(); },
      dispose() {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        session.dispose();
      },
    };
  }
}

/** Pi currently exposes the canonical runtime through its ModelRegistry facade, but not as a public getter. */
export function canonicalModelRuntime(modelRegistry: unknown): ModelRuntime {
  const runtime = (modelRegistry as { runtime?: ModelRuntime }).runtime;
  if (!runtime) throw new SubagentError("capability-violation", "Canonical parent model runtime is unavailable");
  return runtime;
}
