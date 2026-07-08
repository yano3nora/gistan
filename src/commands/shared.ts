import { basename } from "@std/path";
import type { Config } from "../core/config.ts";
import { loadConfig } from "../core/config.ts";
import { gistUrl } from "../core/gh.ts";
import { loadState } from "../core/state.ts";
import type { CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

/** Loads the config or explains how to get one; callers return 1 on undefined. */
export async function requireConfig(context: CommandContext): Promise<Config | undefined> {
  const config = await loadConfig(context.configPath);
  if (config === undefined) {
    await writeText(context.stderr, "error: gistan is not initialized — run `gistan root init`\n");
  }
  return config;
}

/** CLI args accept bare filenames; the index always keys on repo-relative paths. */
export function toRelPath(arg: string): string {
  return arg.startsWith("gists/") || arg.startsWith("stars/") ? arg : `gists/${arg}`;
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

const LIST_CMD = "rg --files --no-ignore gists stars";

/** Fuzzy file pick; path === undefined means the user left without choosing. */
export async function pickFile(
  context: CommandContext,
  repo: string,
  query: string,
): Promise<{ path?: string; failed: boolean }> {
  const picked = await context.runner("fzf", [
    "--query",
    query,
    "--bind",
    `start:reload:${LIST_CMD}`,
    "--preview",
    "head -40 {}",
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
  const path = picked.stdout.split("\n").at(0)?.trim();
  return { path: path === "" ? undefined : path, failed: false };
}

/**
 * shift-up / shift-down scroll the preview pane; ctrl-u clears the query
 * (readline muscle memory — an earlier ctrl-u:preview-scroll bind shadowed
 * it and got in the way of retyping a search). Shared by search and grep.
 */
export const PREVIEW_SCROLL_BIND =
  "shift-up:preview-half-page-up,shift-down:preview-half-page-down,ctrl-u:clear-query";

const OPENER = Deno.build.os === "darwin" ? "open" : "xdg-open";

/**
 * ctrl-o opens the selected item's gist in the browser without leaving fzf
 * (search and grep share this bind). The dirname -> gist id mapping comes
 * from a temp file (one "dirname\tid" line per index entry, see
 * writeGistMapFile) so the bind's sh only needs an awk lookup — no JSON
 * parsing in shell. Unpublished dirs (absent from the map) and stars/ paths
 * are silent no-ops; stars will need the v3 `stars/<owner>/<gist-id>/`
 * layout to derive an id from the path (tracked in TASK-260706). {1} is the
 * gists/-stripped display path with either delimiter (`:` in grep, tab in
 * search): the first segment up to `/` is the dirname in both. The body
 * deliberately contains no parentheses or brackets (backticks instead of
 * `$()`, `test` instead of `[`): fzf's execute-silent(...) arg parsing
 * chokes on unbalanced delimiters inside the body.
 */
export function browseBind(mapFile: string): string {
  return 'ctrl-o:execute-silent(p={1}; d=${p%%/*}; test "$d" = stars && exit 0; ' +
    `id=\`awk -F'\\t' -v d="$d" '$1==d {print $2}' "${mapFile}"\`; ` +
    `test -n "$id" && ${OPENER} "${gistUrl("$id")}" || true)`;
}

/**
 * Writes the dirname -> gist id map consumed by browseBind's awk lookup.
 * Callers must remove the returned temp file once fzf exits (a write failure
 * cleans up here so they never see a half-created file).
 */
export async function writeGistMapFile(repo: string): Promise<string> {
  const state = await loadState(repo);
  const mapFile = await Deno.makeTempFile({ prefix: "gistan-search-", suffix: ".tsv" });
  try {
    await Deno.writeTextFile(
      mapFile,
      Object.entries(state.gists).map(([dirname, entry]) => `${dirname}\t${entry.id}\n`).join(""),
    );
  } catch (error) {
    await Deno.remove(mapFile).catch(() => {});
    throw error;
  }
  return mapFile;
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
