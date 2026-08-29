import assert from "node:assert/strict";
import test from "node:test";
import { LIMITS, SubagentError } from "../extensions/subagent/domain.ts";
import {
  ChildRegistry,
  type AdapterCompletion,
  type ChildSession,
  type ChildSessionFactory,
} from "../extensions/subagent/registry.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class ControlledSession implements ChildSession {
  readonly completion = deferred<AdapterCompletion>();
  readonly controls: string[] = [];
  disposed = false;
  aborted = false;
  start() { return this.completion.promise; }
  async steer(message: string) { this.controls.push(`steer:${message}`); }
  async followUp(message: string) { this.controls.push(`follow:${message}`); }
  async abort() { this.aborted = true; this.completion.resolve({ status: "cancelled" }); }
  dispose() { this.disposed = true; }
}

function harness(options: { schedule?: (fn: () => void) => void } = {}) {
  const sessions: ControlledSession[] = [];
  const constructed: string[] = [];
  const injected: string[] = [];
  let id = 0;
  const factory: ChildSessionFactory = {
    async create(request) {
      constructed.push(request.executionId);
      const session = new ControlledSession();
      sessions.push(session);
      return session;
    },
  };
  const registry = new ChildRegistry({
    factory,
    delivery: { inject: (completion) => { injected.push(completion.executionId); } },
    identity: (kind) => `${kind}-${++id}`,
    schedule: options.schedule,
  });
  const launch = (task = "work") => registry.launch({
    task,
    cwd: "/tmp",
    model: "test/model",
    thinkingLevel: "off",
    tools: ["read"],
  });
  return { registry, sessions, constructed, injected, launch };
}

async function tick() { await Promise.resolve(); await Promise.resolve(); }

void test("the oldest live waiter consumes one immutable completion before injection", async () => {
  const scheduled: Array<() => void> = [];
  const h = harness({ schedule: (fn) => scheduled.push(fn) });
  const { executionId } = h.launch();
  await tick();
  const first = h.registry.wait(executionId);
  const second = h.registry.wait(executionId);
  h.sessions[0]!.completion.resolve({ status: "succeeded", text: "answer" });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.completion, b.completion);
  assert.equal(a.delivery, "consumed");
  assert.equal(h.registry.inspect(executionId).delivery.state, "consumed");
  for (const run of scheduled) run();
  assert.deepEqual(h.injected, []);
});

void test("injection acceptance is irrevocable and a late wait reports it", async () => {
  const scheduled: Array<() => void> = [];
  const h = harness({ schedule: (fn) => scheduled.push(fn) });
  const { executionId } = h.launch();
  await tick();
  h.sessions[0]!.completion.resolve({ status: "succeeded", text: "answer" });
  await tick();
  for (const run of scheduled.splice(0)) run();
  const result = await h.registry.wait(executionId);
  assert.equal(result.alreadyInjected, true);
  assert.equal(result.delivery, "injected");
  assert.deepEqual(h.injected, [executionId]);
});

void test("a wait timeout releases ownership without cancelling execution", async () => {
  const h = harness();
  const { executionId } = h.launch();
  await tick();
  await assert.rejects(h.registry.wait(executionId, { timeoutMs: 1 }), (error: unknown) => {
    assert.ok(error instanceof SubagentError);
    assert.equal(error.code, "wait-timeout");
    return true;
  });
  assert.equal(h.sessions[0]!.aborted, false);
  assert.equal(h.registry.inspect(executionId).executionState, "running");
});

void test("admission runs four children and queues FIFO without partial construction", async () => {
  const h = harness();
  const launches = Array.from({ length: LIMITS.liveChildren }, (_, i) => h.launch(`task ${i}`));
  await tick();
  assert.equal(h.constructed.length, LIMITS.executingChildren);
  assert.throws(() => h.launch("overflow"), (error: unknown) => {
    assert.ok(error instanceof SubagentError);
    assert.equal(error.code, "capacity-rejected");
    return true;
  });
  h.sessions[0]!.completion.resolve({ status: "succeeded", text: "done" });
  await tick();
  assert.equal(h.constructed.length, LIMITS.executingChildren + 1);
  assert.equal(h.constructed.at(-1), launches[4]!.executionId);
});

void test("queued cancellation settles without constructing a Child", async () => {
  const h = harness();
  const launches = Array.from({ length: 5 }, (_, i) => h.launch(`task ${i}`));
  await tick();
  const queued = launches[4]!;
  const snapshot = await h.registry.cancel(queued.executionId);
  assert.equal(snapshot.executionState, "cancelled");
  assert.equal(h.constructed.includes(queued.executionId), false);
});

