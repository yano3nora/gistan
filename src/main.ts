import { run as runEdit } from "./commands/edit.ts";
import { run as runGrep } from "./commands/grep.ts";
import { run as runImport } from "./commands/import.ts";
import { run as runList } from "./commands/list.ts";
import { run as runNew } from "./commands/new.ts";
import { run as runPublish } from "./commands/publish.ts";
import { run as runPull } from "./commands/pull.ts";
import { run as runRm } from "./commands/rm.ts";
import { run as runRoot } from "./commands/root.ts";
import { runPreviewRender } from "./commands/preview_render.ts";
import { run as runSearch } from "./commands/search.ts";
import { runSearchRender } from "./commands/search_render.ts";
import { run as runStar } from "./commands/star.ts";
import { run as runStatus } from "./commands/status.ts";
import { run as runUnpublish } from "./commands/unpublish.ts";
import type { CommandContext, CommandHandler, CommandName } from "./commands/types.ts";
import { writeText } from "./commands/types.ts";
import { defaultConfigPath } from "./core/config.ts";
import { systemRunner } from "./core/proc.ts";
export const VERSION = "gistan 0.4.0";
export const COMMAND_DESCRIPTIONS: Record<CommandName, string> = {
  new: "Create a file under gists/<dir>/.",
  search: "Document-unit search across gists and stars.",
  grep: "Line-level regex grep across gists and stars.",
  edit: "Open a gist file.",
  list: "List gist directories.",
  rm: "Delete a gist file.",
  publish: "Publish/update a gist directory.",
  unpublish: "Delete remote gist, keep local dir.",
  pull: "Pull remote gist files.",
  status: "Show drift status; --fix repairs.",
  import: "Import existing gists.",
  root: "Manage the gist repo: init / path / commit / push / pull / status.",
  star: "Manage the star mirror: sync / add <url>.",
};
const COMMANDS: Record<CommandName, CommandHandler> = {
  new: runNew,
  search: runSearch,
  grep: runGrep,
  edit: runEdit,
  list: runList,
  rm: runRm,
  publish: runPublish,
  unpublish: runUnpublish,
  pull: runPull,
  status: runStatus,
  import: runImport,
  root: runRoot,
  star: runStar,
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
  return `gistan - manage a repo-backed gist collection\n\nUsage:\n  gistan [--help|-h]\n  gistan --version\n  gistan <command> [args...]\n  gistan <anything else>      Sugar: falls back to \`gistan search <args>\`.\n\nCommands:\n${
    Object.entries(COMMAND_DESCRIPTIONS).map(([n, d]) => `  ${n.padEnd(10)} ${d}`).join("\n")
  }\n`;
}
export function resolveCommand(name: string | undefined): CommandName | undefined {
  if (name === undefined) return undefined;
  return Object.hasOwn(COMMAND_DESCRIPTIONS, name) ? name as CommandName : undefined;
}
/**
 * Dispatch is decided on argv[0] BEFORE any flag parsing (TASK-260708): the
 * old code ran std parseArgs first, which happily swallowed a leading flag
 * like `-p` meant for `search` (`gistan -p foo` never reached search). Order
 * matters here — removed-command hints must win over the search fallback so
 * `gistan init` still guides the user instead of quietly opening fzf.
 */
export async function run(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const context = options.context ?? defaultContext();
  const commands = { ...COMMANDS, ...options.commands };
  const [first, ...rest] = argv;

  if (first === undefined) {
    return await commands.search({ name: "search", args: [] }, context);
  }
  if (first === "-h" || first === "--help") {
    await writeText(context.stdout, usage());
    return 0;
  }
  if (first === "--version") {
    await writeText(context.stdout, `${VERSION}\n`);
    return 0;
  }
  if (Object.hasOwn(REMOVED_COMMAND_HINTS, first)) {
    await writeText(context.stderr, REMOVED_COMMAND_HINTS[first]);
    return 2;
  }
  // Hidden renderers behind `gistan search` / `gistan grep` (fzf's reload
  // and preview binds call them on every keystroke); deliberately absent
  // from COMMAND_DESCRIPTIONS/usage and dispatched before the search
  // fallback would swallow them.
  if (first === "__search-render") {
    return await runSearchRender(rest, context);
  }
  if (first === "__preview") {
    return await runPreviewRender(rest, context);
  }
  const commandName = resolveCommand(first);
  if (commandName !== undefined) {
    return await commands[commandName]({ name: commandName, args: rest }, context);
  }
  // Full sugar fallback: an unrecognized first argument (including a leading
  // flag like `-p`) is not a usage error — the whole argv goes to search
  // untouched, so `gistan -p foo` behaves as `gistan search -p foo`.
  return await commands.search({ name: "search", args: [...argv] }, context);
}
if (import.meta.main) Deno.exit(await run(Deno.args));
