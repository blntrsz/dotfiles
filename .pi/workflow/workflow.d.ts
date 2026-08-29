export interface WorkflowHandleCreationOptions {
  readonly label: string;
  readonly model?: string;
}

export interface WorkflowHandle {
  skill(name: string): WorkflowHandle;
  execute(task: string): Promise<string>;
  close(): Promise<void>;
}

export interface WorkflowRuntime {
  createHandle(options: WorkflowHandleCreationOptions): WorkflowHandle;
}

export type Workflow = (
  runtime: WorkflowRuntime,
  args: readonly string[],
) => string | Promise<string>;
