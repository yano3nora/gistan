import { parseArgs } from "@std/cli/parse-args";
import { run as runEdit } from "./commands/edit.ts";
import { run as runImport } from "./commands/import.ts";
import { run as runList } from "./commands/list.ts";
import { run as runNew } from "./commands/new.ts";
import { run as runPublish } from "./commands/publish.ts";
import { run as runPull } from "./commands/pull.ts";
import { run as runRm } from "./commands/rm.ts";
import { run as runRoot } from "./commands/root.ts";
import { run as runSearch } from "./commands/search.ts";
import { run as runStatus } from "./commands/status.ts";
import { run as runUnpublish } from "./commands/unpublish.ts";
import type { CommandContext, CommandHandler, CommandName } from "./commands/types.ts";
import { writeText } from "./commands/types.ts";
import { defaultConfigPath } from "./core/config.ts";
import { systemRunner } from "./core/proc.ts";
export const VERSION = "gistan 0.3.0";
export const COMMAND_DESCRIPTIONS: Record<CommandName, string> = {
  new: "Create a file under gists/<dir>/.",
  search: "Search gists and stars.",
  edit: "Open a gist file.",
  list: "List gist directories.",
  rm: "Delete a gist file.",
  publish: "Publish/update a gist directory.",
  unpublish: "Delete remote gist, keep local dir.",
  pull: "Pull remote gist files.",
  status: "Show drift status; --fix repairs.",
  import: "Import existing gists.",
  root: "Manage the gist repo: init / path / commit / push / pull.",
};
const COMMANDS: Record<CommandName, CommandHandler> = {
  new: runNew,
  search: runSearch,
  edit: runEdit,
  list: runList,
  rm: runRm,
  publish: runPublish,
  unpublish: runUnpublish,
  pull: runPull,
  status: runStatus,
  import: runImport,
  root: runRoot,
};

/**
 * Guidance for two commands removed in the root-command reorg (TASK-260708):
 * `gistan init` moved under `gistan root init`, `gistan sync` was replaced
 * by the more explicit `gistan root commit / push / pull`. Checked before
 * normal resolution so the hint fires even though neither name is a
 * CommandName anymore.
 */
const REMOVED_COMMAND_HINTS: Record<string, string> = {
  init: "error: 'gistan init' was moved — did you mean 'gistan root init'?\n",
  sync: "error: 'gistan sync' was removed — use 'gistan root commit / push / pull'\n",
};
export interface RunOptions {
  readonly context?: CommandContext;
  readonly commands?: Partial<Record<CommandName, CommandHandler>>;
}
function defaultContext(): CommandContext {
  const env = { HOME: Deno.env.get("HOME"), XDG_CONFIG_HOME: Deno.env.get("XDG_CONFIG_HOME") };
  return {
    stdout: Deno.stdout,
    stderr: Deno.stderr,
    runner: systemRunner,
    configPath: defaultConfigPath(env),
    home: env.HOME ?? ".",
    confirm: (m) => Promise.resolve(confirm(m)),
    editor: Deno.env.get("EDITOR") ?? "vi",
  };
}
export function usage(): string {
  return `gistan - manage a repo-backed gist collection\n\nUsage:\n  gistan [--help|-h]\n  gistan --version\n  gistan <command> [args...]\n\nCommands:\n${
    Object.entries(COMMAND_DESCRIPTIONS).map(([n, d]) => `  ${n.padEnd(10)} ${d}`).join("\n")
  }\n`;
}
export function resolveCommand(name: string | undefined): CommandName | undefined {
  if (name === undefined) return undefined;
  return Object.hasOwn(COMMAND_DESCRIPTIONS, name) ? name as CommandName : undefined;
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
  if (rawCommand !== undefined && Object.hasOwn(REMOVED_COMMAND_HINTS, rawCommand)) {
    await writeText(context.stderr, REMOVED_COMMAND_HINTS[rawCommand]);
    return 2;
  }
  const commandName = rawCommand === undefined ? "search" : resolveCommand(rawCommand);
  if (commandName === undefined) {
    await writeText(context.stderr, usage());
    return 2;
  }
  return await commands[commandName]({ name: commandName, args: commandArgs }, context);
}
if (import.meta.main) Deno.exit(await run(Deno.args));
