import { parseArgs } from "@std/cli/parse-args";
import { resolve } from "@std/path";
import { checkDeps, DEPS } from "../core/deps.ts";
import {
  browseBind,
  detectBat,
  FZF_ABORTED,
  FZF_NO_MATCH,
  LAYOUT,
  openEditor,
  PREVIEW_SCROLL_BIND,
  PREVIEW_WINDOW,
  requireConfig,
  selfCommand,
  toRelPath,
  viewerBind,
  writeGistMapFile,
} from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

/**
 * Line-level regex grep, kept when `gistan search` moved to document-unit
 * fzf-native matching (TASK-260708 followup 2): the query here is one rg
 * regex re-run on every keystroke, so it still serves "find the exact line"
 * sessions the document mode intentionally gave up.
 *
 * fzf re-runs this on every keystroke. Empty query = file list (title-level
 * browsing); any input = live full-text grep. No minimum query length — CJK
 * queries are often a single meaningful character. stars/ is gitignored (a
 * cache), so --no-ignore insures it is never dropped from results, whatever
 * a given rg version's ignore semantics for explicit path arguments are.
 */
const LIST_CMD = "rg --files --no-ignore gists stars";

/**
 * Query mode concatenates filename/dirname hits before content-grep hits,
 * then strips the `gists/` display prefix (`stars/` stays — it marks
 * star-mirror results) and re-applies highlighting in one final pass.
 * Coloring the raw grep output first and stripping after does NOT work:
 * rg's --color=always wraps the whole matched path segment in ANSI codes,
 * so a plain `sed 's|^gists/||'` anchor silently fails to match whenever
 * the path itself is what matched (verified against real rg/sed). Doing the
 * strip on uncolored text, then a single `rg -i --color=always` pass over
 * the combined stream, sidesteps that entirely.
 */
const FILE_HITS = `${LIST_CMD} | rg -i -- {q}`;
const CONTENT_HITS =
  "rg --column --line-number --no-heading --smart-case --no-ignore -- {q} gists stars";
// Sort by path so directories cluster, still on the uncolored stream. Key 2
// is the line number: a filename hit has no `:line:` (empty key = numeric 0),
// so it lands right before that same file's content hits in ascending line
// order.
const GREP_CMD = `{ ${FILE_HITS}; ${CONTENT_HITS}; } | sed 's|^gists/||' | ` +
  "sort -t: -k1,1 -k2,2n | rg -i --color=always -- {q} || true";
const RELOAD_CMD =
  `if [ -n {q} ]; then ${GREP_CMD}; else ${LIST_CMD} | sed 's|^gists/||' | sort; fi`;

// The preview is a gistan self-invocation (see preview_render.ts): the whole
// file with {q}'s rg matches emphasized (spans come from `rg --json`), bat
// syntax highlighting when installed, scrolled ~5 lines above the selected
// row's own line {2} — empty for filename hits, where it falls back to the
// first content match. An fzf `--preview-window '+{2}-5'` offset was tried
// and silently drops the preview for empty {2} (verified in a real session).

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
      await err(`error: ${dep.name} is required for ${command.name} — ${dep.hint}\n`);
    }
    return 1;
  }

  const query = flags._.map(String).join(" ");
  const bat = (await detectBat(context.runner)) ? "bat" : "nobat";
  const previewCmd = selfCommand(
    Deno.execPath(),
    Deno.mainModule,
    `__preview grep ${bat} {q} {1} {2}`,
  );
  const mapFile = await writeGistMapFile(config.repo);
  let picked;
  try {
    picked = await context.runner("fzf", [
      "--ansi",
      "--disabled", // fzf does no filtering itself; rg (via reload) is the matcher
      "--layout",
      LAYOUT,
      "--query",
      query,
      "--delimiter",
      ":",
      "--bind",
      `start:reload:${RELOAD_CMD}`,
      "--bind",
      `change:reload:${RELOAD_CMD}`,
      "--bind",
      PREVIEW_SCROLL_BIND,
      "--bind",
      browseBind(mapFile),
      ...(config.viewer === undefined ? [] : ["--bind", viewerBind(config.viewer)]),
      "--preview-window",
      PREVIEW_WINDOW,
      "--preview",
      previewCmd,
    ], { cwd: config.repo });
  } finally {
    // The map is only meaningful while fzf is running; never leave it behind.
    await Deno.remove(mapFile).catch(() => {});
  }

  if (picked.code === FZF_NO_MATCH || picked.code === FZF_ABORTED) {
    return 0;
  }
  if (picked.code !== 0) {
    await err(`error: fzf failed: ${picked.stderr.trim() || `exit ${picked.code}`}\n`);
    return 1;
  }

  const selection = picked.stdout.split("\n").at(0)?.trim() ?? "";
  if (selection === "") {
    return 0;
  }
  // Displayed paths have `gists/` stripped for readability; restore the real
  // repo-relative path before touching the filesystem.
  const [displayPath, line] = selection.split(":");
  const path = toRelPath(displayPath);
  if (flags.path) {
    await out(`${resolve(config.repo, path)}\n`);
    return 0;
  }
  return await openEditor(context, config.repo, path, line);
}
