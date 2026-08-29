import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SubagentError } from "../extensions/subagent/domain.ts";
import { ChildRegistry } from "../extensions/subagent/registry.ts";
import { PiWorkflowBackend } from "../extensions/subagent/workflow-backend.ts";
import { forcedSkillsPrompt } from "../extensions/subagent/sdk-adapter.ts";
import {
  JitiWorkflowLoader,
  WorkflowInvoker,
  discoverWorkflows,
  type WorkflowChild,
  type WorkflowChildBackend,
  type WorkflowEntry,
} from "../extensions/subagent/workflow.ts";

async function project(): Promise<{ cwd: string; workflowDir: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-"));
  const workflowDir = join(cwd, ".pi/workflow");
  await mkdir(workflowDir, { recursive: true });
  return { cwd, workflowDir };
}

class RecordingBackend implements WorkflowChildBackend {
  readonly opens: Array<{ label: string; model?: string; skills: readonly string[]; child: RecordingChild }> = [];
  async open(config: { label: string; model?: string; skills: readonly string[] }): Promise<WorkflowChild> {
    const child = new RecordingChild();
    this.opens.push({ ...config, child });
    return child;
  }
}

class RecordingChild implements WorkflowChild {
  readonly tasks: string[] = [];
  closed = 0;
  async execute(task: string): Promise<string> {
    this.tasks.push(task);
    return `answer:${this.tasks.join("|")}`;
  }
  async close(): Promise<void> { this.closed += 1; }
}

void test("trusted discovery is passive, direct, diagnosed, and lexicographically ordered", async () => {
  const { cwd, workflowDir } = await project();
  (globalThis as any).__workflowEvaluated = 0;
  await writeFile(join(workflowDir, "z-last.js"), "globalThis.__workflowEvaluated++; export default () => 'z'\n");
  await writeFile(join(workflowDir, "a-first.js"), "globalThis.__workflowEvaluated++; export default () => 'a'\n");
  await writeFile(join(workflowDir, "Bad_Name.js"), "export default () => 'bad'\n");
  await mkdir(join(workflowDir, "nested"));
  await mkdir(join(workflowDir, "not-a-file.js"));
  await writeFile(join(workflowDir, "nested/ignored.js"), "throw new Error('must not load')\n");
  await symlink(join(workflowDir, "a-first.js"), join(workflowDir, "alias-name.js"));
  await symlink(join(workflowDir, "missing.js"), join(workflowDir, "broken-link.js"));

  const untrusted = await discoverWorkflows(cwd, false);
  assert.deepEqual(untrusted.entries, []);
  const discovered = await discoverWorkflows(cwd, true);
  assert.deepEqual(discovered.entries.map((entry) => entry.name), ["a-first", "alias-name", "z-last"]);
  assert.equal(discovered.entries[1]?.symlink, true);
  assert.match(discovered.diagnostics.map((item) => item.entry).join(" "), /Bad_Name\.js/);
  assert.match(discovered.diagnostics.map((item) => item.entry).join(" "), /broken-link\.js/);
  assert.match(discovered.diagnostics.map((item) => item.entry).join(" "), /not-a-file\.js/);
  assert.equal((globalThis as any).__workflowEvaluated, 0);
});

void test("Jiti freshly loads ESM defaults in a CommonJS project and rejects invalid exports", async () => {
  const { cwd, workflowDir } = await project();
  await writeFile(join(cwd, "package.json"), JSON.stringify({ type: "commonjs" }));
  const path = join(workflowDir, "fresh-state.js");
  await writeFile(join(workflowDir, "helper.cjs"), `module.exports = "!"\n`);
  await writeFile(path, `import helper from "./helper.cjs"; import { basename } from "node:path"; let count = 0; export default () => basename("/x") + helper + String(++count)\n`);
  const loader = new JitiWorkflowLoader();
  const entry: WorkflowEntry = { name: "fresh-state", path, symlink: false };
  assert.equal(await (await loader.load(entry)).workflow({} as any, []), "x!1");
  assert.equal(await (await loader.load(entry)).workflow({} as any, []), "x!1");
  await writeFile(path, "export default 42\n");
  await assert.rejects(loader.load(entry), (error: unknown) => error instanceof SubagentError && error.code === "workflow-invalid-export");
});