void test("cancellation during Child construction never starts the task", async () => {
  const construction = deferred<ChildSession>();
  let starts = 0;
  const session = new ControlledSession();
  session.start = () => { starts += 1; return session.completion.promise; };
  const registry = new ChildRegistry({
    factory: { create: async () => construction.promise },
    delivery: { inject() {} },
  });
  const { executionId } = registry.launch({ task: "work", cwd: "/tmp", model: "test/model", thinkingLevel: "off", tools: [] });
  const cancellation = registry.cancel(executionId);
  assert.equal(registry.inspect(executionId).executionState, "cancelling");
  construction.resolve(session);
  await cancellation;
  await tick();
  assert.equal(starts, 0);
  assert.equal(session.disposed, true);
  assert.equal(registry.inspect(executionId).executionState, "cancelled");
});

void test("reusable cancellation during construction retains the constructed Child event", async () => {
  const construction = deferred<ChildSession>();
  const session = new ControlledSession();
  const registry = new ChildRegistry({
    factory: { create: async () => construction.promise },
    delivery: { inject() {} },
  });
  const request = { task: "work", cwd: "/tmp", model: "test/model", thinkingLevel: "off", tools: [] };
  const reusable = registry.createReusable(request, new AbortController().signal);
  const execution = reusable.execute("work");
  const executionId = registry.list()[0]!.executionId;
  await registry.cancel(executionId);
  construction.resolve(session);
  await assert.rejects(execution, (error: unknown) =>
    error instanceof SubagentError && error.code === "workflow-cancelled"
  );

  const events = registry.inspect(executionId).events.map((event) => event.type);
  const childCreated = events.indexOf("child-created");
  assert.notEqual(childCreated, -1);
  assert.ok(childCreated < events.indexOf("completion-committed"));
  assert.equal(session.disposed, true);
  await reusable.close();
});

void test("successful output over 64 KiB becomes a typed failure", async () => {
  const h = harness();
  const { executionId } = h.launch();
  await tick();
  const waiting = h.registry.wait(executionId);
  h.sessions[0]!.completion.resolve({ status: "succeeded", text: "x".repeat(LIMITS.outputBytes + 1) });
  const result = await waiting;
  assert.equal(result.completion.status, "failed");
  assert.equal(result.completion.error?.code, "output-overflow");
  assert.equal(result.completion.text, undefined);
});

void test("steering and follow-up target only a live execution and preserve per-queue order", async () => {
  const h = harness();
  const { executionId } = h.launch();
  await tick();
  await Promise.all([
    h.registry.followUp(executionId, "one"),
    h.registry.steer(executionId, "two"),
    h.registry.followUp(executionId, "three"),
  ]);
  assert.deepEqual(h.sessions[0]!.controls, ["follow:one", "steer:two", "follow:three"]);
  h.sessions[0]!.completion.resolve({ status: "succeeded", text: "done" });
  await tick();
  await assert.rejects(h.registry.steer(executionId, "late"), (error: unknown) => error instanceof SubagentError && error.code === "inactive-execution");
});

void test("cancellation is nonterminal until the Child settles and idempotent", async () => {
  const h = harness();
  const { executionId } = h.launch();
  await tick();
  const cancellation = h.registry.cancel(executionId);
  assert.equal(h.registry.inspect(executionId).executionState, "cancelling");
  const same = await h.registry.cancel(executionId);
  assert.equal(same.executionState, "cancelling");
  await cancellation;
  await tick();
  assert.equal(h.registry.inspect(executionId).executionState, "cancelled");
});

void test("inspection and listing do not claim pending delivery", async () => {
  const scheduled: Array<() => void> = [];
  const h = harness({ schedule: (fn) => scheduled.push(fn) });
  const { executionId } = h.launch();
  await tick();
  h.sessions[0]!.completion.resolve({ status: "failed", errorMessage: "nope" });
  await tick();
  assert.equal(h.registry.inspect(executionId).delivery.state, "pending");
  assert.equal(h.registry.list()[0]!.delivery.state, "pending");
  assert.equal(h.registry.inspect(executionId).delivery.state, "pending");
});

