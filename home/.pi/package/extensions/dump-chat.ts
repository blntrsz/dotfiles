import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  CURRENT_SESSION_VERSION,
  type ExtensionAPI,
  type SessionEntry,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";

type SessionReader = Pick<SessionManager, "getBranch" | "getCwd" | "getSessionId">;

function defaultFileName(now: Date): string {
  return `pi-chat-${now.toISOString().replace(/[:.]/g, "-")}.jsonl`;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function resolveDumpPath(args: string, cwd: string, now = new Date()): string {
  const requested = unquote(args.trim());
  if (!requested) return join(cwd, defaultFileName(now));

  if (requested === "~") return homedir();
  if (requested.startsWith("~/")) return resolve(homedir(), requested.slice(2));
  return isAbsolute(requested) ? requested : resolve(cwd, requested);
}

export function serializeCurrentChat(
  session: SessionReader,
  systemPrompt: string,
  now = new Date(),
): string {
  const timestamp = now.toISOString();
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: session.getSessionId(),
    timestamp,
    cwd: session.getCwd(),
    systemPrompt,
  };

  const lines = [JSON.stringify(header)];
  let parentId: string | null = null;

  for (const entry of session.getBranch()) {
    const exportedEntry: SessionEntry = { ...entry, parentId };
    lines.push(JSON.stringify(exportedEntry));
    parentId = entry.id;
  }

  return `${lines.join("\n")}\n`;
}

export async function dumpChat(
  session: SessionReader,
  systemPrompt: string,
  outputPath: string,
  now = new Date(),
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serializeCurrentChat(session, systemPrompt, now), "utf8");
}

export default function dumpChatExtension(pi: ExtensionAPI): void {
  pi.registerCommand("dump-chat", {
    description: "Dump the current chat branch and system prompt to a JSONL file",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const outputPath = resolveDumpPath(args, ctx.cwd);

      try {
        await dumpChat(ctx.sessionManager, ctx.getSystemPrompt(), outputPath);
        if (ctx.hasUI) ctx.ui.notify(`Chat dumped to ${outputPath}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(`Failed to dump chat: ${message}`, "error");
        else console.error(`Failed to dump chat: ${message}`);
      }
    },
  });
}
