import { parseArgs } from "@std/cli/parse-args";
import { basename, fromFileUrl, resolve } from "@std/path";
import { checkDeps, DEPS } from "../core/deps.ts";
import {
  browseBind,
  FZF_ABORTED,
  FZF_NO_MATCH,
  openEditor,
  PREVIEW_SCROLL_BIND,
  requireConfig,
  toRelPath,
  writeGistMapFile,
} from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

/**
 * Document-unit search, list rendered per keystroke (TASK-260708 followup 3):
 * fzf runs `--disabled --ansi` and the reload bind calls gistan itself —
 * `<self> __search-render {q}` (see search_render.ts) — which does the term
 * split / rg intersection / excerpt / coloring entirely in TypeScript. The
 * fzf-native matching of followup 2 could only display the raw item string,
 * so a hit deep in the flattened content horizontally scrolled the path off
 * screen; a query-time rendered `path:line: excerpt` list needs reload, and
 * self-invocation avoids re-growing fragile shell pipelines.
 *
 * Query syntax is search-specific (not fzf's): space = file-level order-free
 * AND, `!term` = exclude, terms are case-insensitive literals.
 */

/**
 * The reload command that re-invokes this gistan. Under `deno run` (dev)
 * execPath is the deno binary, so the entrypoint module and the permissions
 * the renderer needs must be spelled out; a compiled binary just calls
 * itself. Paths are quoted for fzf's $SHELL -c. Pure so both shapes are
 * unit-testable without touching the real globals.
 */
export function selfRenderCommand(execPath: string, mainModule: string): string {
  if (basename(execPath) === "deno") {
    return `"${execPath}" run --allow-read --allow-run --allow-env ` +
      `"${fromFileUrl(mainModule)}" __search-render {q}`;
  }
  return `"${execPath}" __search-render {q}`;
}

/**
 * Preview highlights every positive query term over the whole file, aligned
 * ~5 lines above the first matching line. The shell strips query operators
 * from {q} into a pattern file (one literal per line: `!term` lines dropped,
 * leading `'`/`^` and trailing `$` stripped, `|` and blanks dropped — a
 * superset of the current `!term`-only syntax, kept as-is) so a single
 * `rg -F -f` pass does the highlighting; an empty pattern file (empty query)
 * falls back to plain cat. Terms are split with `tr`, NOT unquoted word
 * splitting: fzf runs previews via $SHELL -c and zsh does not word-split
 * unquoted expansions (caught in a live fzf run), while tr behaves the same
 * in sh/bash/zsh and keeps glob-y terms like `*.md` literal for free.
 * Guards: empty {1} (empty list) and vanished files exit 0 silently.
 */
function docPreviewCmd(patternFile: string): string {
  return 'f={1}; [ -f "$f" ] || f="gists/$f"; [ -f "$f" ] || exit 0; ' +
    "printf '%s' {q} | tr -s ' \\t' '\\n' | " +
    `sed -e '/^!/d' -e "s/^'//" -e 's/^\\^//' -e 's/\\$$//' -e '/^|$/d' -e '/^$/d' > ` +
    `"${patternFile}"; ` +
    `if [ -s "${patternFile}" ]; then ` +
    `ln=$(rg -in --max-count=1 -F -f "${patternFile}" -- "$f" 2>/dev/null | head -1 | cut -d: -f1); ` +
    'off=1; [ -n "$ln" ] && [ "$ln" -gt 5 ] 2>/dev/null && off=$((ln - 5)); ' +
    `rg --color=always --passthru -i -F -f "${patternFile}" -- "$f" 2>/dev/null | tail -n +$off; ` +
    'else cat "$f"; fi';
}

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
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
      await err(`error: ${dep.name} is required for search — ${dep.hint}\n`);
    }
    return 1;
  }

  const query = flags._.map(String).join(" ");
  const reloadCmd = selfRenderCommand(Deno.execPath(), Deno.mainModule);
  const mapFile = await writeGistMapFile(config.repo);
  let patternFile: string | undefined;
  let picked;
  try {
    patternFile = await Deno.makeTempFile({ prefix: "gistan-search-", suffix: ".pat" });
    picked = await context.runner("fzf", [
      "--ansi",
      "--disabled", // fzf does no filtering itself; __search-render is the matcher
      "--query",
      query,
      "--delimiter",
      ":",
      "--bind",
      `start:reload:${reloadCmd}`,
      "--bind",
      `change:reload:${reloadCmd}`,
      "--bind",
      PREVIEW_SCROLL_BIND,
      "--bind",
      browseBind(mapFile),
      "--preview",
      docPreviewCmd(patternFile),
    ], { cwd: config.repo });
  } finally {
    // Both temp files only matter while fzf is running; never leave them behind.
    await Deno.remove(mapFile).catch(() => {});
    if (patternFile !== undefined) await Deno.remove(patternFile).catch(() => {});
  }

  if (picked.code === FZF_NO_MATCH || picked.code === FZF_ABORTED) {
    return 0;
  }
  if (picked.code !== 0) {
    await err(`error: fzf failed: ${picked.stderr.trim() || `exit ${picked.code}`}\n`);
    return 1;
  }

  // fzf strips the renderer's ANSI codes before printing the selection
  // (--ansi, verified against a real session), so this is plain
  // "display_path:line: excerpt" — or just the path for path-only rows.
  const selection = picked.stdout.split("\n").at(0)?.trim() ?? "";
  if (selection === "") {
    return 0;
  }
  const [displayPath, line] = selection.split(":");
  const path = toRelPath(displayPath);
  if (flags.path) {
    await out(`${resolve(config.repo, path)}\n`);
    return 0;
  }
  return await openEditor(context, config.repo, path, line);
}
