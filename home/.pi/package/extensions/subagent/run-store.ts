import type { ExecutionSnapshot } from "./domain.ts";
import type { ChildRegistry, WaitResult } from "./registry.ts";

/** Read-only immutable process-lifetime projection consumed by renderers and inspectors. */
export class RunStore {
  constructor(private readonly registry: Pick<ChildRegistry, "inspect" | "list" | "subscribe">) {}
  lookup(executionId: string): ExecutionSnapshot { return this.registry.inspect(executionId); }
  list(): readonly ExecutionSnapshot[] { return this.registry.list(); }
  subscribe(listener: (snapshots: readonly ExecutionSnapshot[]) => void): () => void {
    return this.registry.subscribe(listener);
  }
}

/** Narrow mutation seam used by tools and UI; it does not duplicate coordinator state. */
export class RunController {
  constructor(private readonly registry: Pick<ChildRegistry, "wait" | "steer" | "followUp" | "cancel">) {}
  wait(executionId: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<WaitResult> {
    return this.registry.wait(executionId, options);
  }
  steer(executionId: string, message: string): Promise<void> { return this.registry.steer(executionId, message); }
  followUp(executionId: string, message: string): Promise<void> { return this.registry.followUp(executionId, message); }
  cancel(executionId: string): Promise<ExecutionSnapshot> { return this.registry.cancel(executionId); }
}