void test("failed injection stays pending and remains consumable by a waiter", async () => {
  const sessions: ControlledSession[] = [];
  const scheduled: Array<() => void> = [];
  const registry = new ChildRegistry({
    factory: { async create() { const session = new ControlledSession(); sessions.push(session); return session; } },
    delivery: { inject() { throw new Error("parent queue unavailable"); } },
    schedule: (fn) => scheduled.push(fn),
  });
  const { executionId } = registry.launch({ task: "work", cwd: "/tmp", model: "test/model", thinkingLevel: "off", tools: [] });
  await tick();
  sessions[0]!.completion.resolve({ status: "succeeded", text: "recoverable" });
  await tick();
  for (const run of scheduled.splice(0)) run();
  assert.equal(registry.inspect(executionId).delivery.state, "pending");
  assert.match(registry.inspect(executionId).delivery.diagnostic ?? "", /unavailable/);
  const result = await registry.wait(executionId);
  assert.equal(result.completion.text, "recoverable");
  assert.equal(result.delivery, "consumed");
});

void test("teardown winning the injection barrier discards a scheduled Completion", async () => {
  const scheduled: Array<() => void> = [];
  const h = harness({ schedule: (fn) => scheduled.push(fn) });
  const { executionId } = h.launch();
  await tick();
  h.sessions[0]!.completion.resolve({ status: "succeeded", text: "undelivered" });
  await tick();
  assert.equal(h.registry.inspect(executionId).delivery.state, "pending");
  const shutdown = h.registry.shutdown();
  for (const run of scheduled.splice(0)) run();
  await shutdown;
  assert.deepEqual(h.injected, []);
  assert.equal(h.registry.inspect(executionId).delivery.state, "discarded");
});

void test("projection listener failures cannot turn admitted work into a rejected launch", async () => {
  const h = harness();
  let publications = 0;
  h.registry.subscribe(() => {
    publications += 1;
    if (publications > 1) throw new Error("renderer failed");
  });
  const launched = h.launch();
  assert.match(launched.executionId, /^execution-/);
  await tick();
  assert.equal(h.registry.inspect(launched.executionId).executionState, "running");
});

void test("shutdown closes admission, rejects waiters, discards delivery, disposes sessions, and ignores late Child events", async () => {
  const events: Array<(type: string, data?: unknown) => void> = [];
  const sessions: ControlledSession[] = [];
  const scheduled: Array<() => void> = [];
  const registry = new ChildRegistry({
    factory: {
      async create(_request, emit) {
        events.push(emit);
        const session = new ControlledSession();
        sessions.push(session);
        return session;
      },
    },
    delivery: { inject() { throw new Error("must not inject after shutdown"); } },
    schedule: (fn) => scheduled.push(fn),
  });
  const { executionId } = registry.launch({ task: "work", cwd: "/tmp", model: "test/model", thinkingLevel: "off", tools: [] });
  await tick();
  const waiting = registry.wait(executionId);
  const shutdown = registry.shutdown();
  await assert.rejects(waiting, (error: unknown) => error instanceof SubagentError && error.code === "parent-closed");
  await shutdown;

  const closed = registry.inspect(executionId);
  const eventCount = closed.events.length;
  assert.equal(closed.executionState, "cancelled");
  assert.equal(closed.delivery.state, "discarded");
  assert.equal(sessions[0]?.aborted, true);
  assert.equal(sessions[0]?.disposed, true);
  assert.throws(() => registry.launch({ task: "late", cwd: "/tmp", model: "test/model", thinkingLevel: "off", tools: [] }), (error: unknown) => error instanceof SubagentError && error.code === "parent-closed");
  assert.throws(() => registry.createReusable({ task: "late", cwd: "/tmp", model: "test/model", thinkingLevel: "off", tools: [] }, new AbortController().signal), (error: unknown) => error instanceof SubagentError && error.code === "parent-closed");

  events[0]?.("activity", "late mutation");
  for (const run of scheduled.splice(0)) run();
  const retained = registry.inspect(executionId);
  assert.equal(retained.events.length, eventCount);
  assert.notEqual(retained.activity, "late mutation");
});

void test("shutdown during construction disposes a Child that arrives after logical release", async () => {
  const construction = deferred<ChildSession>();
  const session = new ControlledSession();
  const registry = new ChildRegistry({
    factory: { create: async () => construction.promise },
    delivery: { inject() {} },
    shutdownMs: 0,
  });
  const { executionId } = registry.launch({ task: "work", cwd: "/tmp", model: "test/model", thinkingLevel: "off", tools: [] });
  await registry.shutdown();
  construction.resolve(session);
  await tick();
  assert.equal(session.disposed, true);
  assert.equal(registry.inspect(executionId).executionState, "cancelled");
});

