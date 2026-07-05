import { parseArgs } from "@std/cli/parse-args";
import { run as runDoctor } from "./commands/doctor.ts";
import { run as runEdit } from "./commands/edit.ts";
import { run as runImport } from "./commands/import.ts";
import { run as runInit } from "./commands/init.ts";
import { run as runList } from "./commands/list.ts";
import { run as runNew } from "./commands/new.ts";
import { run as runPublish } from "./commands/publish.ts";
import { run as runPull } from "./commands/pull.ts";
import { run as runRm } from "./commands/rm.ts";
import { run as runRoot } from "./commands/root.ts";
import { run as runSearch } from "./commands/search.ts";
import { run as runStatus } from "./commands/status.ts";
import { run as runSync } from "./commands/sync.ts";
import { run as runUnpublish } from "./commands/unpublish.ts";
import type { CommandContext, CommandHandler, CommandName } from "./commands/types.ts";
import { writeText } from "./commands/types.ts";
import { defaultConfigPath } from "./core/config.ts";
import { systemRunner } from "./core/proc.ts";

export const VERSION = "gistan 0.1.0";

export const COMMAND_DESCRIPTIONS: Record<CommandName, string> = {
  init: "Set up a gist repo or connect an existing one.",
  new: "Create a snippet from the template and open it.",
  search: "Live full-text search over snippets and stars.",
  edit: "Fuzzy-pick a snippet and open it in $EDITOR.",
  list: "List snippets with tags and publish state.",
  rm: "Delete a snippet (and optionally its gist).",
  publish: "Publish or update a snippet as a gist.",
  unpublish: "Delete the remote gist, keep the local file.",
  pull: "Take remote gist edits into the repo.",
  status: "Show publish and drift status for snippets.",
  doctor: "Detect and repair index/remote inconsistencies.",
  import: "Import existing gists into the local repo.",
  sync: "git add / commit / pull --rebase / push in one shot.",
  root: "Print the gist repo path.",
};

const COMMANDS: Record<CommandName, CommandHandler> = {
  init: runInit,
  new: runNew,
  search: runSearch,
  edit: runEdit,
  list: runList,
  rm: runRm,
  publish: runPublish,
  unpublish: runUnpublish,
  pull: runPull,
  status: runStatus,
  doctor: runDoctor,
  import: runImport,
  sync: runSync,
  root: runRoot,
};

export interface RunOptions {
  readonly context?: CommandContext;
  readonly commands?: Partial<Record<CommandName, CommandHandler>>;
}

function defaultContext(): CommandContext {
  const env = {
    HOME: Deno.env.get("HOME"),
    XDG_CONFIG_HOME: Deno.env.get("XDG_CONFIG_HOME"),
  };
  return {
    stdout: Deno.stdout,
    stderr: Deno.stderr,
    runner: systemRunner,
    configPath: defaultConfigPath(env),
    home: env.HOME ?? ".",
    // Deno's confirm() returns false on a non-TTY stdin, so destructive
    // actions are safely refused when gistan is run non-interactively.
    confirm: (message) => Promise.resolve(confirm(message)),
    editor: Deno.env.get("EDITOR") ?? "vi",
  };
}

export function usage(): string {
  const commandLines = Object.entries(COMMAND_DESCRIPTIONS)
    .map(([name, description]) => `  ${name.padEnd(10)} ${description}`)
    .join("\n");

  return `gistan - manage a repo-backed gist snippet collection\n\nUsage:\n  gistan [--help|-h]\n  gistan --version\n  gistan <command> [args...]\n\nCommands:\n${commandLines}\n`;
}

export function resolveCommand(name: string | undefined): CommandName | undefined {
  if (name === undefined) {
    return undefined;
  }

  return Object.hasOwn(COMMAND_DESCRIPTIONS, name) ? (name as CommandName) : undefined;
}

export async function run(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const context = options.context ?? defaultContext();
  const commands = { ...COMMANDS, ...options.commands };
  const parsed = parseArgs([...argv], {
    boolean: ["help", "version"],
    alias: { help: "h" },
    stopEarly: true,
  });

  if (parsed.help) {
    await writeText(context.stdout, usage());
    return 0;
  }

  if (parsed.version) {
    await writeText(context.stdout, `${VERSION}\n`);
    return 0;
  }

  const [rawCommand, ...commandArgs] = parsed._.map(String);
  // Bare `gistan` drops straight into search — the most frequent entry point.
  const commandName = rawCommand === undefined ? "search" : resolveCommand(rawCommand);

  if (commandName === undefined) {
    await writeText(context.stderr, usage());
    return 2;
  }

  return await commands[commandName]({ name: commandName, args: commandArgs }, context);
}

if (import.meta.main) {
  Deno.exit(await run(Deno.args));
}
