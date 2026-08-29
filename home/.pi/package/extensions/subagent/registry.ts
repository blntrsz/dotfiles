import {
  LIMITS,
  SubagentError,
  asSubagentError,
  assertBoundedSuccess,
  boundedExcerpt,
  type Completion,
  type ContextMode,
  type DeliveryState,
  type ErrorCode,
  type ExecutionSnapshot,
  type NormalizedEvent,
  type UsageSnapshot,
} from "./domain.ts";

export interface LaunchRequest {
  task: string;
  label?: string;
  context?: ContextMode;
  model: string;
  thinkingLevel: string;
  cwd: string;
  tools: readonly string[];
  forkMessages?: readonly unknown[];
}

export interface AdapterCompletion {
  status: "succeeded" | "failed" | "cancelled";
  text?: string;
  errorCode?: ErrorCode;
  errorMessage?: string;
  diagnostic?: string;
}

export interface ChildSession {
  start(task: string): Promise<AdapterCompletion>;
  steer(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

export interface ChildSessionFactory {
  create(
    request: LaunchRequest & { childId: string; executionId: string },
    emit: (type: string, data?: unknown) => void,
  ): Promise<ChildSession>;
}

export interface DeliveryPort {
  /** Must return only after synchronous Pi queue acceptance; throw before acceptance on failure. */
  inject(completion: Completion, snapshot: ExecutionSnapshot): void;
}

export interface RegistryOptions {
  factory: ChildSessionFactory;
  delivery: DeliveryPort;
  now?: () => number;
  identity?: (kind: "child" | "execution") => string;
  schedule?: (callback: () => void) => void;
  cleanupMs?: number;
  shutdownMs?: number;
}

interface Waiter {
  id: number;
  resolve: (result: WaitResult) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  removeAbort?: () => void;
}

interface RecordState {
  childId: string;
  executionId: string;
  request: LaunchRequest;
  label: string;
  childState: ExecutionSnapshot["childState"];
  executionState: ExecutionSnapshot["executionState"];
  deliveryState: DeliveryState;
  deliveryDiagnostic?: string;
  completion?: Completion;
  activity: string;
  events: NormalizedEvent[];
  eventSequence: number;
  usage: UsageSnapshot;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  session?: ChildSession;
  waiters: Waiter[];
  steerTail: Promise<void>;
  followUpTail: Promise<void>;
  pendingControls: number;
  provisional?: AdapterCompletion;
  cancelRequested: boolean;
}

export interface LaunchResult {
  childId: string;
  executionId: string;
  state: "starting" | "running";
}

export interface WaitResult {
  completion: Completion;
  delivery: DeliveryState;
  alreadyInjected: boolean;
}

const EMPTY_USAGE: UsageSnapshot = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
};

let fallbackIdentity = 0;
function defaultIdentity(kind: "child" | "execution"): string {
  fallbackIdentity += 1;
  return `${kind === "child" ? "ch" : "ex"}_${Date.now().toString(36)}_${fallbackIdentity.toString(36)}`;
}

export class ChildRegistry {
  private readonly records = new Map<string, RecordState>();
  private readonly queue: RecordState[] = [];
  private readonly listeners = new Set<(snapshots: readonly ExecutionSnapshot[]) => void>();
  private readonly now: () => number;
  private readonly identity: (kind: "child" | "execution") => string;
  private readonly schedule: (callback: () => void) => void;
  private executing = 0;
  private liveChildren = 0;
  private completionSequence = 0;
  private waiterSequence = 0;
  private closed = false;
  private injectionScheduled = false;
  private shutdownPromise?: Promise<void>;

  constructor(private readonly options: RegistryOptions) {
    this.now = options.now ?? Date.now;
    this.identity = options.identity ?? defaultIdentity;
    this.schedule = options.schedule ?? queueMicrotask;
  }

