import {
  createEditToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

const FINAL_MESSAGE_LABEL = "────── final message ";
const PEACH = "\x1b[38;2;245;169;127m";
const RESET_FOREGROUND = "\x1b[39m";

function finalMessageHeader(width: number): string {
  if (width <= FINAL_MESSAGE_LABEL.length) {
    return FINAL_MESSAGE_LABEL.slice(0, Math.max(0, width));
  }
  return FINAL_MESSAGE_LABEL + "─".repeat(width - FINAL_MESSAGE_LABEL.length);
}

class LeftAccent implements Component {
  constructor(
    private child: Component,
    private color: (text: string) => string,
  ) {}

  getChild(): Component {
    return this.child;
  }

  update(child: Component, color: (text: string) => string): void {
    this.child = child;
    this.color = color;
  }

  invalidate(): void {
    this.child.invalidate();
  }

  render(width: number): string[] {
    if (width <= 0) return [];

    const accent = this.color("│");
    if (width === 1) {
      const lines = this.child.render(1);
      return lines.map(() => accent);
    }

    const contentWidth = Math.max(1, width - 2);
    return this.child
      .render(contentWidth)
      .map((line) => `${accent} ${truncateToWidth(line, contentWidth, "")}`);
  }
}

function previousChild(component: Component | undefined): Component | undefined {
  return component instanceof LeftAccent ? component.getChild() : undefined;
}

function addLeftAccent(
  previous: Component | undefined,
  child: Component,
  color: (text: string) => string,
): LeftAccent {
  if (previous instanceof LeftAccent) {
    previous.update(child, color);
    return previous;
  }
  return new LeftAccent(child, color);
}

export default function (pi: ExtensionAPI) {
  const write = createWriteToolDefinition(process.cwd());
  pi.registerTool({
    ...write,
    renderShell: "self",
    renderCall(args, theme, context) {
      const child = write.renderCall!(args, theme, {
        ...context,
        lastComponent: previousChild(context.lastComponent),
      });
      return addLeftAccent(context.lastComponent, child, (text) => theme.fg("bashMode", text));
    },
    renderResult(result, options, theme, context) {
      const child = write.renderResult!(result, options, theme, {
        ...context,
        lastComponent: previousChild(context.lastComponent),
      });
      return addLeftAccent(context.lastComponent, child, (text) => theme.fg("bashMode", text));
    },
  });

  const edit = createEditToolDefinition(process.cwd());
  pi.registerTool({
    ...edit,
    renderShell: "self",
    renderCall(args, theme, context) {
      const child = edit.renderCall!(args, theme, {
        ...context,
        lastComponent: previousChild(context.lastComponent),
      });
      return addLeftAccent(context.lastComponent, child, (text) => theme.fg("bashMode", text));
    },
    renderResult(result, options, theme, context) {
      const child = edit.renderResult!(result, options, theme, {
        ...context,
        lastComponent: previousChild(context.lastComponent),
      });
      return addLeftAccent(context.lastComponent, child, (text) => theme.fg("bashMode", text));
    },
  });

  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType !== "assistant" || context.isStreaming || !markdown.trim()) {
      return markdown;
    }
    const header = `${PEACH}${finalMessageHeader(context.availableWidth)}${RESET_FOREGROUND}`;
    return `${header}\n\n${markdown}`;
  });
}
