import type { CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

/**
 * Hidden subcommand behind `gistan search` (TASK-260708 followup 3): fzf's
 * reload bind runs `<self> __search-render {q}` on every keystroke and this
 * renders the whole result list in TypeScript — term split, rg intersection,
 * excerpt windowing, ANSI coloring. Doing it here instead of a shell pipeline
 * kills the sh-quoting / zsh word-split / awk multibyte class of bugs and
 * makes every rule unit-testable.
 *
 * Query syntax (REPLACES fzf's operators — search-specific, Google-ish):
 * whitespace-separated terms are a file-level order-free AND; a leading `!`
 * excludes files containing that term; everything matches as a
 * case-insensitive LITERAL (no regex — `'` `^` `$` are ordinary characters).
 *
 * Runs with cwd = repo (fzf's reload inherits fzf's cwd), so no config
 * resolution happens here. Output: one row per file, display-path-sorted,
 * `<display path>:<line>: <excerpt>` for content hits or just the display
 * path for path-only hits. gists/ is stripped from display, stars/ kept.
 */

const HIGHLIGHT = "\x1b[1;31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** ~chars of context kept on each side of the first term hit in an excerpt. */
const EXCERPT_RADIUS = 60;

export async function runSearchRender(
  args: readonly string[],
  context: CommandContext,
): Promise<number> {
  const query = args.join(" ");
  const terms = query.split(/\s+/).filter((term) => term !== "");
  const positives = terms.filter((term) => !term.startsWith("!"));
  const negatives = terms.filter((term) => term.startsWith("!"))
    .map((term) => term.slice(1))
    .filter((term) => term !== "");

  const files = await listFiles(context);
  // Zero positive terms (empty query, or only exclusions) = plain file list.
  if (positives.length === 0) {
    return await emit(context, files.map(displayPath).sort());
  }

  // File-level AND across positive terms, minus every negative term's set.
  let candidates = await termSet(context, positives[0], files);
  for (const term of positives.slice(1)) {
    const set = await termSet(context, term, files);
    candidates = new Set([...candidates].filter((file) => set.has(file)));
  }
  for (const term of negatives) {
    const set = await termSet(context, term, files);
    candidates = new Set([...candidates].filter((file) => !set.has(file)));
  }

  const hits = await firstHits(context, positives, [...candidates]);
  const rows = [...candidates]
    .map((file) => ({ display: displayPath(file), hit: hits.get(file) }))
    .sort((a, b) => a.display < b.display ? -1 : a.display > b.display ? 1 : 0)
    .map(({ display, hit }) =>
      hit === undefined
        // Path-only match: the term(s) only occur in the path itself.
        ? highlight(display, positives, "")
        : `${highlight(display, positives, "")}:${DIM}${hit.line}${RESET}: ` +
          `${DIM}${highlight(excerpt(hit.text, positives), positives, DIM)}${RESET}`
    );
  return await emit(context, rows);
}

async function emit(context: CommandContext, rows: readonly string[]): Promise<number> {
  if (rows.length > 0) await writeText(context.stdout, rows.join("\n") + "\n");
  return 0;
}

function displayPath(path: string): string {
  return path.startsWith("gists/") ? path.slice("gists/".length) : path;
}

/**
 * All rg calls tolerate non-zero exits: 1 means "no match" and 2 can still
 * carry partial results (e.g. stars/ missing) — same stance as the old
 * `|| true` reload pipelines. Whatever stdout arrived is the answer.
 */
async function listFiles(context: CommandContext): Promise<string[]> {
  const result = await context.runner("rg", ["--files", "--no-ignore", "gists", "stars"]);
  return result.stdout.split("\n").filter((line) => line !== "");
}

/**
 * Files matching one term: content matches (rg -li; -F literal, -i
 * case-insensitive) UNION files whose display path contains the term — rg's
 * content search never looks at filenames, so dirname/filename hits must be
 * merged in explicitly.
 */
async function termSet(
  context: CommandContext,
  term: string,
  files: readonly string[],
): Promise<Set<string>> {
  const result = await context.runner("rg", [
    "-li",
    "--no-ignore",
    "-F",
    "--",
    term,
    "gists",
    "stars",
  ]);
  const set = new Set(result.stdout.split("\n").filter((line) => line !== ""));
  const needle = term.toLowerCase();
  for (const file of files) {
    if (displayPath(file).toLowerCase().includes(needle)) set.add(file);
  }
  return set;
}

/**
 * One rg run over the surviving files gives each file's first line matching
 * any positive term (`path:line:text`, --max-count=1 per file). -H forces
 * the path prefix even when only one file survives. Files absent from the
 * output had path-only matches.
 */
async function firstHits(
  context: CommandContext,
  terms: readonly string[],
  files: readonly string[],
): Promise<Map<string, { line: string; text: string }>> {
  const hits = new Map<string, { line: string; text: string }>();
  if (files.length === 0) return hits;
  const result = await context.runner("rg", [
    "-i",
    "-n",
    "-H",
    "--no-ignore",
    "--max-count=1",
    "-F",
    ...terms.flatMap((term) => ["-e", term]),
    "--",
    ...files,
  ]);
  for (const row of result.stdout.split("\n")) {
    if (row === "") continue;
    const first = row.indexOf(":");
    const second = row.indexOf(":", first + 1);
    if (first === -1 || second === -1) continue;
    hits.set(row.slice(0, first), {
      line: row.slice(first + 1, second),
      text: row.slice(second + 1),
    });
  }
  return hits;
}

/**
 * ~EXCERPT_RADIUS chars of context around the first (earliest) positive-term
 * occurrence, sliced via Array.from so CJK and surrogate pairs never split,
 * with `…` marking trimmed edges.
 */
export function excerpt(text: string, terms: readonly string[]): string {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  let hitAt = -1;
  let hitLen = 0;
  for (const term of terms) {
    const needle = term.toLowerCase();
    const at = lower.indexOf(needle);
    if (at !== -1 && (hitAt === -1 || at < hitAt)) {
      hitAt = at;
      hitLen = needle.length;
    }
  }
  if (hitAt === -1) {
    // Defensive: rg said this line matches, so a term should be here.
    const chars = Array.from(trimmed);
    if (chars.length <= EXCERPT_RADIUS * 2) return trimmed;
    return chars.slice(0, EXCERPT_RADIUS * 2).join("") + "…";
  }
  const before = Array.from(trimmed.slice(0, hitAt));
  const match = trimmed.slice(hitAt, hitAt + hitLen);
  const after = Array.from(trimmed.slice(hitAt + hitLen));
  const keepFrom = Math.max(0, before.length - EXCERPT_RADIUS);
  const keepTo = Math.min(after.length, EXCERPT_RADIUS);
  return (keepFrom > 0 ? "…" : "") + before.slice(keepFrom).join("") + match +
    after.slice(0, keepTo).join("") + (keepTo < after.length ? "…" : "");
}

/**
 * Wraps every case-insensitive occurrence of any term in the highlight
 * color. `resume` is the escape to re-enter after each RESET (DIM for
 * excerpt text, "" for default-colored paths) — a bare RESET would otherwise
 * cancel the surrounding style for the rest of the line. At equal positions
 * the longest term wins so overlapping terms don't half-highlight.
 */
export function highlight(text: string, terms: readonly string[], resume: string): string {
  const lower = text.toLowerCase();
  const needles = terms.map((term) => term.toLowerCase()).filter((term) => term !== "");
  if (needles.length === 0) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    let best = -1;
    let bestLen = 0;
    for (const needle of needles) {
      const at = lower.indexOf(needle, i);
      if (at === -1) continue;
      if (best === -1 || at < best || (at === best && needle.length > bestLen)) {
        best = at;
        bestLen = needle.length;
      }
    }
    if (best === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, best) + HIGHLIGHT + text.slice(best, best + bestLen) + RESET + resume;
    i = best + bestLen;
  }
  return out;
}
