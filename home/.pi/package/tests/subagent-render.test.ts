import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExecutionSnapshot } from "../extensions/subagent/domain.ts";
import { cardText, fleetLines, renderCard } from "../extensions/subagent/render.ts";

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

void test("compact cards show task, activity, model, thinking, and statistics", () => {
  const text = cardText(snapshot(), false, theme);
  assert.match(text, /reviewer/);
  assert.match(text, /Review the implementation/);
  assert.match(text, /using read/);
  assert.match(text, /openai\/gpt-5 · high/);
  assert.match(text, /2 turns/);
  assert.match(text, /↑1.2k/);
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

void test("card and FleetView render within narrow terminal widths", () => {
  for (const line of renderCard(snapshot(), false, theme).render(32)) assert.ok(visibleWidth(line) <= 32);
  for (const line of fleetLines([snapshot()], 24, theme)) assert.ok(visibleWidth(line) <= 24);
});
