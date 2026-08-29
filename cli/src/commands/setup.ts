import { Console, Effect, FileSystem, Path } from "effect";
import { Command, Flag, Prompt } from "effect/unstable/cli";
import {
  ChildProcess,
  ChildProcessSpawner,
} from "effect/unstable/process";

const installPaths = [".config/nvim", ".pi"] as const;
const profiles = ["personal", "work"] as const;

type Profile = (typeof profiles)[number];

const profile = Flag.choice("profile", profiles).pipe(
  Flag.withDescription("Pi settings profile to activate"),
  Flag.withFallbackPrompt(
    Prompt.select({
      message: "Is this a personal or work setup?",
      choices: [
        { title: "Personal", value: "personal" as const },
        { title: "Work", value: "work" as const },
      ],
    }),
  ),
);

const fail = (message: string) => Effect.fail(new Error(message));

const setup = (selectedProfile: Profile) => Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const home = process.env.HOME;
  if (home === undefined || home.length === 0) {
    return yield* fail("HOME is not set");
  }

  const repositoryRoot = path.resolve(
    process.env.DOTFILES_ROOT ?? path.join(path.dirname(process.execPath), ".."),
  );
  const packageRoot = path.join(repositoryRoot, "home");
  const cliRoot = path.join(repositoryRoot, "cli");
  const executable = path.join(repositoryRoot, "bin", "dotfiles");

  for (const relativePath of installPaths) {
    const source = path.join(packageRoot, relativePath);
    if (!(yield* fileSystem.exists(source))) {
      return yield* fail(`Missing Stow source: ${source}`);
    }
  }

  const settingsFile = `settings.${selectedProfile}.json`;
  const settingsSource = path.join(packageRoot, ".pi", "agent", settingsFile);
  if (!(yield* fileSystem.exists(settingsSource))) {
    return yield* fail(`Missing Pi settings profile: ${settingsSource}`);
  }

  const stowVersionExitCode = yield* spawner.exitCode(
    ChildProcess.make("stow", ["--version"], {
      stdout: "ignore",
      stderr: "ignore",
    }),
  );
  if (stowVersionExitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* fail("stow is not available");
  }

  const buildExitCode = yield* spawner.exitCode(
    ChildProcess.make("bun", ["run", "build"], {
      cwd: cliRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  if (buildExitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* fail(`CLI build failed with exit code ${buildExitCode}`);
  }

  const resolvedHome = path.resolve(home);
  for (const relativePath of installPaths) {
    const target = path.resolve(resolvedHome, relativePath);
    if (!target.startsWith(`${resolvedHome}${path.sep}`)) {
      return yield* fail(`Refusing to remove path outside HOME: ${target}`);
    }
    if (
      repositoryRoot === target ||
      repositoryRoot.startsWith(`${target}${path.sep}`)
    ) {
      return yield* fail(`Refusing to remove path containing the repository: ${target}`);
    }

    yield* fileSystem.remove(target, { recursive: true, force: true });
    yield* Console.log(`Cleared ${target}`);
  }

  const stowExitCode = yield* spawner.exitCode(
    ChildProcess.make(
      "stow",
      ["--dir", repositoryRoot, "--target", resolvedHome, "home"],
      {
        cwd: repositoryRoot,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    ),
  );
  if (stowExitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* fail(`stow failed with exit code ${stowExitCode}`);
  }

  const agentDirectory = path.join(resolvedHome, ".pi", "agent");
  const settingsLink = path.join(agentDirectory, "settings.json");
  const temporaryLink = path.join(agentDirectory, `.settings.json.${process.pid}`);

  yield* fileSystem.remove(temporaryLink, { force: true });
  yield* fileSystem.symlink(settingsFile, temporaryLink).pipe(
    Effect.andThen(fileSystem.rename(temporaryLink, settingsLink)),
    Effect.ensuring(
      fileSystem.remove(temporaryLink, { force: true }).pipe(Effect.ignore),
    ),
  );

  const localBin = path.join(resolvedHome, ".local", "bin");
  const executableLink = path.join(localBin, "dotfiles");
  yield* fileSystem.makeDirectory(localBin, { recursive: true });
  yield* fileSystem.remove(executableLink, { force: true });
  yield* fileSystem.symlink(executable, executableLink);

  yield* Console.log(`Linked ${packageRoot} into ${resolvedHome}`);
  yield* Console.log(`Linked ${executable} to ${executableLink}`);
  yield* Console.log(`Selected Pi ${selectedProfile} settings for new processes`);
});

export const setupCommand = Command.make(
  "setup",
  { profile },
  ({ profile }) => setup(profile),
).pipe(
  Command.withDescription("Clear managed paths in HOME and link the home package with Stow"),
);
