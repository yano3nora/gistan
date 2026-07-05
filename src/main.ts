import { parseArgs } from "@std/cli/parse-args";
import { run as runImport } from "./commands/import.ts";
import { run as runInit } from "./commands/init.ts";
import { run as runPublish } from "./commands/publish.ts";
import { run as runSearch } from "./commands/search.ts";
import { run as runStatus } from "./commands/status.ts";
import type { CommandContext, CommandHandler, CommandName } from "./commands/types.ts";
import { writeText } from "./commands/types.ts";

export const VERSION = "gistan 0.1.0";

export const COMMAND_DESCRIPTIONS: Record<CommandName, string> = {
  init: "Set up a gist repo or connect an existing one.",
  import: "Import existing gists into the local repo.",
  search: "Search snippets and starred gist mirrors.",
  publish: "Publish or update a snippet as a gist.",
  status: "Show publish and drift status for snippets.",
};

const COMMANDS: Record<CommandName, CommandHandler> = {
  init: runInit,
  import: runImport,
  search: runSearch,
  publish: runPublish,
  status: runStatus,
};

export interface RunOptions {
  readonly context?: CommandContext;
  readonly commands?: Partial<Record<CommandName, CommandHandler>>;
}

function defaultContext(): CommandContext {
  return {
    stdout: Deno.stdout,
    stderr: Deno.stderr,
  };
}

export function usage(): string {
  const commandLines = Object.entries(COMMAND_DESCRIPTIONS)
    .map(([name, description]) => `  ${name.padEnd(8)} ${description}`)
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
  const commandName = resolveCommand(rawCommand);

  if (commandName === undefined) {
    await writeText(context.stderr, usage());
    return 2;
  }

  return await commands[commandName]({ name: commandName, args: commandArgs }, context);
}

if (import.meta.main) {
  Deno.exit(await run(Deno.args));
}
