import { LIST_CMD, runQueryUi } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";

/**
 * Line-level regex grep, kept when `gistan search` moved to document-unit
 * matching (TASK-260708 followup 2): the query here is one rg regex re-run
 * on every keystroke, so it still serves "find the exact line" sessions the
 * document mode intentionally gave up.
 *
 * Empty query = file list (title-level browsing); any input = live full-text
 * grep. No minimum query length — CJK queries are often a single meaningful
 * character.
 *
 * Everything around the reload command — fzf session, binds, selection
 * handling, and the __preview self-invocation (spans from `rg --json`,
 * anchored to the selected row's line {2}) — is runQueryUi (shared.ts),
 * shared verbatim with search.
 */

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

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  return await runQueryUi(command, context, RELOAD_CMD);
}
