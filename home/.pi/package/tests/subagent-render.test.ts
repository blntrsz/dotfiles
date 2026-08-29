import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExecutionSnapshot } from "../extensions/subagent/domain.ts";
import { executionControls, FleetInspector, SubagentFleetUi } from "../extensions/subagent/fleet-ui.ts";
import { cardText, fleetLines, fleetRosterLines, renderCard, renderLiveCard } from "../extensions/subagent/render.ts";
import { RunStore } from "../extensions/subagent/run-store.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function snapshot(overrides: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot {
  return {
    childId: "ch_1",
    executionId: "ex_1",
    label: "reviewer",
    task: "Review the implementation",
    context: "fresh",
    model: "openai/gpt-5",
    thinkingLevel: "high",
    childState: "executing",
    executionState: "running",
    delivery: { state: "pending" },
    activity: "using read",
    events: [],
    usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 2 },
    createdAt: 1,
    ...overrides,
  };
}

void test("RunStore lookups reuse published projections instead of rebuilding snapshots per paint", () => {
  const projected = snapshot();
  let inspections = 0;
  const registry = {
    inspect: () => { inspections += 1; return projected; },
    list: () => [projected],
    subscribe: () => () => undefined,
  };
  const store = new RunStore(registry as never);
  for (let paint = 0; paint < 100; paint += 1) store.lookup(projected.executionId);
  assert.equal(inspections, 0);
  assert.throws(() => store.lookup("unknown"), /Unknown execution projection/);
  assert.equal(inspections, 0);
});

void test("compact cards match the pi-subagents live-card hierarchy", () => {
  const text = cardText(snapshot(), false, theme);
  const lines = text.split("\n");
  assert.match(lines[0] ?? "", /^● reviewer \(openai\/gpt-5 high\) · ⟳ 2 · 1\.5k token/);
  assert.equal(lines[1], "  task: Review the implementation");
  assert.equal(lines[2], "  ⎿  using read");
  assert.equal(lines[3], "  Press Ctrl+O for Fleet");
});

void test("expanded cards expose identities, delivery, and terminal diagnostics", () => {
  const text = cardText(snapshot({
    childState: "closed",
    executionState: "failed",
    delivery: { state: "pending", diagnostic: "queue unavailable" },
    completion: {
      sequence: 1, childId: "ch_1", executionId: "ex_1", status: "failed",
      error: { code: "child-execution-failed", message: "provider failed" }, committedAt: 2,
    },
  }), true, theme);
  assert.match(text, /Child ch_1 · Execution ex_1/);
  assert.match(text, /child-execution-failed: provider failed/);
  assert.match(text, /delivery pending: queue unavailable/);
});

void test("collapsed FleetView matches the pi-subagents inspect affordance", () => {
  const lines = fleetLines([snapshot()], 120, theme);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /1 active agent/);
  assert.match(lines[0] ?? "", /↓ 1\.5k tokens/);
  assert.match(lines[0] ?? "", /↓\/← to inspect/);
});

void test("FleetView groups parent, live and idle Children before dim process history", () => {
  const running = snapshot();
  const idle = snapshot({
    childId: "ch_2", executionId: "ex_2", label: "reusable", childState: "idle", executionState: "succeeded", delivery: { state: "consumed" },
    completion: { sequence: 1, childId: "ch_2", executionId: "ex_2", status: "succeeded", text: "done", committedAt: 2 },
  });
  const historical = snapshot({
    childId: "ch_3", executionId: "ex_3", label: "one-shot", childState: "closed", executionState: "failed",
    delivery: { state: "pending", diagnostic: "queue unavailable" },
    completion: { sequence: 2, childId: "ch_3", executionId: "ex_3", status: "failed", error: { code: "child-execution-failed", message: "nope" }, committedAt: 3 },
  });
  const lines = fleetRosterLines([historical, idle, running], 1, 120, theme);
  assert.match(lines.join("\n"), /main[\s\S]*reviewer[\s\S]*reusable[\s\S]*Process history[\s\S]*one-shot/);
  assert.match(fleetLines([historical, idle, running], 120, theme)[0] ?? "", /1 executing.*1 idle.*1 history.*1 delivery pending/);
});

void test("inspector controls are enabled only for valid stable Execution states", () => {
  assert.deepEqual(executionControls(snapshot()), { steer: true, wait: true, cancel: true });
  assert.deepEqual(executionControls(snapshot({ executionState: "cancelling" })), { steer: false, wait: true, cancel: false });
  assert.deepEqual(executionControls(snapshot({ childState: "closed", executionState: "succeeded" })), { steer: false, wait: true, cancel: false });
});

void test("live transcript cards cache unchanged paints", () => {
  let themed = 0;
  const countingTheme = {
    fg: (_color: string, text: string) => { themed += 1; return text; },
    bold: (text: string) => text,
  } as unknown as Theme;
  const projected = snapshot();
  const card = renderLiveCard(() => projected, false, countingTheme);
  card.render(100);
  const afterFirstPaint = themed;
  card.render(100);
  assert.equal(themed, afterFirstPaint);
});