void test("loading rejects a source race and retains the pre-load digest", async () => {
  const entry: WorkflowEntry = { name: "moving-source", path: "/virtual/moving-source.js", symlink: false };
  let reads = 0;
  const loader = new JitiWorkflowLoader({
    readSource: async () => Buffer.from(++reads === 1 ? "export default () => 'before'" : "export default () => 'after'"),
    importModule: async () => () => "before",
  });
  await assert.rejects(loader.load(entry), (error: unknown) =>
    error instanceof SubagentError &&
    error.code === "workflow-source-changed" &&
    /^[a-f0-9]{64}$/.test((error as SubagentError & { sourceDigest?: string }).sourceDigest ?? "")
  );
});

void test("module evaluation failure is typed and retains the source digest", async () => {
  const entry: WorkflowEntry = { name: "broken-source", path: "/virtual/broken-source.js", symlink: false };
  const loader = new JitiWorkflowLoader({
    readSource: async () => Buffer.from("throw new Error('broken')"),
    importModule: async () => { throw new Error("broken"); },
  });
  await assert.rejects(loader.load(entry), (error: unknown) =>
    error instanceof SubagentError &&
    error.code === "workflow-failed" &&
    /^[a-f0-9]{64}$/.test((error as SubagentError & { sourceDigest?: string }).sourceDigest ?? "")
  );
});

void test("invocation freezes positional arguments and exposes only lazy Handles", async () => {
  const { cwd, workflowDir } = await project();
  await writeFile(join(workflowDir, "compose-work.js"), `
    export default async (runtime, args) => {
      if (!Object.isFrozen(args)) throw new Error("args mutable");
      if (Object.keys(runtime).join() !== "createHandle") throw new Error("runtime too wide");
      const handle = runtime.createHandle({ label: "reviewer", model: "test/model" }).skill("research").skill("research").skill("review");
      const first = await handle.execute(args[0]);
      const second = await handle.execute(args[1]);
      return first + " / " + second;
    };
  `);
  const backend = new RecordingBackend();
  const invoker = new WorkflowInvoker({ cwd, trusted: () => true, backend });
  assert.equal(backend.opens.length, 0);
  const result = await invoker.invoke("compose-work", ["one", "two"]);
  assert.equal(result.text, "answer:one / answer:one|two");
  assert.deepEqual(backend.opens.map(({ label, model, skills }) => ({ label, model, skills })), [
    { label: "reviewer", model: "test/model", skills: ["research", "review"] },
  ]);
  assert.deepEqual(backend.opens[0]?.child.tasks, ["one", "two"]);
  assert.equal(backend.opens[0]?.child.closed, 1);
});

void test("ordinary promises run distinct Handles concurrently while one Handle rejects overlap", async () => {
  const { cwd, workflowDir } = await project();
  await writeFile(join(workflowDir, "parallel-work.js"), `
    export default async (runtime) => {
      const one = runtime.createHandle({ label: "one" });
      const two = runtime.createHandle({ label: "two" });
      const duplicate = one.execute("first");
      let code = "";
      try { await one.execute("overlap"); } catch (error) { code = error.code; }
      const results = await Promise.all([duplicate, two.execute("other")]);
      return code + ":" + results.join(",");
    };
  `);
  const backend = new RecordingBackend();
  const result = await new WorkflowInvoker({ cwd, trusted: () => true, backend }).invoke("parallel-work", []);
  assert.match(result.text, /^workflow-handle-busy:/);
  assert.equal(backend.opens.length, 2);
});

