import { runCopyAction, runListRender, runOpenAction } from "./commands/actions.ts";
import { run as runEdit } from "./commands/edit.ts";
import { run as runGrep } from "./commands/grep.ts";
import { runGrepRender } from "./commands/grep_render.ts";
import { run as runImport } from "./commands/import.ts";
import { run as runList } from "./commands/list.ts";
import { run as runNew } from "./commands/new.ts";
import { run as runPublish } from "./commands/publish.ts";
import { run as runPull } from "./commands/pull.ts";
import { run as runPush } from "./commands/push.ts";
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
export const VERSION = "gistan 0.8.0";
export const COMMAND_DESCRIPTIONS: Record<CommandName, string> = {
  new: "Create a file in a new gist dir (--id adds to an existing one).",
  search: "Document-unit search across gists and stars.",
  grep: "Line-level regex grep across gists and stars.",
  edit: "Open a gist file.",
  list: "List gist files.",
  rm: "Delete a gist file.",
  publish: "Create/update a gist by id or URL.",
  unpublish: "Delete the remote gist by id or URL, keep local files.",
  push: "Push every locally drifted gist (one confirm). Repo git push = `root push`.",
  pull: "Pull every remotely drifted gist (one confirm). Repo git pull = `root pull`.",
  status: "Show drift status; --fix repairs and resolves conflicts.",
  import: "Import existing gists into gists/<gist-id>/.",
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
  push: runPush,
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
  return `gistan - manage a repo-backed gist collection\n\nUsage:\n  gistan [--help|-h]\n  gistan --version\n  gistan [--editor|-e <command>] <command> [args...]\n  gistan [--editor|-e <command>] <anything else>\n+                              Sugar: falls back to \`gistan search <args>\`.\n\nOptions:\n  -e, --editor <command>       Override $EDITOR for this invocation.\n\nCommands:\n${
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
  const baseContext = options.context ?? defaultContext();
  const editorOption = extractEditorOption(argv);
  if (editorOption.error !== undefined) {
    await writeText(baseContext.stderr, `error: ${editorOption.error}\n`);
    return 2;
  }
  const context = editorOption.editor === undefined
    ? baseContext
    : { ...baseContext, editor: editorOption.editor };
  const commands = { ...COMMANDS, ...options.commands };
  try {
    return await dispatch(editorOption.argv, commands, context);
  } catch (error) {
    // Commands wrap their own expected failures; whatever still reaches here
    // (an unreadable index, a bug) must exit with one friendly line, not a
    // stack trace — direct repo manipulation must never crash the CLI.
    await writeText(
      context.stderr,
      `error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

interface EditorOption {
  readonly argv: readonly string[];
  readonly editor?: string;
  readonly error?: string;
}

/**
 * Extracts the invocation-wide editor override before command dispatch so it
 * works for explicit commands and search sugar alike. Only the first option is
 * consumed; the editor is an executable path/name, not a shell command string.
 */
function extractEditorOption(argv: readonly string[]): EditorOption {
  const rest: string[] = [];
  let editor: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-e" || arg === "--editor") {
      if (editor !== undefined) return { argv: rest, error: `${arg} specified more than once` };
      const value = argv[++i];
      if (value === undefined || value === "") {
        return { argv: rest, error: `${arg} requires an editor command` };
      }
      editor = value;
      continue;
    }
    if (arg.startsWith("--editor=")) {
      if (editor !== undefined) return { argv: rest, error: "--editor specified more than once" };
      editor = arg.slice("--editor=".length);
      if (editor === "") return { argv: rest, error: "--editor requires an editor command" };
      continue;
    }
    rest.push(arg);
  }
  return { argv: rest, editor };
}

async function dispatch(
  argv: readonly string[],
  commands: Record<CommandName, CommandHandler>,
  context: CommandContext,
): Promise<number> {
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
  // Hidden renderers/actions behind search / grep / pickFile (fzf's reload,
  // preview and key binds call them); deliberately absent from
  // COMMAND_DESCRIPTIONS/usage and dispatched before the search fallback
  // would swallow them.
  if (first === "__search-render") {
    return await runSearchRender(rest, context);
  }
  if (first === "__grep-render") {
    return await runGrepRender(rest, context);
  }
  if (first === "__preview") {
    return await runPreviewRender(rest, context);
  }
  if (first === "__list") {
    return await runListRender(context);
  }
  if (first === "__open") {
    return await runOpenAction(rest, context);
  }
  if (first === "__copy") {
    return await runCopyAction(rest, context);
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
