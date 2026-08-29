import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import packageJson from "../package.json" with { type: "json" };
import { setupCommand } from "./commands/setup";

const command = Command.make("dotfiles").pipe(
  Command.withDescription("Manage this dotfiles repository"),
  Command.withSubcommands([setupCommand]),
);

command.pipe(
  Command.run({ version: packageJson.version }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