void test("cancellation revokes the runtime and closes active work without accepting later return values", async () => {
  const { cwd, workflowDir } = await project();
  await writeFile(join(workflowDir, "cancel-work.js"), `export default async (runtime) => { await runtime.createHandle({ label: "slow" }).execute("wait"); return "too late"; }`);
  let closed = 0;
  const backend: WorkflowChildBackend = {
    async open() {
      return {
        execute: async () => new Promise<string>(() => undefined),
        close: async () => { closed += 1; },
      };
    },
  };
  const controller = new AbortController();
  const invocation = new WorkflowInvoker({ cwd, trusted: () => true, backend }).invoke("cancel-work", [], controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(invocation, (error: unknown) => error instanceof SubagentError && error.code === "workflow-cancelled");
  assert.equal(closed, 1);
});

void test("cancellation during module loading waits for loader settlement", async () => {
  let resolveLoad!: (value: any) => void;
  let loadingStarted!: () => void;
  const started = new Promise<void>((resolve) => { loadingStarted = resolve; });
  const loader = {
    load: async () => {
      loadingStarted();
      return new Promise<any>((resolve) => { resolveLoad = resolve; });
    },
  };
  const invoker = new WorkflowInvoker({
    cwd: "/virtual",
    trusted: () => true,
    backend: new RecordingBackend(),
    loader,
    discover: async () => ({ entries: [{ name: "loading", path: "/virtual/loading.js", symlink: false }], diagnostics: [] }),
  });
  const controller = new AbortController();
  const invocation = invoker.invoke("loading", [], controller.signal);
  await started;
  controller.abort();
  let settled = false;
  void invocation.finally(() => { settled = true; }).catch(() => undefined);
  await Promise.resolve();
  assert.equal(settled, false);
  resolveLoad({ workflow: () => "ignored", digest: "digest", sourcePath: "/virtual/loading.js" });
  await assert.rejects(invocation, (error: unknown) => error instanceof SubagentError && error.code === "workflow-cancelled");
});

void test("parent shutdown waits for Handle cleanup and reports parent closure", async () => {
  const { cwd, workflowDir } = await project();
  await writeFile(join(workflowDir, "shutdown-work.js"), `export default async (runtime) => runtime.createHandle({ label: "slow" }).execute("wait")`);
  let closed = 0;
  const backend: WorkflowChildBackend = {
    async open() {
      return {
        execute: async () => new Promise<string>(() => undefined),
        close: async () => { closed += 1; },
      };
    },
  };
  const invoker = new WorkflowInvoker({ cwd, trusted: () => true, backend });
  const invocation = invoker.invoke("shutdown-work", []);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const firstShutdown = invoker.shutdown();
  const secondShutdown = invoker.shutdown();
  assert.equal(firstShutdown, secondShutdown);
  await firstShutdown;
  await assert.rejects(invocation, (error: unknown) => error instanceof SubagentError && error.code === "parent-closed");
  assert.equal(closed, 1);
});

void test("uncaught workflow errors preserve ordinary JavaScript rejection values", async () => {
  const { cwd, workflowDir } = await project();
  await writeFile(join(workflowDir, "ordinary-rejection.js"), `export default () => { const error = new Error("sentinel"); error.marker = 42; throw error; }`);
  await assert.rejects(
    new WorkflowInvoker({ cwd, trusted: () => true, backend: new RecordingBackend() }).invoke("ordinary-rejection", []),
    (error: unknown) => error instanceof Error && error.message === "sentinel" && (error as Error & { marker?: number }).marker === 42 && !(error instanceof SubagentError),
  );
});

void test("an uncaught sibling failure closes all parallel Handles before rejection", async () => {
  const { cwd, workflowDir } = await project();
  await writeFile(join(workflowDir, "sibling-failure.js"), `
    export default async (runtime) => {
      const failing = runtime.createHandle({ label: "failing" });
      const sibling = runtime.createHandle({ label: "sibling" });
      await Promise.all([failing.execute("fail"), sibling.execute("wait")]);
      return "unreachable";
    };
  `);
  const closed: string[] = [];
  const backend: WorkflowChildBackend = {
    async open(config) {
      return {
        execute: async () => config.label === "failing"
          ? Promise.reject(new Error("boom"))
          : new Promise<string>(() => undefined),
        close: async () => { closed.push(config.label); },
      };
    },
  };
  await assert.rejects(new WorkflowInvoker({ cwd, trusted: () => true, backend }).invoke("sibling-failure", []), /boom/);
  assert.deepEqual(closed.sort(), ["failing", "sibling"]);
});

void test("result validation and cancellation close every owned Handle", async () => {
  const { cwd, workflowDir } = await project();
  await writeFile(join(workflowDir, "bad-result.js"), `export default async (runtime) => { const h = runtime.createHandle({ label: "owned" }); await h.execute("x"); return "   "; }`);
  const backend = new RecordingBackend();
  const invoker = new WorkflowInvoker({ cwd, trusted: () => true, backend });
  await assert.rejects(invoker.invoke("bad-result", []), (error: unknown) => error instanceof SubagentError && error.code === "workflow-invalid-result");
  assert.equal(backend.opens[0]?.child.closed, 1);

  await writeFile(join(workflowDir, "oversized.js"), `export default () => "x".repeat(65537)`);
  await assert.rejects(invoker.invoke("oversized", []), (error: unknown) => error instanceof SubagentError && error.code === "workflow-output-overflow");
});

void test("cleanup failure invalidates provisional workflow success", async () => {
  const { cwd, workflowDir } = await project();
  await writeFile(join(workflowDir, "cleanup-failure.js"), `export default async (runtime) => { await runtime.createHandle({ label: "owned" }).execute("x"); return "provisional"; }`);
  const backend: WorkflowChildBackend = {
    async open() {
      return {
        execute: async () => "child result",
        close: async () => { throw new Error("dispose failed"); },
      };
    },
  };
  await assert.rejects(
    new WorkflowInvoker({ cwd, trusted: () => true, backend }).invoke("cleanup-failure", []),
    /Workflow Handle cleanup failed/,
  );
});

void test("forced skills preserve call order and base directories and reject missing or ambiguous names", () => {
  const resources = {
    skills: [
      { name: "one", filePath: "/skills/one/SKILL.md", baseDir: "/skills/one" },
      { name: "two", filePath: "/skills/two/SKILL.md", baseDir: "/skills/two" },
    ],
    diagnostics: [],
  };
  const prompt = forcedSkillsPrompt(["two", "one"], resources, (path) => `content:${path}`) ?? "";
  assert.ok(prompt.indexOf('name="two"') < prompt.indexOf('name="one"'));
  assert.match(prompt, /base_dir="\/skills\/two"/);
  assert.throws(() => forcedSkillsPrompt(["missing"], resources), (error: unknown) => error instanceof SubagentError && error.code === "skill-missing");
  assert.throws(() => forcedSkillsPrompt(["one"], {
    ...resources,
    diagnostics: [{ type: "collision", collision: { resourceType: "skill", name: "one" } }],
  }), (error: unknown) => error instanceof SubagentError && error.code === "skill-ambiguous");
});

void test("the production backend preserves one Child conversation and forwards exact skills", async () => {
  const starts: string[] = [];
  let disposed = 0;
  let created = 0;
  let resolved: unknown;
  const registry = new ChildRegistry({
    delivery: { inject() {} },
    schedule: () => undefined,
    factory: {
      async create(request) {
        created += 1;
        assert.deepEqual(request.forcedSkills, ["one", "two"]);
        return {
          async start(task) { starts.push(task); return { status: "succeeded", text: starts.join("|") }; },
          async steer() {},
          async followUp() {},
          async abort() {},
          dispose() { disposed += 1; },
        };
      },
    },
  });
  const backend = new PiWorkflowBackend({
    registry,
    resolve: async (config) => {
      resolved = config;
      return { task: "workflow", cwd: "/tmp", model: "test/model", thinkingLevel: "off", tools: [] };
    },
  });
  const child = await backend.open({ label: "worker", model: "test/model", skills: ["one", "two"], signal: new AbortController().signal });
  assert.equal(created, 0);
  assert.equal(await child.execute("first"), "first");
  assert.equal(created, 1);
  assert.equal(await child.execute("second"), "first|second");
  const executions = registry.list();
  assert.equal(executions.length, 2);
  assert.equal(executions[0]?.childId, executions[1]?.childId);
  assert.deepEqual(executions.map((execution) => execution.delivery.state), ["consumed", "consumed"]);
  assert.equal(executions[0]?.childState, "idle");
  assert.equal(executions[0]?.retained, true);
  assert.equal(executions[1]?.childState, "idle");
  assert.equal(executions[0]?.handleId, executions[1]?.handleId);
  assert.equal(executions[1]?.handleState, "idle");
  await child.close();
  assert.deepEqual(resolved, { label: "worker", model: "test/model", skills: ["one", "two"] });
  assert.equal(disposed, 1);
});

void test("missing Child text is retained as a typed failed Execution", async () => {
  const registry = new ChildRegistry({
    delivery: { inject() {} },
    schedule: () => undefined,
    factory: {
      async create() {
        return {
          async start() { return { status: "succeeded", text: "   " } as const; },
          async steer() {}, async followUp() {}, async abort() {}, dispose() {},
        };
      },
    },
  });
  const backend = new PiWorkflowBackend({
    registry,
    resolve: async () => ({ task: "blank", cwd: "/tmp", model: "test/model", thinkingLevel: "off", tools: [] }),
  });
  const child = await backend.open({ label: "blank", skills: [], signal: new AbortController().signal });
  await assert.rejects(child.execute("blank"), (error: unknown) => error instanceof SubagentError && error.code === "child-missing-text");
  const execution = registry.list()[0];
  assert.equal(execution?.executionState, "failed");
  assert.equal(execution?.completion?.error?.code, "child-missing-text");
  await child.close();
});

void test("production workflow admission constructs four Children and queues the fifth FIFO", async () => {
  const completions: Array<(value: { status: "succeeded"; text: string }) => void> = [];
  const constructed: string[] = [];
  const registry = new ChildRegistry({
    delivery: { inject() {} },
    schedule: () => undefined,
    factory: {
      async create(request) {
        constructed.push(request.label ?? "");
        return {
          start: async () => new Promise((resolve) => completions.push(resolve)),
          async steer() {}, async followUp() {}, async abort() {}, dispose() {},
        };
      },
    },
  });
  const backend = new PiWorkflowBackend({
    registry,
    resolve: async (config) => ({ task: config.label, label: config.label, cwd: "/tmp", model: "test/model", thinkingLevel: "off", tools: [] }),
  });
  const children = await Promise.all(Array.from({ length: 5 }, (_, index) => backend.open({
    label: `child-${index}`,
    skills: [],
    signal: new AbortController().signal,
  })));
  const executions = children.map((child, index) => child.execute(`task-${index}`));
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.deepEqual(constructed, ["child-0", "child-1", "child-2", "child-3"]);
  completions[0]?.({ status: "succeeded", text: "done-0" });
  await executions[0];
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(constructed[4], "child-4");
  for (let index = 1; index < completions.length; index += 1) completions[index]?.({ status: "succeeded", text: `done-${index}` });
  await Promise.all(executions.slice(1));
  await Promise.all(children.map((child) => child.close()));
});

void test("generic and workflow Executions share one parent capacity queue", async () => {
  const completions: Array<(value: { status: "succeeded"; text: string }) => void> = [];
  const constructed: string[] = [];
  const registry = new ChildRegistry({
    delivery: { inject() {} },
    schedule: () => undefined,
    factory: {
      async create(request) {
        constructed.push(request.label ?? "");
        return {
          start: async () => new Promise((resolve) => completions.push(resolve)),
          async steer() {}, async followUp() {}, async abort() {}, dispose() {},
        };
      },
    },
  });
  for (let index = 0; index < 4; index += 1) registry.launch({
    task: `generic-${index}`, label: `generic-${index}`, cwd: "/tmp", model: "test/model", thinkingLevel: "off", tools: [],
  });
  const backend = new PiWorkflowBackend({
    registry,
    resolve: async () => ({ task: "workflow", label: "workflow", cwd: "/tmp", model: "test/model", thinkingLevel: "off", tools: [] }),
  });
  const child = await backend.open({ label: "workflow", skills: [], signal: new AbortController().signal });
  const workflowExecution = child.execute("workflow-task");
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.deepEqual(constructed, ["generic-0", "generic-1", "generic-2", "generic-3"]);
  completions[0]?.({ status: "succeeded", text: "generic done" });
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(constructed[4], "workflow");
  completions[4]?.({ status: "succeeded", text: "workflow done" });
  assert.equal(await workflowExecution, "workflow done");
  for (let index = 1; index < 4; index += 1) completions[index]?.({ status: "succeeded", text: "generic done" });
  await child.close();
});

void test("overlapping invocations of one identity do not share evaluated module state", async () => {
  const { cwd, workflowDir } = await project();
  await writeFile(join(workflowDir, "isolated-state.js"), `let count = 0; export default async () => { await Promise.resolve(); return String(++count); }`);
  const invoker = new WorkflowInvoker({ cwd, trusted: () => true, backend: new RecordingBackend() });
  const results = await Promise.all([invoker.invoke("isolated-state", []), invoker.invoke("isolated-state", [])]);
  assert.deepEqual(results.map((result) => result.text), ["1", "1"]);
});
