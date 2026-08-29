import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createJiti } from "jiti";
import { LIMITS, SubagentError, asSubagentError, byteLength } from "./domain.ts";

export const WORKFLOW_DIRECTORY = ".pi/workflow";
const WORKFLOW_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface WorkflowDiagnostic {
  readonly entry: string;
  readonly message: string;
}

export interface WorkflowEntry {
  readonly name: string;
  readonly path: string;
  readonly symlink: boolean;
}

export interface WorkflowDiscovery {
  readonly entries: readonly WorkflowEntry[];
  readonly diagnostics: readonly WorkflowDiagnostic[];
}

export async function discoverWorkflows(cwd: string, trusted: boolean): Promise<WorkflowDiscovery> {
  if (!trusted) return Object.freeze({ entries: Object.freeze([]), diagnostics: Object.freeze([]) });
  const directory = join(cwd, WORKFLOW_DIRECTORY);
  let names: string[];
  try {
    names = (await readdir(directory)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.freeze({ entries: Object.freeze([]), diagnostics: Object.freeze([]) });
    }
    return Object.freeze({
      entries: Object.freeze([]),
      diagnostics: Object.freeze([{ entry: directory, message: `Workflow directory is unreadable: ${errorMessage(error)}` }]),
    });
  }

  const entries: WorkflowEntry[] = [];
  const diagnostics: WorkflowDiagnostic[] = [];
  for (const filename of names) {
    if (!filename.endsWith(".js")) continue;
    const name = filename.slice(0, -3);
    const path = join(directory, filename);
    if (!WORKFLOW_NAME.test(name)) {
      diagnostics.push({ entry: filename, message: "Workflow filename must be kebab-case JavaScript" });
      continue;
    }
    try {
      const link = await lstat(path);
      const target = link.isSymbolicLink() ? await stat(path) : link;
      if (!target.isFile()) {
        diagnostics.push({ entry: filename, message: "Workflow target is not a file" });
        continue;
      }
      await access(path, constants.R_OK);
      entries.push(Object.freeze({ name, path, symlink: link.isSymbolicLink() }));
    } catch (error) {
      diagnostics.push({ entry: filename, message: `Workflow is not runnable: ${errorMessage(error)}` });
    }
  }
  return Object.freeze({ entries: Object.freeze(entries), diagnostics: Object.freeze(diagnostics) });
}

export interface LoadedWorkflow {
  readonly workflow: WorkflowFunction;
  readonly digest: string;
  readonly sourcePath: string;
}

export type WorkflowFunction = (runtime: WorkflowRuntime, args: readonly string[]) => unknown | Promise<unknown>;

export interface WorkflowModuleLoader {
  load(entry: WorkflowEntry): Promise<LoadedWorkflow>;
}

export interface JitiWorkflowLoaderOptions {
  readSource?: (path: string) => Promise<Uint8Array>;
  importModule?: (path: string) => Promise<unknown>;
}

export class JitiWorkflowLoader implements WorkflowModuleLoader {
  constructor(private readonly options: JitiWorkflowLoaderOptions = {}) {}

  async load(entry: WorkflowEntry): Promise<LoadedWorkflow> {
    const readSource = this.options.readSource ?? readFile;
    const before = await readSource(entry.path);
    const digest = sourceDigest(before);
    let exported: unknown;
    try {
      exported = await (this.options.importModule ?? freshJitiImport)(entry.path);
    } catch (error) {
      throw withSourceDigest(
        new SubagentError("workflow-failed", `Workflow ${entry.name} failed to load: ${errorMessage(error)}`),
        digest,
      );
    }
    const after = await readSource(entry.path);
    if (sourceDigest(after) !== digest) {
      throw withSourceDigest(
        new SubagentError("workflow-source-changed", `Workflow source changed while loading: ${entry.name}`),
        digest,
      );
    }
    if (typeof exported !== "function") {
      throw withSourceDigest(
        new SubagentError("workflow-invalid-export", `Workflow ${entry.name} must have a function-valued default export`),
        digest,
      );
    }
    return Object.freeze({ workflow: exported as WorkflowFunction, digest, sourcePath: entry.path });
  }
}

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

export interface WorkflowChild {
  execute(task: string): Promise<string>;
  close(options?: { cancel?: boolean }): Promise<void>;
}