void test("live transcript cards repaint from the latest RunStore projection", () => {
  let current = snapshot();
  const card = renderLiveCard(() => current, false, theme);
  assert.ok(card.render(100).some((line) => line.includes("running") || line.includes("using read")));
  current = snapshot({
    childState: "closed",
    executionState: "succeeded",
    activity: "completed",
    completion: { sequence: 1, childId: "ch_1", executionId: "ex_1", status: "succeeded", text: "done", committedAt: 2 },
  });
  const refreshed = card.render(100).join("\n");
  assert.match(refreshed, /✓ reviewer/);
  assert.match(refreshed, /completed/);
  assert.doesNotMatch(refreshed, /using read/);
});

void test("Fleet inspector uses the reference two-pane live layout", () => {
  const store = {
    list: () => [snapshot()],
    subscribe(listener: (runs: readonly ExecutionSnapshot[]) => void) {
      listener([snapshot()]);
      return () => undefined;
    },
  } as unknown as RunStore;
  const inspector = new FleetInspector({ requestRender() {} } as never, theme, store, () => undefined);
  const lines = inspector.render(100);
  assert.match(lines[1] ?? "", /Subagent fleet inspector/);
  assert.ok(lines.some((line) => line.includes("Conversation")));
  assert.ok(lines.some((line) => line.includes("reviewer · running")));
  assert.match(lines.at(-2) ?? "", /agent.*scroll.*refresh.*close/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 100));
  inspector.dispose();
});

void test("inspector actions capture the selected stable Execution identity", async () => {
  const calls: string[] = [];
  const store = {
    list: () => [snapshot()],
    subscribe(listener: (runs: readonly ExecutionSnapshot[]) => void) {
      listener([snapshot()]);
      return () => undefined;
    },
  } as unknown as RunStore;
  const inspector = new FleetInspector(
    { requestRender() {} } as never,
    theme,
    store,
    () => undefined,
    "ex_1",
    {
      async steer(id) { calls.push(`steer:${id}`); },
      async wait(id) { calls.push(`wait:${id}`); },
      async cancel(id) { calls.push(`cancel:${id}`); },
    },
  );
  inspector.handleInput("s");
  inspector.handleInput("w");
  inspector.handleInput("c");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["steer:ex_1", "wait:ex_1", "cancel:ex_1"]);
  inspector.dispose();
});

void test("Fleet roster activates from the empty editor and opens the selected inspector", async () => {
  let widget: ((tui: never, theme: Theme) => { render(width: number): string[] }) | undefined;
  let inspectorOpened = 0;
  let fleetStatus: string | undefined;
  const ctx = {
    ui: {
      onTerminalInput: () => () => undefined,
      setWidget: (_key: string, content: typeof widget) => { widget = content; },
      getEditorText: () => "",
      setStatus: (_key: string, status: string | undefined) => { fleetStatus = status; },
      custom: async (factory: (tui: never, theme: Theme, keys: never, done: (value: undefined) => void) => { dispose?(): void }) => {
        inspectorOpened += 1;
        let done!: (value: undefined) => void;
        const completion = new Promise<undefined>((resolve) => { done = resolve; });
        const component = factory({ requestRender() {} } as never, theme, {} as never, done);
        done(undefined);
        await completion;
        component.dispose?.();
      },
    },
  } as unknown as ExtensionContext;
  const store = {
    list: () => [snapshot()],
    subscribe(listener: (runs: readonly ExecutionSnapshot[]) => void) {
      listener([snapshot()]);
      return () => undefined;
    },
  } as unknown as RunStore;
  const fleet = new SubagentFleetUi(ctx, store);
  assert.equal(fleetStatus, "subagents: 1 running");
  assert.equal(fleet.handleInput("\x0f")?.consume, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(inspectorOpened, 1);
  assert.equal(fleet.handleInput("\x1b[B")?.consume, true);
  const activeLines = widget?.({ requestRender() {} } as never, theme).render(100) ?? [];
  assert.ok(activeLines.some((line) => line.includes("select · enter inspect")));
  assert.equal(fleet.handleInput("\x1b[B")?.consume, true);
  assert.equal(fleet.handleInput("\r")?.consume, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(inspectorOpened, 2);
  fleet.dispose();
  assert.equal(fleetStatus, undefined);
});

void test("card, FleetView, and inspector preserve line widths in narrow and wide terminals", () => {
  for (const line of renderCard(snapshot(), false, theme).render(32)) assert.ok(visibleWidth(line) <= 32);
  for (const line of fleetLines([snapshot()], 24, theme)) assert.ok(visibleWidth(line) <= 24);
  const store = {
    list: () => [snapshot({ task: "x".repeat(500) })],
    subscribe: () => () => undefined,
  } as unknown as RunStore;
  const inspector = new FleetInspector({ requestRender() {} } as never, theme, store, () => undefined);
  for (const width of [32, 140]) {
    assert.ok(inspector.render(width).every((line) => visibleWidth(line) <= width));
  }
  inspector.dispose();
});
