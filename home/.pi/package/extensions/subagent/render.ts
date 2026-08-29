import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExecutionSnapshot } from "./domain.ts";

function tokens(value: number): string {
  return value < 1_000 ? String(value) : value < 1_000_000 ? `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k` : `${(value / 1_000_000).toFixed(1)}m`;
}

const STATE_PRESENTATION: Record<
  ExecutionSnapshot["executionState"],
  { icon: string; color: "success" | "error" | "warning" | "accent" }
> = {
  starting: { icon: "●", color: "accent" },
  running: { icon: "●", color: "accent" },
  succeeded: { icon: "✓", color: "success" },
  failed: { icon: "✗", color: "error" },
  cancelling: { icon: "◐", color: "warning" },
  cancelled: { icon: "■", color: "error" },
};

export function cardText(snapshot: ExecutionSnapshot, expanded: boolean, theme: Theme): string {
  const usage = snapshot.usage;
  const stats = [
    usage.turns ? `${usage.turns} turn${usage.turns === 1 ? "" : "s"}` : "",
    usage.input ? `↑${tokens(usage.input)}` : "",
    usage.output ? `↓${tokens(usage.output)}` : "",
    usage.cost ? `$${usage.cost.toFixed(4)}` : "",
  ].filter(Boolean).join(" ");
  const delivery = snapshot.delivery.state === "pending" ? "" : ` · ${snapshot.delivery.state}`;
  const presentation = STATE_PRESENTATION[snapshot.executionState];
  let text = `${theme.fg(presentation.color, presentation.icon)} ${theme.fg("toolTitle", theme.bold(snapshot.label))}`;
  text += theme.fg("dim", `  ${snapshot.model} · ${snapshot.thinkingLevel}${stats ? ` · ${stats}` : ""}`);
  text += `\n${theme.fg("muted", snapshot.task.length > 140 && !expanded ? `${snapshot.task.slice(0, 137)}…` : snapshot.task)}`;
  text += `\n${theme.fg(presentation.color, snapshot.activity)}${theme.fg("dim", delivery)}`;
  if (expanded) {
    text += `\n${theme.fg("dim", `Child ${snapshot.childId} · Execution ${snapshot.executionId}`)}`;
    for (const event of snapshot.events.slice(-12)) text += `\n${theme.fg("dim", "│ ")}${theme.fg("muted", event.type)}`;
    if (snapshot.completion?.text) text += `\n\n${snapshot.completion.text}`;
    if (snapshot.completion?.error) text += `\n${theme.fg("error", `${snapshot.completion.error.code}: ${snapshot.completion.error.message}`)}`;
    if (snapshot.delivery.diagnostic) text += `\n${theme.fg("warning", `delivery pending: ${snapshot.delivery.diagnostic}`)}`;
    if (snapshot.omitted) text += `\n${theme.fg("warning", `${snapshot.omitted.events} events and ${snapshot.omitted.bytes} bytes omitted`)}`;
  }
  return text;
}

export function renderCard(snapshot: ExecutionSnapshot, expanded: boolean, theme: Theme): Text {
  return new Text(cardText(snapshot, expanded, theme), 0, 0);
}

export function fleetLines(snapshots: readonly ExecutionSnapshot[], width: number, theme: Theme): string[] {
  const active = snapshots.filter((run) => run.executionState === "running" || run.executionState === "starting").length;
  const cancelling = snapshots.filter((run) => run.executionState === "cancelling").length;
  const history = snapshots.length - active - cancelling;
  if (snapshots.length === 0) return [];
  const total = snapshots.reduce((sum, run) => sum + run.usage.input + run.usage.output, 0);
  return [truncateToWidth(
    `${theme.fg("accent", "◆ subagents")} ${theme.fg("muted", `${active} executing · ${cancelling} cancelling · ${history} history · ${tokens(total)} tokens`)}`,
    width,
    theme.fg("dim", "…"),
  )];
}
