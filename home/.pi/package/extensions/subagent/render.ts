import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
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
    lines.push(theme.fg("accent", "  Press Ctrl+O for Fleet"));
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
  let cachedSnapshot: ExecutionSnapshot | undefined;
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;
  return {
    render(width: number): string[] {
      const current = snapshot();
      if (cachedLines && cachedSnapshot === current && cachedWidth === width) return cachedLines;
      cachedSnapshot = current;
      cachedWidth = width;
      cachedLines = new Text(cardText(current, expanded, theme), 0, 0).render(width);
      return cachedLines;
    },
    invalidate() {
      cachedSnapshot = undefined;
      cachedWidth = undefined;
      cachedLines = undefined;
    },
  };
}

export function fleetLines(snapshots: readonly ExecutionSnapshot[], width: number, theme: Theme): string[] {
  if (snapshots.length === 0) return [];
  const executing = snapshots.filter((run) => run.executionState === "running" || run.executionState === "starting").length;
  const cancelling = snapshots.filter((run) => run.executionState === "cancelling").length;
  const idle = snapshots.filter((run) => run.childState === "idle").length;
  const history = snapshots.filter((run) => run.childState === "closed" && isTerminalExecution(run)).length;
  const pendingDelivery = snapshots.filter((run) => run.delivery.state === "pending" && run.completion).length;
  const total = snapshots.reduce((sum, run) => sum + run.usage.input + run.usage.output, 0);
  const active = executing + cancelling;
  const summary = [
    `${active} active agent${active === 1 ? "" : "s"}`,
    executing ? `${executing} executing` : "",
    cancelling ? `${cancelling} cancelling` : "",
    idle ? `${idle} idle` : "",
    history ? `${history} history` : "",
    pendingDelivery ? `${pendingDelivery} delivery pending` : "",
  ].filter(Boolean).join(" · ");
  return [truncateToWidth(
    `  ${theme.fg("muted", summary)} · ${theme.fg("dim", `↓ ${tokens(total)} tokens · ↓/← to inspect`)}`,
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
  const indexed = orderedFleetSnapshots(snapshots).map((snapshot, index) => ({ snapshot, index }));
  const live = indexed.filter(({ snapshot }) => snapshot.childState !== "closed");
  const history = indexed.filter(({ snapshot }) => snapshot.childState === "closed" && isTerminalExecution(snapshot));
  const lines = [theme.fg("dim", "  ↑↓/jk select · enter inspect · esc back"), "", `${selected === 0 ? theme.fg("accent", ">") : " "} main`];
  const append = ({ snapshot, index }: (typeof indexed)[number], dim = false) => {
    const presentation = STATE_PRESENTATION[snapshot.executionState];
    const marker = selected === index + 1 ? theme.fg("accent", ">") : " ";
    const elapsed = duration((snapshot.completion?.committedAt ?? Date.now()) - snapshot.createdAt);
    const total = snapshot.usage.input + snapshot.usage.output;
    const label = `${marker} ${theme.fg(presentation.color, presentation.icon)} ${snapshot.label}  ${preview(snapshot.task, 72)}`;
    const left = dim ? theme.fg("dim", label) : theme.fg("muted", label);
    const right = theme.fg("dim", `${elapsed} · ↓ ${tokens(total)} tokens · ${snapshot.delivery.state}`);
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    lines.push(truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width));
  };
  live.forEach((entry) => append(entry));
  if (history.length > 0) {
    lines.push("", theme.fg("dim", "  Process history"));
    history.forEach((entry) => append(entry, true));
  }
  return lines;
}

export function isTerminalExecution(snapshot: ExecutionSnapshot): boolean {
  return snapshot.executionState === "succeeded" || snapshot.executionState === "failed" || snapshot.executionState === "cancelled";
}

export function orderedFleetSnapshots(snapshots: readonly ExecutionSnapshot[]): readonly ExecutionSnapshot[] {
  return Object.freeze([...snapshots].sort((a, b) => {
    const rank = (snapshot: ExecutionSnapshot) => snapshot.childState === "closed" ? 2 : snapshot.childState === "idle" ? 1 : 0;
    return rank(a) - rank(b) || a.createdAt - b.createdAt;
  }));
}