  launch(request: LaunchRequest): LaunchResult {
    this.assertOpen();
    if (!request.task.trim()) throw new SubagentError("invalid-arguments", "Task must not be empty");
    if (this.nonterminalCount() >= LIMITS.nonterminalExecutions || this.liveChildren >= LIMITS.liveChildren) {
      throw new SubagentError("capacity-rejected", "Subagent capacity is full; no work was admitted");
    }

    const childId = this.identity("child");
    const executionId = this.identity("execution");
    const record: RecordState = {
      childId,
      executionId,
      request: { ...request, tools: Object.freeze([...request.tools]), forkMessages: request.forkMessages ? Object.freeze([...request.forkMessages]) : undefined },
      label: boundedExcerpt(request.label?.trim() || "subagent", 1_024),
      childState: "unstarted",
      executionState: "starting",
      deliveryState: "pending",
      activity: "queued",
      events: [],
      eventSequence: 0,
      usage: { ...EMPTY_USAGE },
      createdAt: this.now(),
      waiters: [],
      steerTail: Promise.resolve(),
      followUpTail: Promise.resolve(),
      pendingControls: 0,
      cancelRequested: false,
    };
    this.records.set(executionId, record);
    this.liveChildren += 1;
    this.emit(record, "execution-admitted", { context: request.context ?? "fresh" });

    if (this.executing < LIMITS.executingChildren) void this.start(record);
    else this.queue.push(record);
    this.publish();
    return {
      childId,
      executionId,
      state: record.executionState === "running" ? "running" : "starting",
    };
  }

  wait(executionId: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<WaitResult> {
    this.assertOpen();
    const record = this.get(executionId);
    if (record.completion) return Promise.resolve(this.observeTerminal(record, true));

    return new Promise<WaitResult>((resolve, reject) => {
      const waiter: Waiter = { id: ++this.waiterSequence, resolve, reject };
      record.waiters.push(waiter);
      record.activity = "parent waiting";
      this.emit(record, "wait-started", { waiterId: waiter.id });

      const release = (error: SubagentError) => {
        const index = record.waiters.indexOf(waiter);
        if (index < 0) return;
        record.waiters.splice(index, 1);
        this.clearWaiter(waiter);
        this.emit(record, "wait-released", { waiterId: waiter.id, code: error.code });
        reject(error);
        this.publish();
        this.scheduleInjection();
      };

      if (options.timeoutMs !== undefined) {
        if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
          release(new SubagentError("invalid-arguments", "timeoutMs must be a non-negative number", executionId));
          return;
        }
        waiter.timer = setTimeout(
          () => release(new SubagentError("wait-timeout", "Wait timed out; execution continues", executionId)),
          options.timeoutMs,
        );
      }
      if (options.signal) {
        const abort = () => release(new SubagentError("wait-aborted", "Wait aborted; execution continues", executionId));
        if (options.signal.aborted) abort();
        else {
          options.signal.addEventListener("abort", abort, { once: true });
          waiter.removeAbort = () => options.signal?.removeEventListener("abort", abort);
        }
      }
      this.publish();
    });
  }

  steer(executionId: string, message: string): Promise<void> {
    return this.control(executionId, "steer", message);
  }

  followUp(executionId: string, message: string): Promise<void> {
    return this.control(executionId, "follow-up", message);
  }

