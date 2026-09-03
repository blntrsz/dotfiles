import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const WARNING_TOKENS = 130_000;
const ERROR_TOKENS = 150_000;
const MIN_PADDING = 2;

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return tokens.toString();
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  if (tokens < 10_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return `${Math.round(tokens / 1_000_000)}M`;
}

function formatCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;

  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));

  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function getCost(usage: Usage | undefined): number {
  return usage?.cost.total ?? 0;
}

function sanitizeStatus(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function align(left: string, right: string, width: number): string {
  const truncatedLeft = truncateToWidth(left, width, "...");
  const leftWidth = visibleWidth(truncatedLeft);
  const availableForRight = width - leftWidth - MIN_PADDING;

  if (availableForRight <= 0) return truncatedLeft;

  const truncatedRight = truncateToWidth(right, availableForRight, "");
  const padding = " ".repeat(Math.max(MIN_PADDING, width - leftWidth - visibleWidth(truncatedRight)));
  return truncatedLeft + padding + truncatedRight;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          let location = formatCwd(
            ctx.sessionManager.getCwd(),
            process.env.HOME || process.env.USERPROFILE,
          );
          const branch = footerData.getGitBranch();
          if (branch) location += ` (${branch})`;

          const sessionName = ctx.sessionManager.getSessionName();
          if (sessionName) location += ` • ${sessionName}`;

          let cost = 0;
          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type === "message") {
              if (entry.message.role === "assistant" || entry.message.role === "toolResult") {
                cost += getCost(entry.message.usage);
              }
            } else if (entry.type === "branch_summary" || entry.type === "compaction") {
              cost += getCost(entry.usage);
            }
          }

          const usage = ctx.getContextUsage();
          const tokens = usage?.tokens;
          const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const percentage = usage?.percent;
          const context = tokens == null ? "?" : formatTokens(tokens);
          const percent = percentage == null ? "?" : `${percentage.toFixed(1)}%`;
          const contextText = `${context}/${formatTokens(contextWindow)} (${percent})`;
          const highlightedContext =
            tokens != null && tokens >= ERROR_TOKENS
              ? theme.fg("error", contextText)
              : tokens != null && tokens >= WARNING_TOKENS
                ? theme.fg("warning", contextText)
                : theme.fg("dim", contextText);
          const left = `${theme.fg("dim", `$${cost.toFixed(3)} `)}${highlightedContext}`;

          const modelName = ctx.model?.id ?? "no-model";
          let right = modelName;
          if (ctx.model?.reasoning) {
            const thinkingLevel = ctx.thinkingLevel ?? "off";
            right += thinkingLevel === "off" ? " • thinking off" : ` • ${thinkingLevel}`;
          }
          if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
            const withProvider = `(${ctx.model.provider}) ${right}`;
            if (visibleWidth(left) + MIN_PADDING + visibleWidth(withProvider) <= width) {
              right = withProvider;
            }
          }

          const lines = [
            truncateToWidth(theme.fg("dim", location), width, theme.fg("dim", "...")),
            align(left, theme.fg("dim", right), width),
          ];

          const statuses = Array.from(footerData.getExtensionStatuses().entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => sanitizeStatus(text));
          if (statuses.length > 0) {
            lines.push(truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")));
          }

          return lines;
        },
      };
    });
  });
}