export interface WorkflowChildBackend {
  open(config: {
    readonly label: string;
    readonly model?: string;
    readonly skills: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<WorkflowChild>;
}

export type WorkflowCaller = "command" | "tool" | "internal";

export interface WorkflowInvocationResult {
  readonly text: string;
  readonly name: string;
  readonly digest: string;
  readonly sourcePath: string;
  readonly args: readonly string[];
  readonly caller: WorkflowCaller;
}

export interface WorkflowInvokerOptions {
  cwd: string;
  trusted: () => boolean;
  backend: WorkflowChildBackend;
  loader?: WorkflowModuleLoader;
  discover?: (cwd: string, trusted: boolean) => Promise<WorkflowDiscovery>;
  cleanupMs?: number;
  shutdownMs?: number;
}

export class WorkflowInvoker {
  private readonly loader: WorkflowModuleLoader;
  private readonly discovery: (cwd: string, trusted: boolean) => Promise<WorkflowDiscovery>;
  private readonly invocations = new Map<AbortController, Promise<void>>();
  private closed = false;

  constructor(private readonly options: WorkflowInvokerOptions) {
    this.loader = options.loader ?? new JitiWorkflowLoader();
    this.discovery = options.discover ?? discoverWorkflows;
  }

  async list(): Promise<WorkflowDiscovery> {
    return this.discovery(this.options.cwd, this.options.trusted());
  }

  async invoke(
    name: string,
    args: readonly string[],
    signal?: AbortSignal,
    caller: WorkflowCaller = "internal",
  ): Promise<WorkflowInvocationResult> {
    if (this.closed) throw new SubagentError("parent-closed", "Workflow runtime is closed");
    if (!WORKFLOW_NAME.test(name)) throw new SubagentError("workflow-not-found", `Invalid workflow identity: ${name}`);
    if (args.some((arg) => typeof arg !== "string")) {
      throw new SubagentError("invalid-arguments", "Workflow arguments must be positional strings");
    }

    const invocation = new AbortController();
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => { markSettled = resolve; });
    const abort = () => invocation.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    this.invocations.set(invocation, settled);

    const frozenArgs = Object.freeze([...args]);
    const handles = new Set<ManagedWorkflowHandle>();
    let revoked = false;
    let loading: Promise<LoadedWorkflow> | undefined;
    let primary: unknown;
    let provisional: WorkflowInvocationResult | undefined;
    try {
      const discovered = await raceCancellation(this.list(), invocation.signal);
      const entry = discovered.entries.find((candidate) => candidate.name === name);
      if (!entry) throw new SubagentError("workflow-not-found", `Workflow is not runnable: ${name}`);
      let loaded: LoadedWorkflow;
      try {
        loading = this.loader.load(entry);
        loaded = await raceCancellation(loading, invocation.signal);
      } catch (error) {
        if (error instanceof SubagentError) throw error;
        throw new SubagentError("workflow-failed", `Workflow ${name} failed to load: ${errorMessage(error)}`);
      }
      const runtime = Object.freeze({
        createHandle: (options: WorkflowHandleCreationOptions): WorkflowHandle => {
          if (revoked || invocation.signal.aborted) throw cancellationError(invocation.signal);
          if (!options || typeof options.label !== "string" || !options.label.trim()) {
            throw new SubagentError("invalid-arguments", "Workflow Handle label must not be empty");
          }
          const frozenOptions = Object.freeze({ label: options.label.trim(), model: options.model });
          const handle = new ManagedWorkflowHandle(this.options.backend, frozenOptions.label, frozenOptions, invocation.signal, () => revoked);
          handles.add(handle);
          return handle;
        },
      });
      const value = await raceCancellation(Promise.resolve(loaded.workflow(runtime, frozenArgs)), invocation.signal);
      if (invocation.signal.aborted) throw cancellationError(invocation.signal);
      if (typeof value !== "string" || !value.trim()) {
        throw new SubagentError("workflow-invalid-result", `Workflow ${name} must return non-whitespace text`);
      }
      if (byteLength(value) > LIMITS.outputBytes) {
        throw new SubagentError("workflow-output-overflow", `Workflow result exceeds ${LIMITS.outputBytes} UTF-8 bytes`);
      }
      provisional = Object.freeze({ text: value, name, digest: loaded.digest, sourcePath: loaded.sourcePath, args: frozenArgs, caller });
    } catch (error) {
      primary = error;
      invocation.abort(primary);
    } finally {
      revoked = true;
      signal?.removeEventListener("abort", abort);
      const cleanupError = await closeInvocation(handles, loading, this.options.cleanupMs ?? LIMITS.cleanupMs);
      this.invocations.delete(invocation);
      markSettled();
      if (cleanupError) {
        if (primary === undefined) primary = cleanupError;
        else attachCleanup(primary, cleanupError);
      }
    }
    if (primary !== undefined) throw primary;
    return provisional!;
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const active = Array.from(this.invocations.entries());
    for (const [invocation] of active) invocation.abort(new SubagentError("parent-closed", "Parent runtime closed"));
    if (active.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(active.map(([, settled]) => settled)),
        new Promise((resolve) => { timer = setTimeout(resolve, this.options.shutdownMs ?? LIMITS.shutdownMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

class ManagedWorkflowHandle implements WorkflowHandle {
  private readonly skills: string[] = [];
  private child?: Promise<WorkflowChild>;
  private executing = false;
  private closed = false;

  constructor(
    private readonly backend: WorkflowChildBackend,
    private readonly label: string,
    private readonly options: WorkflowHandleCreationOptions,
    private readonly signal: AbortSignal,
    private readonly revoked: () => boolean,
  ) {}

  skill(name: string): WorkflowHandle {
    this.assertConfigurable();
    if (typeof name !== "string" || !name.trim()) throw new SubagentError("invalid-arguments", "Skill name must not be empty");
    if (!this.skills.includes(name)) this.skills.push(name);
    return this;
  }

  async execute(task: string): Promise<string> {
    if (this.closed || this.revoked() || this.signal.aborted) throw cancellationError(this.signal);
    if (this.executing) throw new SubagentError("workflow-handle-busy", `Workflow Handle ${this.label} is already executing`);
    if (typeof task !== "string" || !task.trim()) throw new SubagentError("invalid-arguments", "Handle task must not be empty");
    this.executing = true;
    try {
      this.child ??= this.backend.open(Object.freeze({
        label: this.label,
        model: this.options.model,
        skills: Object.freeze([...this.skills]),
        signal: this.signal,
      }));
      const child = await raceCancellation(this.child, this.signal);
      const text = await raceCancellation(child.execute(task), this.signal);
      if (typeof text !== "string" || !text.trim()) {
        throw new SubagentError("child-missing-text", `Child ${this.label} settled without final text`);
      }
      if (byteLength(text) > LIMITS.outputBytes) {
        throw new SubagentError("output-overflow", `Child output exceeds ${LIMITS.outputBytes} UTF-8 bytes`);
      }
      return text;
    } catch (error) {
      throw asSubagentError(error, this.signal.aborted ? "workflow-cancelled" : "child-execution-failed");
    } finally {
      this.executing = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.child) return;
    const child = await this.child;
    await child.close({ cancel: this.executing || this.signal.aborted });
  }

  private assertConfigurable(): void {
    if (this.closed || this.revoked()) throw cancellationError(this.signal);
    if (this.child) throw new SubagentError("workflow-handle-frozen", `Workflow Handle ${this.label} configuration is frozen`);
  }
}

async function closeInvocation(
  handles: Set<ManagedWorkflowHandle>,
  loading: Promise<LoadedWorkflow> | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const handleSettlement = Promise.allSettled(Array.from(handles, (handle) => handle.close())).then((results) => {
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), "Workflow Handle cleanup failed");
  });
  const settlement = Promise.all([
    handleSettlement,
    loading?.then(() => undefined, () => undefined) ?? Promise.resolve(),
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SubagentError(
      "cleanup-grace-exceeded",
      `Workflow cleanup exceeded ${timeoutMs}ms; in-process JavaScript has no hard-kill guarantee`,
    )), timeoutMs);
  });
  try {
    await Promise.race([settlement, timeout]);
    return undefined;
  } catch (error) {
    return error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function raceCancellation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancellationError(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(cancellationError(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function cancellationError(signal?: AbortSignal): SubagentError {
  if (signal?.reason instanceof SubagentError) return signal.reason;
  return new SubagentError("workflow-cancelled", "Workflow invocation was cancelled");
}

async function freshJitiImport(path: string): Promise<unknown> {
  const jiti = createJiti(path, {
    moduleCache: false,
    fsCache: false,
    tryNative: false,
    interopDefault: true,
  });
  return jiti.import<unknown>(path, { default: true });
}

function sourceDigest(source: Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withSourceDigest(error: SubagentError, digest: string): SubagentError {
  Object.defineProperty(error, "sourceDigest", { value: digest, enumerable: true });
  return error;
}

function attachCleanup(primary: unknown, cleanup: unknown): void {
  if (primary && typeof primary === "object") {
    Object.defineProperty(primary, "cleanupError", { value: cleanup, enumerable: false, configurable: true });
  }
}
