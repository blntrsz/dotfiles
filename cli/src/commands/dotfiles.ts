import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { setupCommand } from "./setup";

export const dotfilesCommand = Command.make(
  "dotfiles",
  {},
  () => Effect.void,
).pipe(
  Command.withDescription("Manage this dotfiles repository"),
  Command.withSubcommands([setupCommand]),
);
