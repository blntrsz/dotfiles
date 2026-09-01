import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "../..");
const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("dotfiles setup", () => {
  test("installs Pi dependencies from the deployed package root", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "dotfiles-setup-"));
    temporaryDirectories.push(temporaryDirectory);

    const home = join(temporaryDirectory, "home");
    const repositoryRoot = join(temporaryDirectory, "repository");
    const stubDirectory = join(temporaryDirectory, "bin");
    const npmStub = join(stubDirectory, "npm");
    const bunStub = join(stubDirectory, "bun");

    await Promise.all(
      [
        home,
        stubDirectory,
        join(repositoryRoot, "bin"),
        join(repositoryRoot, "cli"),
        join(repositoryRoot, "home", ".config", "nvim"),
        join(repositoryRoot, "home", ".pi", "agent"),
        join(repositoryRoot, "home", ".agents", "skills"),
      ].map((directory) => mkdir(directory, { recursive: true })),
    );
    await Promise.all([
      writeFile(
        join(repositoryRoot, "home", ".pi", "agent", "settings.personal.json"),
        "{}\n",
      ),
      writeFile(join(repositoryRoot, "home", ".pi", "package.json"), "{}\n"),
      writeFile(
        npmStub,
        `#!/bin/sh
printf '%s\\n' "$PWD" >"$HOME/npm.cwd"
`,
      ),
      writeFile(bunStub, "#!/bin/sh\nexit 0\n"),
    ]);
    await Promise.all([chmod(npmStub, 0o755), chmod(bunStub, 0o755)]);

    const process = Bun.spawn(
      [join(projectRoot, "bin", "dotfiles"), "setup", "--profile", "personal"],
      {
        cwd: projectRoot,
        env: {
          ...Bun.env,
          DOTFILES_ROOT: repositoryRoot,
          HOME: home,
          PATH: `${stubDirectory}:${Bun.env.PATH ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    if (exitCode !== 0) {
      throw new Error(`setup exited with ${exitCode}\n${stdout}${stderr}`);
    }

    expect(await readFile(join(home, "npm.cwd"), "utf8")).toBe(
      `${await realpath(join(home, ".pi"))}\n`,
    );
  }, 30_000);
});
