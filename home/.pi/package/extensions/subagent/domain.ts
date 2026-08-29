export const LIMITS = {
  executingChildren: 4,
  liveChildren: 8,
  nonterminalExecutions: 32,
  outputBytes: 64 * 1024,
  diagnosticBytes: 8 * 1024,
  inspectionBytes: 256 * 1024,
  cleanupMs: 5_000,
  shutdownMs: 2_000,
} as const;

export type ChildId = string;
export type ExecutionId = string;
export type ContextMode = "fresh" | "fork";
export type ChildState = "unstarted" | "executing" | "idle" | "closing" | "closed";
export type ExecutionState =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelling"
  | "cancelled";
export type DeliveryState = "pending" | "consumed" | "injected" | "discarded";
export type CompletionStatus = "succeeded" | "failed" | "cancelled";

export interface UsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface Completion {
  readonly sequence: number;
  readonly executionId: ExecutionId;
  readonly childId: ChildId;
  readonly status: CompletionStatus;
  readonly text?: string;
  readonly error?: { readonly code: ErrorCode; readonly message: string };
  readonly diagnosticExcerpt?: string;
  readonly committedAt: number;
}

export interface Delivery {
  readonly state: DeliveryState;
  readonly diagnostic?: string;
}

export interface NormalizedEvent {
  readonly childId: ChildId;
  readonly executionId: ExecutionId;
  readonly sequence: number;
  readonly timestamp: number;
  readonly type: string;
  readonly data?: unknown;
}

export interface ExecutionSnapshot {
  readonly childId: ChildId;
  readonly executionId: ExecutionId;
  readonly label: string;
  readonly task: string;
  readonly context: ContextMode;
  readonly model: string;
  readonly thinkingLevel: string;
  readonly childState: ChildState;
  readonly executionState: ExecutionState;
  readonly delivery: Delivery;
  readonly completion?: Completion;
  readonly activity: string;
  readonly events: readonly NormalizedEvent[];
  readonly usage: UsageSnapshot;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly omitted?: { readonly bytes: number; readonly events: number };
}

export type ErrorCode =
  | "invalid-arguments"
  | "unknown-execution"
  | "inactive-execution"
  | "parent-closed"
  | "capacity-rejected"
  | "model-unavailable"
  | "model-unauthenticated"
  | "model-out-of-scope"
  | "capability-violation"
  | "fork-materialization-failed"
  | "child-startup-failed"
  | "child-execution-failed"
  | "output-overflow"
  | "wait-timeout"
  | "wait-aborted"
  | "cleanup-grace-exceeded"
  | "workflow-not-found"
  | "workflow-source-changed"
  | "workflow-invalid-export"
  | "workflow-invalid-result"
  | "workflow-output-overflow"
  | "workflow-handle-busy"
  | "workflow-handle-frozen"
  | "workflow-cancelled"
  | "workflow-failed"
  | "child-missing-text"
  | "skill-missing"
  | "skill-ambiguous";

export class SubagentError extends Error {
  readonly name = "SubagentError";

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly executionId?: ExecutionId,
  ) {
    super(message);
  }
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function boundedExcerpt(text: string, limit = LIMITS.diagnosticBytes): string {
  if (byteLength(text) <= limit) return text;
  const marker = "\n… diagnostic excerpt incomplete; middle omitted …\n";
  const budget = Math.max(0, limit - byteLength(marker));
  let head = text.slice(0, Math.floor(budget / 2));
  let tail = text.slice(-Math.ceil(budget / 2));
  while (byteLength(head + marker + tail) > limit) {
    if (byteLength(head) >= byteLength(tail)) head = head.slice(0, -1);
    else tail = tail.slice(1);
  }
  return head + marker + tail;
}

export function assertBoundedSuccess(text: string): void {
  if (byteLength(text) > LIMITS.outputBytes) {
    throw new SubagentError("output-overflow", `Child output exceeds ${LIMITS.outputBytes} UTF-8 bytes`);
  }
}

export function asSubagentError(error: unknown, fallback: ErrorCode, executionId?: string): SubagentError {
  if (error instanceof SubagentError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new SubagentError(fallback, message, executionId);
}
