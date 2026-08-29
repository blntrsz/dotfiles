import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ExecutionSnapshot } from "./domain.ts";
import { fleetLines, fleetRosterLines, isTerminalExecution, orderedFleetSnapshots } from "./render.ts";
import { RunController, RunStore } from "./run-store.ts";

const WIDGET_KEY = "subagent-fleet";

function fit(value: string, width: number): string {
  const clipped = truncateToWidth(value, Math.max(0, width));
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function executionControls(snapshot: ExecutionSnapshot): { steer: boolean; wait: boolean; cancel: boolean } {
  const active = snapshot.executionState === "running" || snapshot.executionState === "starting";
  return {
    steer: snapshot.executionState === "running" && snapshot.childState === "executing",
    wait: true,
    cancel: active,
  };
}

interface InspectorActions {
  steer(executionId: string): Promise<void>;
  wait(executionId: string, signal: AbortSignal): Promise<void>;
  cancel(executionId: string): Promise<void>;
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
  private toolsExpanded = false;
  private notice = "";
  private disposed = false;
  private readonly lifetime = new AbortController();
  private unsubscribe: () => void;

  constructor(
    private readonly tui: Pick<TUI, "requestRender">,
    private readonly theme: Theme,
    private readonly store: RunStore,
    private readonly done: (result: undefined) => void,
    initialExecutionId?: string,
    private readonly actions?: InspectorActions,
  ) {
    this.snapshots = orderedFleetSnapshots(store.list());
    this.selected = Math.max(0, initialExecutionId ? this.snapshots.findIndex((run) => run.executionId === initialExecutionId) : 0);
    this.unsubscribe = store.subscribe((snapshots) => {
      const selectedId = this.snapshots[this.selected]?.executionId;
      this.snapshots = orderedFleetSnapshots(snapshots);
      const preserved = selectedId ? this.snapshots.findIndex((run) => run.executionId === selectedId) : -1;
      this.selected = preserved >= 0 ? preserved : Math.min(this.selected, Math.max(0, this.snapshots.length - 1));
      this.tui.requestRender();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
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
    if (data === "t") {
      this.toolsExpanded = !this.toolsExpanded;
      return this.tui.requestRender();
    }
    if (data === "r") return this.tui.requestRender();
    const snapshot = this.snapshots[this.selected];
    if (!snapshot || !this.actions) return;
    const controls = executionControls(snapshot);
    const executionId = snapshot.executionId;
    if (data === "s" && controls.steer) void this.runAction("Steering", () => this.actions!.steer(executionId));
    if (data === "w" && controls.wait) void this.runAction("Waiting", () => this.actions!.wait(executionId, this.lifetime.signal));
    if (data === "c" && controls.cancel) void this.runAction("Cancellation requested; settlement is cooperative", () => this.actions!.cancel(executionId));
  }

  private async runAction(notice: string, action: () => Promise<void>): Promise<void> {
    if (this.disposed) return;
    this.notice = notice;
    this.tui.requestRender();
    try {
      await action();
      this.notice = `${notice} · done`;
    } catch (error) {
      this.notice = error instanceof Error ? error.message : String(error);
    }
    if (!this.disposed) this.tui.requestRender();
  }

  render(width: number): string[] {
    const height = Math.max(12, Math.min(30, ((this.tui as TUI).terminal?.rows ?? 28) - 4));
    const innerWidth = Math.max(3, width - 2);
    const leftWidth = Math.max(1, Math.min(42, Math.floor(innerWidth * 0.36), innerWidth - 2));
    const rightWidth = Math.max(1, innerWidth - leftWidth - 1);
    const selected = this.snapshots[this.selected];
    const titleState = selected ? `${selected.label} · ${selected.executionState}` : "no executions";
    const border = (value: string) => this.theme.fg("borderAccent", value);
    const top = border(`┌${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}┐`);
    const title = truncateToWidth(` Subagent fleet inspector · live`, leftWidth);
    const selectedTitle = truncateToWidth(` ${titleState}`, rightWidth);
    const lines = [
      top,
      `${border("│")}${fit(this.theme.bold(title), leftWidth)}${border("│")}${fit(this.theme.fg("accent", selectedTitle), rightWidth)}${border("│")}`,
      border(`├${"─".repeat(leftWidth)}┼${"─".repeat(rightWidth)}┤`),
    ];

    const roster = this.roster(leftWidth);
    const detail = this.detail(selected, rightWidth);
    const bodyHeight = height - 5;
    const maxScroll = Math.max(0, detail.length - bodyHeight);
    this.scroll = Math.min(this.scroll, maxScroll);
    const visibleDetail = detail.slice(this.scroll, this.scroll + bodyHeight);
    for (let row = 0; row < bodyHeight; row += 1) {
      lines.push(`${border("│")}${fit(roster[row] ?? "", leftWidth)}${border("│")}${fit(visibleDetail[row] ?? "", rightWidth)}${border("│")}`);
    }
    lines.push(border(`├${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┤`));
    const controls = selected ? executionControls(selected) : { steer: false, wait: false, cancel: false };
    const keys = ` agent ↑↓ · scroll ⇧K/J · s steer${controls.steer ? "" : " off"} · w wait${controls.wait ? "" : " off"} · c cancel${controls.cancel ? "" : " off"} · t tools · r refresh · Esc close`;
    lines.push(`${border("│")}${fit(this.theme.fg("dim", this.notice ? ` ${this.notice}` : keys), innerWidth)}${border("│")}`);
    lines.push(border(`└${"─".repeat(innerWidth)}┘`));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private roster(width: number): string[] {
    const lines = [this.theme.fg("muted", "   ◉ main · parent")];
    if (this.snapshots.length === 0) return [...lines, this.theme.fg("dim", " No current-session Children")];
    const indexed = this.snapshots.map((snapshot, index) => ({ snapshot, index }));
    const append = ({ snapshot, index }: (typeof indexed)[number], historical = false) => {
      const marker = index === this.selected ? this.theme.fg("accent", ">") : " ";
      const glyph = snapshot.executionState === "running" ? this.theme.fg("accent", "●") : isTerminalExecution(snapshot) ? this.theme.fg(snapshot.executionState === "succeeded" ? "success" : "error", snapshot.executionState === "succeeded" ? "✓" : "✗") : this.theme.fg("muted", "◦");
      const text = `${marker} ${glyph} ${snapshot.label} · ${snapshot.childState === "idle" ? "idle" : snapshot.executionState}`;
      lines.push(truncateToWidth(historical ? this.theme.fg("dim", text) : this.theme.bold(text), width));
    };
    indexed.filter(({ snapshot }) => snapshot.childState !== "closed").forEach((entry) => append(entry));
    const history = indexed.filter(({ snapshot }) => snapshot.childState === "closed" && isTerminalExecution(snapshot));
    if (history.length) {
      lines.push("", this.theme.fg("dim", " Process history"));
      history.forEach((entry) => append(entry, true));
    }
    return lines;
  }

  private detail(snapshot: ExecutionSnapshot | undefined, width: number): string[] {
    if (!snapshot) return [this.theme.fg("dim", " No current-session Fleet jobs."), "", " New Children appear here automatically."];
    const usage = snapshot.usage;
    const lines = [
      ` ${this.theme.bold(snapshot.label)} ${this.theme.fg("dim", `· ${snapshot.executionState}`)}`,
      ` ${this.theme.fg("dim", `${snapshot.context} · ${snapshot.model} · ${snapshot.thinkingLevel}`)}`,
      ` ${this.theme.fg("dim", `${usage.input + usage.output} tok · ${usage.turns} turns · ${snapshot.events.filter((event) => event.type === "tool-start").length} tools`)}`,
      ` ${this.theme.fg("dim", `Child ${snapshot.childId} · ${snapshot.handleId ? `Handle ${snapshot.handleId} (${snapshot.handleState})` : "Handle — (not applicable)"}`)}`,
      ` ${this.theme.fg("dim", `Execution ${snapshot.executionId} · Completion ${snapshot.completion?.completionId ?? "pending"} (${snapshot.completion?.status ?? "pending"})`)}`,
      ` ${this.theme.fg("dim", `Delivery ${snapshot.delivery.deliveryId} (${snapshot.delivery.state})`)}`,
      ` ${this.theme.fg("muted", `Task  ${snapshot.task}`)}`,
      ` ${this.theme.fg("muted", `Activity  ${snapshot.activity}`)}`,
      "",
      ` ${this.theme.fg("accent", "Conversation")}`,
    ];
    for (const event of snapshot.events) {
      const glyph = event.type === "tool-end" ? this.theme.fg("success", "✓") : event.type === "tool-start" ? this.theme.fg("accent", "├─") : this.theme.fg("borderMuted", "│");
      lines.push(` ${glyph} ${eventLabel(event)}`);
      if (this.toolsExpanded && event.type.startsWith("tool-") && event.data !== undefined) {
        lines.push(...JSON.stringify(event.data, null, 2).split("\n").map((line) => `    ${this.theme.fg("dim", line)}`));
      }
    }
    if (snapshot.completion?.text) lines.push("", ` ${this.theme.fg("accent", "Output")}`, ...snapshot.completion.text.split("\n").map((line) => ` ${line}`));
    if (snapshot.completion?.error) lines.push("", ` ${this.theme.fg("error", `${snapshot.completion.error.code}: ${snapshot.completion.error.message}`)}`);
    if (snapshot.completion?.diagnosticExcerpt) lines.push(` ${this.theme.fg("warning", snapshot.completion.diagnosticExcerpt)}`);
    if (snapshot.delivery.diagnostic) lines.push(` ${this.theme.fg("warning", `Pending delivery failure: ${snapshot.delivery.diagnostic}`)}`);
    if (snapshot.diagnostics?.length) lines.push("", ` ${this.theme.fg("accent", "Diagnostics")}`, ...snapshot.diagnostics.map((diagnostic) => ` ${this.theme.fg("warning", diagnostic)}`));
    if (snapshot.omitted) lines.push(` ${this.theme.fg("warning", `${snapshot.omitted.events} retained-history events and ${snapshot.omitted.bytes} bytes omitted`)}`);
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

  constructor(private readonly ctx: ExtensionContext, private readonly store: RunStore, private readonly controller?: RunController) {
    this.unsubscribeStore = store.subscribe((snapshots) => {
      this.snapshots = orderedFleetSnapshots(snapshots);
      this.selected = Math.min(this.selected, this.snapshots.length);
      const running = snapshots.filter((snapshot) => !isTerminalExecution(snapshot)).length;
      ctx.ui.setStatus("subagent-fleet", `subagents: ${running} running`);
      this.refresh();
    });
    this.unsubscribeInput = ctx.ui.onTerminalInput((data) => this.handleInput(data));
    this.timer = setInterval(() => {
      if (this.snapshots.some((snapshot) => !isTerminalExecution(snapshot))) this.tui?.requestRender();
    }, 500);
    this.timer.unref?.();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.ctx.ui.setStatus("subagent-fleet", undefined);
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

  handleInput(data: string): { consume?: boolean; data?: string } | undefined {
    if (isKeyRelease(data) || this.inspectorOpen) return undefined;
    if (matchesKey(data, "ctrl+o" as Parameters<typeof matchesKey>[1])) {
      void this.openInspector(this.snapshots[Math.max(0, this.selected - 1)]?.executionId);
      return { consume: true };
    }
    if (this.snapshots.length === 0 || this.ctx.ui.getEditorText() !== "") return undefined;
    if (!this.active) {
      if (!this.snapshots.some((snapshot) => !isTerminalExecution(snapshot))) return undefined;
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
      const actions: InspectorActions | undefined = this.controller ? {
        steer: async (stableExecutionId) => {
          const message = await this.ctx.ui.input(`Steer Execution ${stableExecutionId}`, "Instruction for the running Child");
          if (message?.trim()) await this.controller!.steer(stableExecutionId, message);
        },
        wait: async (stableExecutionId, signal) => {
          const result = await this.controller!.wait(stableExecutionId, { signal });
          this.ctx.ui.notify(`Execution ${stableExecutionId}: ${result.completion.status}`, "info");
        },
        cancel: async (stableExecutionId) => {
          const confirmed = await this.ctx.ui.confirm(
            `Cancel Execution ${stableExecutionId}?`,
            "Cancellation is nonterminal until settlement. Synchronously blocking in-process code cannot be hard-killed.",
          );
          if (confirmed) await this.controller!.cancel(stableExecutionId);
        },
      } : undefined;
      await this.ctx.ui.custom<undefined>((tui, theme, _keybindings, done) => new FleetInspector(tui, theme, this.store, done, executionId, actions), {
        overlay: true,
        overlayOptions: { width: "90%", minWidth: 60, maxHeight: "80%", anchor: "center" },
      });
    } finally {
      this.inspectorOpen = false;
      this.refresh();
    }
  }
}
