import { descriptionFor, displayPath } from "../core/display.ts";
import { loadDescriptionsSafe } from "./actions.ts";
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
 * resolution happens here. Output rows use the shared 3-field protocol
 * (see runQueryUi): `real\tline\tdisplay:line: excerpt` for content hits,
 * `real\t\tdisplay` for path-only hits — fzf shows field 3+ only, so gist
 * ids stay hidden (ADR-0003) while every bind still gets the real path.
 * Descriptions (from the index / star cache) both count as match targets and
 * ride along as a dim suffix, disambiguating same-named files across gists.
 */

const HIGHLIGHT = "\x1b[1;31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** ~chars of context kept on each side of the first term hit in an excerpt. */
const EXCERPT_RADIUS = 60;

/**
 * The one place the query syntax is parsed (also used by __preview):
 * whitespace-split terms, `!term` = exclusion, everything is a literal.
 */
export function parseTerms(query: string): { positives: string[]; negatives: string[] } {
  const terms = query.split(/\s+/).filter((term) => term !== "");
  return {
    positives: terms.filter((term) => !term.startsWith("!")),
    negatives: terms.filter((term) => term.startsWith("!"))
      .map((term) => term.slice(1))
      .filter((term) => term !== ""),
  };
}

export async function runSearchRender(
  args: readonly string[],
  context: CommandContext,
): Promise<number> {
  const query = args.join(" ");
  const { positives, negatives } = parseTerms(query);

  // Enumeration, metadata loading, and every independent content search start
  // together. Only the cheap metadata merge below needs the complete file list.
  const filesPromise = listFiles(context);
  const descriptionsPromise = loadDescriptionsSafe();
  const contentSetsPromise = positives.length === 0
    ? Promise.resolve([] as Set<string>[])
    : Promise.all([...positives, ...negatives].map((term) => rgFilesMatching(context, term)));
  const [files, descriptions, contentSets] = await Promise.all([
    filesPromise,
    descriptionsPromise,
    contentSetsPromise,
  ]);
  const describe = (file: string) => descriptionFor(descriptions, file);

  // Zero positive terms (empty query, or only exclusions) = plain file list.
  if (positives.length === 0) {
    const rows = [...files]
      .map((file) => ({ file, display: displayPath(file) }))
      .sort((a, b) => compare(a.display, b.display))
      .map(({ file, display }) => `${file}\t\t${display}${descSuffix(describe(file), [])}`);
    return await emit(context, rows);
  }

  // File-level AND across positive terms, minus every negative term's set.
  const termSets = [...positives, ...negatives].map((term, index) =>
    mergeMetadataMatches(contentSets[index], term, files, describe)
  );
  let candidates = termSets[0];
  for (const set of termSets.slice(1, positives.length)) {
    candidates = new Set([...candidates].filter((file) => set.has(file)));
  }
  for (const set of termSets.slice(positives.length)) {
    candidates = new Set([...candidates].filter((file) => !set.has(file)));
  }

  const hits = await firstHits(context, positives, [...candidates]);
  // The only ranking that exists (deliberately no scoring beyond this):
  // files whose display path OR description contains a positive term form
  // the first tier — both are stronger signals than a body hit (the
  // description plays the disambiguation role dirnames used to, ADR-0003).
  // Within each tier the order stays display-path ascending, so results
  // remain deterministic and gist-clustered.
  const inMeta = (display: string, desc: string) => {
    const lower = `${display}\n${desc}`.toLowerCase();
    return positives.some((term) => lower.includes(term.toLowerCase()));
  };
  const rows = [...candidates]
    .map((file) => ({
      file,
      display: displayPath(file),
      desc: describe(file),
      hit: hits.get(file),
    }))
    .sort((a, b) => {
      const tier = Number(!inMeta(a.display, a.desc)) - Number(!inMeta(b.display, b.desc));
      if (tier !== 0) return tier;
      return compare(a.display, b.display);
    })
    .map(({ file, display, desc, hit }) =>
      hit === undefined
        // Path/description-only match: the term(s) never occur in the body.
        ? `${file}\t\t${highlight(display, positives, "")}${descSuffix(desc, positives)}`
        : `${file}\t${hit.line}\t${highlight(display, positives, "")}:${DIM}${hit.line}${RESET}: ` +
          `${DIM}${highlight(excerpt(hit.text, positives), positives, DIM)}${RESET}` +
          descSuffix(desc, positives)
    );
  return await emit(context, rows);
}

function descSuffix(desc: string, positives: readonly string[]): string {
  if (desc === "") return "";
  return `  ${DIM}— ${highlight(desc, positives, DIM)}${RESET}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function emit(context: CommandContext, rows: readonly string[]): Promise<number> {
  if (rows.length > 0) await writeText(context.stdout, rows.join("\n") + "\n");
  return 0;
}

/**
 * All rg calls tolerate non-zero exits: 1 means "no match" and 2 can still
 * carry partial results (e.g. stars/ missing) — same stance as the old
 * `|| true` reload pipelines. Whatever stdout arrived is the answer.
 */
async function listFiles(context: CommandContext): Promise<string[]> {
  const result = await context.runner("rg", ["--files", "--no-ignore", "gists", "stars"]);
  // A tab would corrupt the 3-field row protocol (see runQueryUi), so such
  // paths cannot be represented — drop them (`gistan new` refuses to create
  // them; this guards hand-made ones).
  return result.stdout.split("\n").filter((line) => line !== "" && !line.includes("\t"));
}

/** Content matches for one term (rg -li; fixed-string, case-insensitive). */
async function rgFilesMatching(
  context: CommandContext,
  term: string,
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
  return new Set(result.stdout.split("\n").filter((line) => line !== ""));
}

/** Merge filename/description hits after enumeration and all rg calls finish. */
function mergeMetadataMatches(
  contentMatches: ReadonlySet<string>,
  term: string,
  files: readonly string[],
  describe: (file: string) => string,
): Set<string> {
  const set = new Set(contentMatches);
  const needle = term.toLowerCase();
  for (const file of files) {
    if (
      displayPath(file).toLowerCase().includes(needle) ||
      describe(file).toLowerCase().includes(needle)
    ) set.add(file);
  }
  return set;
}

/**
 * One rg run over the surviving files gives each file's first line matching
 * any positive term (`path:line:text`, --max-count=1 per file). -H forces
 * the path prefix even when only one file survives. Files absent from the
 * output had metadata-only matches.
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
