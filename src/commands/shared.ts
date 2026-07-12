import { parseArgs } from "@std/cli/parse-args";
import { basename, fromFileUrl, resolve } from "@std/path";
import type { Config } from "../core/config.ts";
import { loadConfig } from "../core/config.ts";
import { checkDeps, DEPS } from "../core/deps.ts";
import type { Runner } from "../core/proc.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

/** Loads the config or explains how to get one; callers return 1 on undefined. */
export async function requireConfig(context: CommandContext): Promise<Config | undefined> {
  const config = await loadConfig(context.configPath);
  if (config === undefined) {
    await writeText(context.stderr, "error: gistan is not initialized — run `gistan root init`\n");
  }
  return config;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

/** fzf exit codes that mean "the user just left without picking" — not errors. */
export const FZF_NO_MATCH = 1;
export const FZF_ABORTED = 130;

/**
 * The row protocol every fzf list in gistan speaks (ADR-0003): renderers emit
 * `real_path \t line \t display...` and fzf gets `--delimiter TAB
 * --with-nth 3..`, so the user sees only the id-less display fields while
 * every bind and the final selection still carry the real repo path in {1}
 * (and the anchor line, possibly empty, in {2}). This is what lets display
 * paths drop gist ids without any display->path reverse lookup.
 */
export const FIELD_DELIMITER = "\t";
export const DISPLAY_FIELDS = "3..";

/** Fuzzy file pick (edit / rm); path === undefined means the user left without choosing. */
export async function pickFile(
  context: CommandContext,
  repo: string,
  query: string,
): Promise<{ path?: string; failed: boolean }> {
  const listCmd = selfCommand(Deno.execPath(), Deno.mainModule, "__list");
  const picked = await context.runner("fzf", [
    "--query",
    query,
    "--delimiter",
    FIELD_DELIMITER,
    "--with-nth",
    DISPLAY_FIELDS,
    "--bind",
    `start:reload:${listCmd}`,
    "--preview",
    "head -40 {1}",
  ], { cwd: repo });
  if (picked.code === FZF_NO_MATCH || picked.code === FZF_ABORTED) {
    return { failed: false };
  }
  if (picked.code !== 0) {
    await writeText(
      context.stderr,
      `error: fzf failed: ${picked.stderr.trim() || `exit ${picked.code}`}\n`,
    );
    return { failed: true };
  }
  const path = picked.stdout.split("\n").at(0)?.split(FIELD_DELIMITER).at(0)?.trim();
  return { path: path === "" ? undefined : path, failed: false };
}

/**
 * shift-up / shift-down scroll the preview pane; ctrl-u clears the query
 * (readline muscle memory — an earlier ctrl-u:preview-scroll bind shadowed
 * it and got in the way of retyping a search); ctrl-/ toggles preview line
 * wrapping (fzf previews cannot scroll horizontally, so unwrapped is only
 * useful to keep code/table alignment readable — hence wrap is the default,
 * see PREVIEW_WINDOW). ctrl-w stays fzf's delete-word. Shared by search
 * and grep.
 */
export const PREVIEW_SCROLL_BIND =
  "shift-up:preview-half-page-up,shift-down:preview-half-page-down,ctrl-u:clear-query," +
  "ctrl-/:toggle-preview-wrap";

/**
 * Long prose lines (the common case in a notes repo) must not run off the
 * pane: fzf previews have no horizontal scrolling at all, so without wrap
 * the overflow is simply unreachable. ctrl-/ toggles it off per session.
 */
export const PREVIEW_WINDOW = "wrap";

/**
 * The result list is path-sorted, not relevance-ranked (fzf runs --disabled;
 * the renderers emit display-path order so gists cluster). fzf's
 * stock bottom-up layout would show that list Z→A from the top of the
 * screen, so pin top-down explicitly — first row and cursor at the top —
 * instead of leaving it to whatever FZF_DEFAULT_OPTS happens to say.
 */
export const LAYOUT = "reverse";

/**
 * ctrl-o opens the selected item's gist in the browser, ctrl-y copies its
 * URL (published / star) or local id (unpublished) — the handoff into
 * `publish <id>` etc. (ADR-0003). Both re-invoke gistan ({1} = the hidden
 * real-path field) so the published-or-not decision lives in TypeScript,
 * not in an awk-over-tempfile lookup like the pre-v3 bind. ctrl-y, not
 * ctrl-c: fzf reserves ctrl-c for abort.
 */
export function openBind(selfOpenCmd: string): string {
  return `ctrl-o:execute-silent(${selfOpenCmd})`;
}

export function copyBind(selfCopyCmd: string): string {
  return `ctrl-y:execute-silent(${selfCopyCmd})`;
}

/**
 * ctrl-v ("view") hands the selected file to the user's configured viewer
 * command (config.toml `viewer`, e.g. a markdown reader) without leaving
 * fzf: execute() suspends fzf, the viewer takes the terminal, and quitting
 * it drops back into the result list — a browse/read loop. ctrl-v is unbound
 * in stock fzf and free of muscle-memory collisions (ctrl-t is the fzf
 * shell file-widget, ctrl-o/ctrl-y are our binds). {1} is the hidden
 * real-path field; an empty {1} or a vanished file is a silent no-op. The
 * body deliberately contains no parentheses or brackets (`test` instead of
 * `[`): fzf's execute(...) arg parsing chokes on unbalanced delimiters —
 * which also means a viewer command containing them would break the bind;
 * not guarded, just avoid it.
 */
export function viewerBind(viewer: string): string {
  return `ctrl-v:execute(test -f {1} && ${viewer} {1})`;
}

/** Whether bat is installed — picks the `bat|nobat` token in __preview commands. */
export async function detectBat(runner: Runner): Promise<boolean> {
  const report = await checkDeps(runner, DEPS.filter((dep) => dep.name === "bat"));
  return report.present.length > 0;
}

/**
 * A command string that re-invokes this gistan with `tail` appended — for
 * fzf binds that call back into the CLI (`__search-render`, `__preview`,
 * `__open`, `__copy`, `__list`). Under `deno run` (dev) execPath is the deno
 * binary, so the entrypoint module and the permissions the renderers need
 * must be spelled out; a compiled binary just calls itself. Paths are quoted
 * for fzf's $SHELL -c.
 */
export function selfCommand(execPath: string, mainModule: string, tail: string): string {
  if (basename(execPath) === "deno") {
    return `"${execPath}" run --allow-read --allow-run --allow-env ` +
      `"${fromFileUrl(mainModule)}" ${tail}`;
  }
  return `"${execPath}" ${tail}`;
}

/**
 * vim-family editors get a line jump and -R for stars/ (read-only mirrors,
 * SPEC-0001); other editors just get the file — flags are not portable.
 */
export function editorArgs(editor: string, path: string, line?: string): string[] {
  if (!["vi", "vim", "nvim"].includes(basename(editor))) {
    return [path];
  }
  const args = line === undefined ? [path] : [`+${line}`, path];
  return path.startsWith("stars/") ? ["-R", ...args] : args;
}

export async function openEditor(
  context: CommandContext,
  repo: string,
  path: string,
  line?: string,
): Promise<number> {
  const opened = await context.runner(context.editor, editorArgs(context.editor, path, line), {
    cwd: repo,
    interactive: true,
  });
  return opened.code;
}

/**
 * The interactive query session `search` and `grep` share end-to-end:
 * config + rg/fzf presence checks, the fzf invocation (--disabled: the
 * reload command is the matcher, fzf only displays; the 3-field row
 * protocol hides ids, see FIELD_DELIMITER), and the selection handling
 * (`--path`/-p prints the absolute path, anything else opens the editor at
 * the row's line). The commands differ only in the reload command that
 * renders the list — and, derived from command.name, the __preview argv
 * (grep passes the selected row's line field {2} as the preview anchor;
 * search leaves it out, so its preview finds the first match itself).
 */
export async function runQueryUi(
  command: CommandArgs,
  context: CommandContext,
  reloadCmd: string,
): Promise<number> {
  const err = (text: string) => writeText(context.stderr, text);
  const out = (text: string) => writeText(context.stdout, text);
  const flags = parseArgs([...command.args], { boolean: ["path"], alias: { p: "path" } });

  const config = await requireConfig(context);
  if (config === undefined) {
    return 1;
  }

  const needed = DEPS.filter((dep) => dep.name === "rg" || dep.name === "fzf");
  const report = await checkDeps(context.runner, needed);
  const missing = [...report.missingRequired, ...report.missingOptional];
  if (missing.length > 0) {
    for (const dep of missing) {
      await err(`error: ${dep.name} is required for ${command.name} — ${dep.hint}\n`);
    }
    return 1;
  }

  const query = flags._.map(String).join(" ");
  const bat = (await detectBat(context.runner)) ? "bat" : "nobat";
  const previewTail = command.name === "grep" ? "{q} {1} {2}" : "{q} {1}";
  const self = (tail: string) => selfCommand(Deno.execPath(), Deno.mainModule, tail);
  const previewCmd = self(`__preview ${command.name} ${bat} ${previewTail}`);
  const picked = await context.runner("fzf", [
    "--ansi",
    "--disabled",
    "--layout",
    LAYOUT,
    "--query",
    query,
    "--delimiter",
    FIELD_DELIMITER,
    "--with-nth",
    DISPLAY_FIELDS,
    "--bind",
    `start:reload:${reloadCmd}`,
    "--bind",
    `change:reload:${reloadCmd}`,
    "--bind",
    PREVIEW_SCROLL_BIND,
    "--bind",
    openBind(self("__open {1}")),
    "--bind",
    copyBind(self("__copy {1}")),
    ...(config.viewer === undefined ? [] : ["--bind", viewerBind(config.viewer)]),
    "--preview-window",
    PREVIEW_WINDOW,
    "--preview",
    previewCmd,
  ], { cwd: config.repo });

  if (picked.code === FZF_NO_MATCH || picked.code === FZF_ABORTED) {
    return 0;
  }
  if (picked.code !== 0) {
    await err(`error: fzf failed: ${picked.stderr.trim() || `exit ${picked.code}`}\n`);
    return 1;
  }

  // fzf prints the whole original row (ANSI stripped by --ansi), hidden
  // fields included: `real \t line \t display...`. The real path needs no
  // display->path translation — that is the point of the protocol.
  const selection = picked.stdout.split("\n").at(0) ?? "";
  if (selection.trim() === "") {
    return 0;
  }
  const [path, line] = selection.split(FIELD_DELIMITER);
  if (flags.path) {
    await out(`${resolve(config.repo, path)}\n`);
    return 0;
  }
  return await openEditor(context, config.repo, path, line === "" ? undefined : line);
}