void test("cleanup diagnostics are retained without preventing logical settlement", async () => {
  const session = new ControlledSession();
  session.dispose = () => { session.disposed = true; throw new Error("dispose exploded"); };
  const registry = new ChildRegistry({
    factory: { async create() { return session; } },
    delivery: { inject() {} },
  });
  const { executionId } = registry.launch({ task: "work", cwd: "/tmp", model: "test/model", thinkingLevel: "off", tools: [] });
  await tick();
  session.completion.resolve({ status: "succeeded", text: "done" });
  await tick();
  const retained = registry.inspect(executionId);
  assert.equal(retained.executionState, "succeeded");
  assert.equal(session.disposed, true);
  assert.match(retained.diagnostics?.join("\n") ?? "", /dispose exploded/);
});

void test("published event data is detached, deeply immutable, and JSON-safe", async () => {
  let emit!: (type: string, data?: unknown) => void;
  const h = new ChildRegistry({
    factory: { async create(_request, callback) { emit = callback; return new ControlledSession(); } },
    delivery: { inject() {} },
  });
  const { executionId } = h.launch({ task: "work", cwd: "/tmp", model: "test/model", thinkingLevel: "off", tools: [] });
  await tick();
  const payload: { nested: { value: string }; self?: unknown } = { nested: { value: "original" } };
  payload.self = payload;
  emit("activity-detail", payload);
  payload.nested.value = "mutated";
  const data = h.inspect(executionId).events.at(-1)?.data as { nested: { value: string }; self: string };
  assert.deepEqual(data, { nested: { value: "original" }, self: "[Circular]" });
  assert.equal(Object.isFrozen(data), true);
  assert.equal(Object.isFrozen(data.nested), true);
  assert.doesNotThrow(() => JSON.stringify(h.inspect(executionId)));
});

void test("shared task-start settlement preserves each mode's failure diagnostics", async () => {
  const registry = new ChildRegistry({
    factory: {
      async create() {
        return {
          async start() { throw new Error("start exploded"); },
          async steer() {}, async followUp() {}, async abort() {}, dispose() {},
        };
      },
    },
    delivery: { inject() {} },
    schedule: () => undefined,
  });
  const request = { task: "work", cwd: "/tmp", model: "test/model", thinkingLevel: "off", tools: [] };

  const oneShot = registry.launch(request);
  await tick();
  const reusable = registry.createReusable(request, new AbortController().signal);
  await assert.rejects(reusable.execute("work"), (error: unknown) =>
    error instanceof SubagentError && error.code === "child-execution-failed"
  );

  const oneShotFailure = registry.inspect(oneShot.executionId);
  assert.equal(oneShotFailure.executionState, "failed");
  assert.equal(oneShotFailure.completion?.error?.code, "child-startup-failed");
  assert.match(oneShotFailure.completion?.diagnosticExcerpt ?? "", /start exploded/);

  const reusableFailure = registry.list().at(-1)!;
  assert.equal(reusableFailure.executionState, "failed");
  assert.equal(reusableFailure.completion?.error?.code, "child-execution-failed");
  assert.equal(reusableFailure.completion?.diagnosticExcerpt, undefined);
  await reusable.close();
});

void test("terminal inspection projections stay within 256 KiB with explicit omissions", async () => {
  const sessions: ControlledSession[] = [];
  const registry = new ChildRegistry({
    factory: {
      async create(_request, emit) {
        const session = new ControlledSession();
        sessions.push(session);
        for (let index = 0; index < 200; index += 1) emit("tool-end", "z".repeat(4_000));
        return session;
      },
    },
    delivery: { inject() {} },
    schedule: () => undefined,
  });
  const { executionId } = registry.launch({
    task: "t".repeat(300_000),
    label: "l".repeat(300_000),
    cwd: "/tmp",
    model: "test/model",
    thinkingLevel: "off",
    tools: [],
  });
  await tick();
  sessions[0]!.completion.resolve({ status: "failed", errorMessage: "e".repeat(300_000) });
  await tick();
  const inspected = registry.inspect(executionId);
  assert.ok(Buffer.byteLength(JSON.stringify(inspected), "utf8") <= LIMITS.inspectionBytes);
  assert.ok((inspected.omitted?.bytes ?? 0) > 0);
  assert.ok((inspected.omitted?.events ?? 0) > 0);
});
