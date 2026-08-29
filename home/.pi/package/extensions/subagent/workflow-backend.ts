import type { LaunchRequest, ReusableChild } from "./registry.ts";
import type { WorkflowChild, WorkflowChildBackend } from "./workflow.ts";

export interface PiWorkflowBackendOptions {
  registry: {
    createReusable(request: LaunchRequest, signal: AbortSignal): ReusableChild;
  };
  resolve(config: { label: string; model?: string; skills: readonly string[] }): Promise<LaunchRequest>;
}

/** Production adapter that routes workflow Handles through the shared ChildRegistry policy. */
export class PiWorkflowBackend implements WorkflowChildBackend {
  constructor(private readonly options: PiWorkflowBackendOptions) {}

  async open(config: {
    readonly label: string;
    readonly model?: string;
    readonly skills: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<WorkflowChild> {
    const request = await this.options.resolve({ label: config.label, model: config.model, skills: config.skills });
    return this.options.registry.createReusable(
      { ...request, label: config.label, context: "fresh", forcedSkills: config.skills },
      config.signal,
    );
  }
}
