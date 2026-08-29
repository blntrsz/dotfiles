import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ExecutionSnapshot } from "./domain.ts";
import { fleetLines, fleetRosterLines } from "./render.ts";
import { RunStore } from "./run-store.ts";

const WIDGET_KEY = "subagent-fleet";

function fit(value: string, width: number): string {
  const clipped = truncateToWidth(value, Math.max(0, width));
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function terminalState(snapshot: ExecutionSnapshot): boolean {
  return snapshot.executionState === "succeeded" || snapshot.executionState === "failed" || snapshot.executionState === "cancelled";
}

function eventLabel(event: ExecutionSnapshot["events"][number]): string {
  if (typeof event.data === "string") return event.data;
  if (event.data && typeof event.data === "object") {
    const data = event.data as { name?: unknown; args?: unknown };
    if (typeof data.name === "string") {
      const args = data.args && typeof data.args === "object" ? data.args as Record<string, unknown> : undefined;
      const detail = args?.path ?? args?.file_path ?? args?.command ?? args?.query;
      return typeof detail === "string" ? `${data.name} ${detail}` : data.name;
    }
  }
  return event.type;
}

export class FleetInspector implements Component {
  private snapshots: readonly ExecutionSnapshot[];
  private selected: number;
  private scroll = 0;
  private unsubscribe: () => void;

  constructor(
    private readonly tui: Pick<TUI, "requestRender">,
    private readonly theme: Theme,
    private readonly store: RunStore,
    private readonly done: (result: undefined) => void,
    initialExecutionId?: string,
  ) {
    this.snapshots = store.list();
    this.selected = Math.max(0, initialExecutionId ? this.snapshots.findIndex((run) => run.executionId === initialExecutionId) : 0);
    this.unsubscribe = store.subscribe((snapshots) => {
      const selectedId = this.snapshots[this.selected]?.executionId;
      this.snapshots = snapshots;
      const preserved = selectedId ? snapshots.findIndex((run) => run.executionId === selectedId) : -1;
      this.selected = preserved >= 0 ? preserved : Math.min(this.selected, Math.max(0, snapshots.length - 1));
      this.tui.requestRender();
    });
  }

  dispose(): void {
    this.unsubscribe();
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") return this.done(undefined);
    if (matchesKey(data, "down") || data === "j") {
      this.selected = Math.min(this.snapshots.length - 1, this.selected + 1);
      this.scroll = 0;
      return this.tui.requestRender();
    }
    if (matchesKey(data, "up") || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
      this.scroll = 0;
      return this.tui.requestRender();
    }
    if (data === "J" || matchesKey(data, "pageDown")) {
      this.scroll += data === "J" ? 1 : 8;
      return this.tui.requestRender();
    }
    if (data === "K" || matchesKey(data, "pageUp")) {
      this.scroll = Math.max(0, this.scroll - (data === "K" ? 1 : 8));
      return this.tui.requestRender();
    }
    if (data === "r") this.tui.requestRender();
  }

  render(width: number): string[] {
    const height = Math.max(12, Math.min(30, ((this.tui as TUI).terminal?.rows ?? 28) - 4));
    const innerWidth = Math.max(20, width - 2);
    const leftWidth = Math.max(22, Math.min(42, Math.floor(innerWidth * 0.36)));
    const rightWidth = Math.max(20, innerWidth - leftWidth - 1);
    const selected = this.snapshots[this.selected];
    const titleState = selected ? `${selected.label} · ${selected.executionState}` : "no executions";
    const top = `┌${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}┐`;
    const title = truncateToWidth(` Subagent fleet inspector · inspection only · live`, leftWidth);
    const selectedTitle = truncateToWidth(` ${titleState}`, rightWidth);
    const lines = [
      top,
      `│${fit(this.theme.bold(title), leftWidth)}│${fit(this.theme.fg("accent", selectedTitle), rightWidth)}│`,
      `├${"─".repeat(leftWidth)}┼${"─".repeat(rightWidth)}┤`,
    ];

    const roster = this.roster(leftWidth);
    const detail = this.detail(selected, rightWidth);
    const bodyHeight = height - 5;
    const maxScroll = Math.max(0, detail.length - bodyHeight);
    this.scroll = Math.min(this.scroll, maxScroll);
    const visibleDetail = detail.slice(this.scroll, this.scroll + bodyHeight);
    for (let row = 0; row < bodyHeight; row += 1) {
      lines.push(`│${fit(roster[row] ?? "", leftWidth)}│${fit(visibleDetail[row] ?? "", rightWidth)}│`);
    }
    lines.push(`├${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┤`);
    lines.push(`│${fit(this.theme.fg("dim", " ↑/k ↓/j agent · ⇧K/⇧J scroll · PgUp/PgDn page · r refresh · Esc close"), innerWidth)}│`);
    lines.push(`└${"─".repeat(innerWidth)}┘`);
    return lines.map((line) => truncateToWidth(line, width));
  }

  private roster(width: number): string[] {
    if (this.snapshots.length === 0) return [this.theme.fg("dim", " No current-session Children")];
    return this.snapshots.map((snapshot, index) => {
      const marker = index === this.selected ? this.theme.fg("accent", ">") : " ";
      const glyph = snapshot.executionState === "running" ? this.theme.fg("accent", "●") : terminalState(snapshot) ? this.theme.fg(snapshot.executionState === "succeeded" ? "success" : "error", snapshot.executionState === "succeeded" ? "✓" : "✗") : this.theme.fg("muted", "◦");
      return truncateToWidth(`${marker} ${glyph} ${this.theme.bold(snapshot.label)} · ${snapshot.executionState}`, width);
    });
  }

  private detail(snapshot: ExecutionSnapshot | undefined, width: number): string[] {
    if (!snapshot) return [this.theme.fg("dim", " No current-session Fleet jobs."), "", " New Children appear here automatically."];
    const usage = snapshot.usage;
    const lines = [
      ` ${this.theme.bold(snapshot.label)} ${this.theme.fg("dim", `· ${snapshot.executionState}`)}`,
      ` ${this.theme.fg("dim", `${snapshot.context} · ${snapshot.model} · ${snapshot.thinkingLevel}`)}`,
      ` ${this.theme.fg("dim", `${usage.input + usage.output} tok · ${usage.turns} turns · ${snapshot.events.filter((event) => event.type === "tool-start").length} tools`)}`,
      ` ${this.theme.fg("dim", `Child ${snapshot.childId} · Execution ${snapshot.executionId}`)}`,
      ` ${this.theme.fg("muted", `Task  ${snapshot.task}`)}`,
      "",
      ` ${this.theme.fg("accent", "Conversation")}`,
    ];
    for (const event of snapshot.events) {
      const glyph = event.type === "tool-end" ? this.theme.fg("success", "✓") : event.type === "tool-start" ? this.theme.fg("accent", "├─") : this.theme.fg("borderMuted", "│");
      lines.push(` ${glyph} ${eventLabel(event)}`);
    }
    if (snapshot.completion?.text) lines.push("", ...snapshot.completion.text.split("\n").map((line) => ` ${line}`));
    if (snapshot.completion?.error) lines.push("", ` ${this.theme.fg("error", `${snapshot.completion.error.code}: ${snapshot.completion.error.message}`)}`);
    return lines.flatMap((line) => {
      if (visibleWidth(line) <= width) return [line];
      const chunks: string[] = [];
      let rest = line;
      while (visibleWidth(rest) > width) {
        chunks.push(truncateToWidth(rest, width));
        rest = rest.slice(Math.max(1, width - 2));
      }
      if (rest) chunks.push(rest);
      return chunks;
    });
  }
}

export class SubagentFleetUi {
  private snapshots: readonly ExecutionSnapshot[] = [];
  private active = false;
  private selected = 0;
  private inspectorOpen = false;
  private unsubscribeStore: () => void;
  private unsubscribeInput: () => void;
  private tui: Pick<TUI, "requestRender"> | undefined;
  private timer: ReturnType<typeof setInterval>;

  constructor(private readonly ctx: ExtensionContext, private readonly store: RunStore) {
    this.unsubscribeStore = store.subscribe((snapshots) => {
      this.snapshots = snapshots;
      this.selected = Math.min(this.selected, snapshots.length);
      this.refresh();
    });
    this.unsubscribeInput = ctx.ui.onTerminalInput((data) => this.handleInput(data));
    this.timer = setInterval(() => {
      if (this.snapshots.some((snapshot) => !terminalState(snapshot))) this.tui?.requestRender();
    }, 500);
    this.timer.unref?.();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.unsubscribeStore();
    this.unsubscribeInput();
    this.ctx.ui.setWidget(WIDGET_KEY, undefined);
  }

  private refresh(): void {
    if (this.inspectorOpen || this.snapshots.length === 0) {
      this.ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    this.ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      this.tui = tui;
      return {
        render: (width: number) => this.active ? fleetRosterLines(this.snapshots, this.selected, width, theme) : fleetLines(this.snapshots, width, theme),
        invalidate() {},
      };
    }, { placement: "belowEditor" });
    this.tui?.requestRender();
  }

  private handleInput(data: string): { consume?: boolean; data?: string } | undefined {
    if (isKeyRelease(data) || this.inspectorOpen) return undefined;
    if (matchesKey(data, "ctrl+alt+f" as Parameters<typeof matchesKey>[1])) {
      void this.openInspector(this.snapshots[Math.max(0, this.selected - 1)]?.executionId);
      return { consume: true };
    }
    if (this.snapshots.length === 0 || this.ctx.ui.getEditorText() !== "") return undefined;
    if (!this.active) {
      if (!this.snapshots.some((snapshot) => !terminalState(snapshot))) return undefined;
      if (!matchesKey(data, "down") && !matchesKey(data, "left")) return undefined;
      this.active = true;
      this.selected = 0;
      this.refresh();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      this.active = false;
      this.selected = 0;
      this.refresh();
      return { consume: true };
    }
    if (matchesKey(data, "down") || data === "j") {
      this.selected = Math.min(this.snapshots.length, this.selected + 1);
      this.refresh();
      return { consume: true };
    }
    if (matchesKey(data, "up") || data === "k") {
      if (this.selected === 0) this.active = false;
      else this.selected -= 1;
      this.refresh();
      return { consume: true };
    }
    if (matchesKey(data, "return") || data === "\r") {
      if (this.selected === 0) {
        this.active = false;
        this.refresh();
      } else void this.openInspector(this.snapshots[this.selected - 1]?.executionId);
      return { consume: true };
    }
    this.active = false;
    this.refresh();
    return undefined;
  }

  private async openInspector(executionId?: string): Promise<void> {
    if (this.inspectorOpen) return;
    this.inspectorOpen = true;
    this.refresh();
    try {
      await this.ctx.ui.custom<undefined>((tui, theme, _keybindings, done) => new FleetInspector(tui, theme, this.store, done, executionId), {
        overlay: true,
        overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" },
      });
    } finally {
      this.inspectorOpen = false;
      this.refresh();
    }
  }
}
