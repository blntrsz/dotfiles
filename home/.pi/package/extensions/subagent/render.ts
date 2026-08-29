import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ExecutionSnapshot } from "./domain.ts";

function tokens(value: number): string {
  return value < 1_000
    ? String(value)
    : value < 1_000_000
      ? `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
      : `${(value / 1_000_000).toFixed(1)}m`;
}

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const STATE_PRESENTATION: Record<
  ExecutionSnapshot["executionState"],
  { icon: string; color: "success" | "error" | "warning" | "accent" | "muted"; label: string }
> = {
  starting: { icon: "◦", color: "muted", label: "starting" },
  running: { icon: "●", color: "accent", label: "running" },
  succeeded: { icon: "✓", color: "success", label: "completed" },
  failed: { icon: "✗", color: "error", label: "failed" },
  cancelling: { icon: "■", color: "warning", label: "cancelling" },
  cancelled: { icon: "■", color: "warning", label: "cancelled" },
};

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function preview(value: string, maximum = 96): string {
  const normalized = oneLine(value);
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function toolCount(snapshot: ExecutionSnapshot): number {
  return snapshot.events.filter((event) => event.type === "tool-start").length;
}

function stats(snapshot: ExecutionSnapshot): string {
  const tools = toolCount(snapshot);
  const totalTokens = snapshot.usage.input + snapshot.usage.output;
  return [
    snapshot.usage.turns ? `⟳ ${snapshot.usage.turns}` : "",
    tools ? `${tools} tool use${tools === 1 ? "" : "s"}` : "",
    totalTokens ? `${tokens(totalTokens)} token` : "",
    duration((snapshot.completion?.committedAt ?? Date.now()) - snapshot.createdAt),
  ].filter(Boolean).join(" · ");
}

function modelThinking(snapshot: ExecutionSnapshot): string {
  return `${snapshot.model} ${snapshot.thinkingLevel}`;
}

export function cardText(snapshot: ExecutionSnapshot, expanded: boolean, theme: Theme): string {
  const presentation = STATE_PRESENTATION[snapshot.executionState];
  const header = `${theme.fg(presentation.color, presentation.icon)} ${theme.fg("toolTitle", theme.bold(snapshot.label))} ${theme.fg("dim", `(${modelThinking(snapshot)}) · ${stats(snapshot)}`)}`;
  const lines = [
    header,
    theme.fg("dim", `  task: ${preview(snapshot.task, expanded ? 240 : 96)}`),
    theme.fg("dim", `  ⎿  ${snapshot.activity}`),
  ];

  if (!expanded && (snapshot.executionState === "running" || snapshot.executionState === "starting" || snapshot.executionState === "cancelling")) {
    lines.push(theme.fg("accent", `  Press ${keyText("app.tools.expand")} for live detail · Ctrl+Alt+F Fleet`));
  }

  if (expanded) {
    lines.push("", theme.fg("dim", `Child ${snapshot.childId} · Execution ${snapshot.executionId} · ${presentation.label}`));
    for (const event of snapshot.events.slice(-12)) lines.push(`${theme.fg("borderMuted", "│")} ${theme.fg("muted", event.type)}`);
    if (snapshot.completion?.text) lines.push("", snapshot.completion.text);
    if (snapshot.completion?.error) lines.push(theme.fg("error", `${snapshot.completion.error.code}: ${snapshot.completion.error.message}`));
    if (snapshot.delivery.diagnostic) lines.push(theme.fg("warning", `delivery pending: ${snapshot.delivery.diagnostic}`));
    if (snapshot.omitted) lines.push(theme.fg("warning", `${snapshot.omitted.events} events and ${snapshot.omitted.bytes} bytes omitted`));
  }
  return lines.join("\n");
}

export function renderCard(snapshot: ExecutionSnapshot, expanded: boolean, theme: Theme): Text {
  return new Text(cardText(snapshot, expanded, theme), 0, 0);
}

/** A transcript/tool component that reads the latest projection on every paint. */
export function renderLiveCard(
  snapshot: () => ExecutionSnapshot,
  expanded: boolean,
  theme: Theme,
): Component {
  return {
    render(width: number): string[] {
      return new Text(cardText(snapshot(), expanded, theme), 0, 0).render(width);
    },
    invalidate() {},
  };
}

export function fleetLines(snapshots: readonly ExecutionSnapshot[], width: number, theme: Theme): string[] {
  const active = snapshots.filter((run) => run.executionState === "running" || run.executionState === "starting" || run.executionState === "cancelling");
  if (active.length === 0) return [];
  const total = active.reduce((sum, run) => sum + run.usage.input + run.usage.output, 0);
  const label = `${active.length} active agent${active.length === 1 ? "" : "s"}`;
  return [truncateToWidth(
    `  ${theme.fg("muted", label)} · ${theme.fg("dim", `↓ ${tokens(total)} tokens · ↓/← to inspect`)}`,
    width,
    theme.fg("dim", "…"),
  )];
}

export function fleetRosterLines(
  snapshots: readonly ExecutionSnapshot[],
  selected: number,
  width: number,
  theme: Theme,
): string[] {
  const lines = [theme.fg("dim", "  ↑↓/jk select · enter inspect · esc back"), "", `${selected === 0 ? theme.fg("accent", ">") : " "} main`];
  snapshots.forEach((snapshot, index) => {
    const presentation = STATE_PRESENTATION[snapshot.executionState];
    const marker = selected === index + 1 ? theme.fg("accent", ">") : " ";
    const elapsed = duration((snapshot.completion?.committedAt ?? Date.now()) - snapshot.createdAt);
    const total = snapshot.usage.input + snapshot.usage.output;
    const left = `${marker} ${theme.fg(presentation.color, presentation.icon)} ${theme.fg("muted", snapshot.label)}  ${preview(snapshot.task, 72)}`;
    const right = theme.fg("dim", `${elapsed} · ↓ ${tokens(total)} tokens`);
    const gap = Math.max(1, width - left.replace(/\x1b\[[0-9;]*m/g, "").length - right.replace(/\x1b\[[0-9;]*m/g, "").length);
    lines.push(truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width));
  });
  return lines;
}
