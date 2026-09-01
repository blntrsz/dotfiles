# Dotfiles

Deploy the curated files, select a Pi settings variant, and reconcile its package inventory:

```bash
bun run --cwd cli build
./bin/dotfiles setup
pi update --extensions
pi config
```

`dotfiles setup` prompts for a personal or work Pi profile, recursively clears `~/.config/nvim`, `~/.pi`, and `~/.agents/skills`, runs Stow against the repository's `home` package, and links `agent/settings.json` to the selected settings variant. Other paths under `~/.config` are preserved. For non-interactive setup, pass `--profile personal` or `--profile work`.

Use `~/.pi/select-settings personal` or `~/.pi/select-settings work` to switch later. Run it without an argument to print the active variant. Selection applies to new Pi processes; avoid switching the shared symlink while personal and work processes are running concurrently.

`home/.pi/package.json` records the runtime dependencies used by the Pi configuration and local extensions. Setup runs a production dependency install in `~/.pi` after Stow deployment so those dependencies are immediately available. Personal files that Pi packages do not support, such as `agent/keybindings.json` and custom agent definitions, are deployed directly by Stow. Herdr's managed extension remains at its auto-discovered `agent/extensions/herdr-agent-state.ts` path and is tracked explicitly.

`agent/settings.personal.json` and `agent/settings.work.json` independently record preferences and installed packages. The active `agent/settings.json` symlink is local and ignored. Pi writes preference and package changes through the symlink into the selected tracked variant, so review its diffs before committing.

Other writable state under `~/.pi/agent` is ignored by an allowlist policy. Credentials, sessions, trust decisions, caches, installed package contents, and generated dependencies must remain local.

## Neovim

Statically check the Lua configuration with LuaLS, then smoke-test a headless Neovim startup:

```bash
home/.config/nvim/check
```

The checker uses `lua-language-server` from `PATH` or the Mason installation. Install it with `:MasonInstall lua-language-server` if needed.

## CLI

The `cli` package uses Effect v4's beta `effect/unstable/cli` API and the matching Bun platform package. Build its standalone executable into `bin`:

```bash
bun install --cwd cli
bun run --cwd cli check
bun run --cwd cli test
bun run --cwd cli build
./bin/dotfiles --help
```

`bin/dotfiles` embeds Bun and all runtime dependencies in one generated, platform-specific file. Build outputs and `cli/node_modules` are ignored.