  async cancel(executionId: string): Promise<ExecutionSnapshot> {
    this.assertOpen();
    const record = this.get(executionId);
    if (record.completion) return this.snapshot(record);
    if (record.cancelRequested) return this.snapshot(record);
    record.cancelRequested = true;

    if (record.executionState === "starting" && !record.session) {
      const queueIndex = this.queue.indexOf(record);
      if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
      record.executionState = "cancelling";
      record.activity = "cancelling queued execution";
      this.emit(record, "cancellation-requested");
      this.commit(record, { status: "cancelled", errorCode: "child-execution-failed", errorMessage: "Cancelled before Child construction" });
      this.closeChild(record);
      this.drain();
      return this.snapshot(record);
    }

    record.executionState = "cancelling";
    record.activity = "cancelling (cooperative; not terminal)";
    this.emit(record, "cancellation-requested");
    this.publish();
    const session = record.session;
    if (!session) return this.snapshot(record);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.options.cleanupMs ?? LIMITS.cleanupMs);
    });
    const outcome = await Promise.race([
      session.abort().then(() => "aborted" as const, () => "aborted" as const),
      grace,
    ]);
    if (timer) clearTimeout(timer);
    if (!record.completion && outcome === "timeout") {
      this.commit(record, {
        status: "cancelled",
        errorCode: "cleanup-grace-exceeded",
        errorMessage: "Cleanup grace exceeded; logical cancellation committed. In-process work has no hard-kill guarantee.",
      });
      this.closeChild(record);
    }
    return this.snapshot(record);
  }

  inspect(executionId: string): ExecutionSnapshot {
    return this.snapshot(this.get(executionId));
  }

  list(): readonly ExecutionSnapshot[] {
    return Object.freeze(Array.from(this.records.values(), (record) => this.snapshot(record)));
  }

  subscribe(listener: (snapshots: readonly ExecutionSnapshot[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.list());
    return () => this.listeners.delete(listener);
  }

  retryPendingDelivery(): void {
    this.scheduleInjection();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    for (const record of this.records.values()) {
      for (const waiter of record.waiters.splice(0)) {
        this.clearWaiter(waiter);
        waiter.reject(new SubagentError("parent-closed", "Parent runtime closed", record.executionId));
      }
      if (!record.completion && record.executionState === "starting" && !record.session) {
        this.commit(record, { status: "cancelled", errorCode: "parent-closed", errorMessage: "Parent runtime closed" });
      }
    }
    this.queue.length = 0;

    const active = Array.from(this.records.values()).filter((record) => record.session && !record.completion);
    const cleanup = Promise.allSettled(active.map(async (record) => {
      record.cancelRequested = true;
      record.executionState = "cancelling";
      await record.session?.abort().catch(() => undefined);
    }));
    await Promise.race([
      cleanup,
      new Promise((resolve) => setTimeout(resolve, this.options.shutdownMs ?? LIMITS.shutdownMs)),
    ]);

    for (const record of this.records.values()) {
      if (!record.completion) this.commit(record, { status: "cancelled", errorCode: "parent-closed", errorMessage: "Parent runtime closed" });
      if (record.deliveryState === "pending") record.deliveryState = "discarded";
      this.closeChild(record);
    }
    this.publish();
    this.listeners.clear();
  }

  private async start(record: RecordState): Promise<void> {
    if (this.closed || record.completion || record.cancelRequested) return;
    this.executing += 1;
    record.childState = "executing";
    record.executionState = "running";
    record.activity = "constructing Child";
    record.startedAt = this.now();
    this.emit(record, "execution-started");
    this.publish();

    try {
      const session = await this.options.factory.create(
        { ...record.request, childId: record.childId, executionId: record.executionId },
        (type, data) => this.emit(record, type, data),
      );
      if (record.completion || this.closed || record.cancelRequested) {
        session.dispose();
        if (!record.completion) {
          this.commit(record, {
            status: "cancelled",
            errorCode: "child-execution-failed",
            errorMessage: "Cancelled during Child construction; no task was started",
          });
          this.closeChild(record);
        }
        return;
      }
      record.session = session;
      record.activity = "working";
      this.emit(record, "child-created");
      const provisional = await session.start(record.request.task);
      record.provisional = provisional;
      this.trySettle(record);
    } catch (error) {
      if (!record.completion) {
        const normalized = asSubagentError(error, "child-startup-failed", record.executionId);
        this.commit(record, {
          status: record.cancelRequested ? "cancelled" : "failed",
          errorCode: normalized.code,
          errorMessage: normalized.message,
          diagnostic: normalized.message,
        });
      }
    } finally {
      if (record.completion) this.closeChild(record);
    }
  }

  private trySettle(record: RecordState): void {
    if (!record.provisional || record.pendingControls > 0 || record.completion) return;
    this.commit(record, record.provisional);
    this.closeChild(record);
  }

  private commit(record: RecordState, candidate: AdapterCompletion): void {
    if (record.completion) return;
    let status = candidate.status;
    let text = candidate.text;
    let errorCode = candidate.errorCode;
    let errorMessage = candidate.errorMessage;
    try {
      if (status === "succeeded") {
        text = text ?? "";
        assertBoundedSuccess(text);
      }
    } catch (error) {
      const normalized = asSubagentError(error, "output-overflow", record.executionId);
      status = "failed";
      errorCode = normalized.code;
      errorMessage = normalized.message;
    }

    record.completedAt = this.now();
    record.executionState = status;
    record.activity = status;
    record.completion = Object.freeze({
      sequence: ++this.completionSequence,
      executionId: record.executionId,
      childId: record.childId,
      status,
      text: status === "succeeded" ? text : undefined,
      error: status === "succeeded" ? undefined : Object.freeze({
        code: errorCode ?? "child-execution-failed",
        message: boundedExcerpt(errorMessage ?? status),
      }),
      diagnosticExcerpt: candidate.diagnostic ? boundedExcerpt(candidate.diagnostic) : undefined,
      committedAt: record.completedAt,
    });
    this.emit(record, "completion-committed", { status });

    if (record.waiters.length > 0) {
      record.deliveryState = "consumed";
      const waiters = record.waiters.splice(0);
      for (const waiter of waiters) {
        this.clearWaiter(waiter);
        waiter.resolve({ completion: record.completion, delivery: "consumed", alreadyInjected: false });
      }
    }
    this.publish();
    this.scheduleInjection();
  }

  private observeTerminal(record: RecordState, consumePending: boolean): WaitResult {
    const completion = record.completion!;
    const alreadyInjected = record.deliveryState === "injected";
    if (consumePending && record.deliveryState === "pending") {
      record.deliveryState = "consumed";
      this.emit(record, "delivery-consumed");
      this.publish();
    }
    return { completion, delivery: record.deliveryState, alreadyInjected };
  }

  private scheduleInjection(): void {
    if (this.injectionScheduled || this.closed) return;
    this.injectionScheduled = true;
    this.schedule(() => {
      this.injectionScheduled = false;
      const eligible = Array.from(this.records.values())
        .filter((record) => record.completion && record.deliveryState === "pending" && record.waiters.length === 0)
        .sort((a, b) => a.completion!.sequence - b.completion!.sequence);
      for (const record of eligible) {
        try {
          this.options.delivery.inject(record.completion!, this.snapshot(record));
          record.deliveryState = "injected";
          record.deliveryDiagnostic = undefined;
          this.emit(record, "delivery-injected");
        } catch (error) {
          record.deliveryDiagnostic = boundedExcerpt(error instanceof Error ? error.message : String(error));
          this.emit(record, "delivery-failed", { diagnostic: record.deliveryDiagnostic });
          break;
        }
      }
      this.publish();
    });
  }

  private control(executionId: string, kind: "steer" | "follow-up", message: string): Promise<void> {
    this.assertOpen();
    if (!message.trim()) return Promise.reject(new SubagentError("invalid-arguments", `${kind} message must not be empty`, executionId));
    const record = this.get(executionId);
    if (!record.session || record.completion || record.cancelRequested || record.executionState === "cancelling") {
      return Promise.reject(new SubagentError("inactive-execution", `Execution cannot accept ${kind}`, executionId));
    }
    record.pendingControls += 1;
    this.emit(record, `${kind}-reserved`);
    const previous = kind === "steer" ? record.steerTail : record.followUpTail;
    const operation = previous.then(async () => {
      if (record.completion || record.cancelRequested) throw new SubagentError("inactive-execution", `Execution cannot accept ${kind}`, executionId);
      if (kind === "steer") await record.session!.steer(message);
      else await record.session!.followUp(message);
      this.emit(record, `${kind}-accepted`);
    });
    const tail = operation.catch(() => undefined).finally(() => {
      record.pendingControls -= 1;
      this.trySettle(record);
    });
    if (kind === "steer") record.steerTail = tail;
    else record.followUpTail = tail;
    return operation;
  }

  private closeChild(record: RecordState): void {
    if (record.childState === "closed") return;
    record.childState = "closing";
    try { record.session?.dispose(); } catch { /* disposal is diagnostic-only */ }
    record.session = undefined;
    record.childState = "closed";
    if (record.startedAt !== undefined) this.executing = Math.max(0, this.executing - 1);
    this.liveChildren = Math.max(0, this.liveChildren - 1);
    this.emit(record, "child-closed");
    this.publish();
    this.drain();
  }

  private drain(): void {
    if (this.closed) return;
    while (this.executing < LIMITS.executingChildren && this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (!next.completion && !next.cancelRequested) void this.start(next);
    }
  }

  private emit(record: RecordState, type: string, data?: unknown): void {
    const event: NormalizedEvent = Object.freeze({
      childId: record.childId,
      executionId: record.executionId,
      sequence: ++record.eventSequence,
      timestamp: this.now(),
      type,
      data,
    });
    record.events.push(event);
    if (record.events.length > 200) record.events.splice(0, record.events.length - 200);
    if (type === "activity" && typeof data === "string") record.activity = boundedExcerpt(data, 2_048);
    if (type === "usage" && data && typeof data === "object") {
      const delta = data as Partial<UsageSnapshot>;
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const) {
        record.usage[key] += typeof delta[key] === "number" ? delta[key] : 0;
      }
    }
  }

  private snapshot(record: RecordState): ExecutionSnapshot {
    const base: ExecutionSnapshot = {
      childId: record.childId,
      executionId: record.executionId,
      label: record.label,
      task: record.request.task,
      context: record.request.context ?? "fresh",
      model: record.request.model,
      thinkingLevel: record.request.thinkingLevel,
      childState: record.childState,
      executionState: record.executionState,
      delivery: Object.freeze({ state: record.deliveryState, diagnostic: record.deliveryDiagnostic }),
      completion: record.completion,
      activity: record.activity,
      events: Object.freeze([...record.events]),
      usage: Object.freeze({ ...record.usage }),
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
    };
    const encoded = JSON.stringify(base);
    if (Buffer.byteLength(encoded, "utf8") <= LIMITS.inspectionBytes) return Object.freeze(base);
    const keep = record.events.slice(-25).map((event) => Object.freeze({ ...event, data: undefined }));
    const bounded: ExecutionSnapshot = {
      ...base,
      task: boundedExcerpt(base.task, LIMITS.outputBytes),
      events: Object.freeze(keep),
      omitted: Object.freeze({
        bytes: Buffer.byteLength(encoded, "utf8") - LIMITS.inspectionBytes,
        events: record.events.length - keep.length,
      }),
    };
    return Object.freeze(bounded);
  }

  private publish(): void {
    if (this.listeners.size === 0) return;
    const snapshots = this.list();
    for (const listener of this.listeners) listener(snapshots);
  }

  private clearWaiter(waiter: Waiter): void {
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.removeAbort?.();
  }

  private get(executionId: string): RecordState {
    const record = this.records.get(executionId);
    if (!record) throw new SubagentError("unknown-execution", `Unknown execution: ${executionId}`, executionId);
    return record;
  }

  private assertOpen(): void {
    if (this.closed) throw new SubagentError("parent-closed", "Parent runtime is closed");
  }

  private nonterminalCount(): number {
    let count = 0;
    for (const record of this.records.values()) if (!record.completion) count += 1;
    return count;
  }
}
