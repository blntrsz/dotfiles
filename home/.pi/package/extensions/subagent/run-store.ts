import type { ExecutionSnapshot } from "./domain.ts";
import type { ChildRegistry, WaitResult } from "./registry.ts";

/** Read-only immutable process-lifetime projection consumed by renderers and inspectors. */
export class RunStore {
  private readonly snapshots = new Map<string, ExecutionSnapshot>();
  private readonly listeners = new Set<(snapshots: readonly ExecutionSnapshot[]) => void>();
  private readonly unsubscribeRegistry: () => void;

  constructor(private readonly registry: Pick<ChildRegistry, "inspect" | "list" | "subscribe">) {
    this.replace(registry.list());
    this.unsubscribeRegistry = registry.subscribe((snapshots) => {
      this.replace(snapshots);
      for (const listener of this.listeners) listener(snapshots);
    });
  }

  lookup(executionId: string): ExecutionSnapshot {
    const projected = this.snapshots.get(executionId);
    if (projected) return projected;
    const inspected = this.registry.inspect(executionId);
    this.snapshots.set(executionId, inspected);
    return inspected;
  }

  list(): readonly ExecutionSnapshot[] { return Object.freeze([...this.snapshots.values()]); }

  subscribe(listener: (snapshots: readonly ExecutionSnapshot[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.list());
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.unsubscribeRegistry();
    this.listeners.clear();
    this.snapshots.clear();
  }

  private replace(snapshots: readonly ExecutionSnapshot[]): void {
    this.snapshots.clear();
    for (const snapshot of snapshots) this.snapshots.set(snapshot.executionId, snapshot);
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
