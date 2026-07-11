import type { CommandContext } from "./types.ts";
import { writeText } from "./types.ts";
import { parseTerms } from "./search_render.ts";

/**
 * Hidden subcommand behind the fzf previews of `search` / `grep`:
 * `<self> __preview <mode> <bat|nobat> {q} {1} [{2}]` (fixed positional
 * protocol — {q} can start with `-`, so no flag parsing). Replaces the old
 * sh preview pipelines (pattern temp file + tr/sed + rg --passthru) for the
 * same reason __search-render exists: sh-quoting / zsh word-split bugs and
 * untestability. It also enables what those pipelines could not: bat's
 * syntax highlighting layered with match emphasis. Matches are marked with
 * reverse video (SGR 7/27), which swaps fg/bg without touching the color
 * state, so bat's colors survive around and inside the match; re-running rg
 * over bat output cannot do this (patterns don't match across ANSI codes).
 *
 * Runs with cwd = repo (fzf spawns previews in its own cwd). Guards mirror
 * the old pipelines: an empty or vanished path exits 0 silently. Output
 * starts ~5 lines above the anchor line — the selected row's line ({2},
 * grep) when present, else the first line containing a match.
 *
 * Modes: `search` finds every occurrence of each positive query term
 * (case-insensitive literals, same parse as __search-render) in TypeScript;
 * `grep` treats the query as one rg regex and takes match spans from
 * `rg --json` (byte offsets, converted to string indices) — re-implementing
 * rg's regex dialect in JS would drift, so rg stays the source of truth.
 */

const REVERSE = "\x1b[7m";
const REVERSE_OFF = "\x1b[27m";
/** Lines of context kept above the anchor line, as before. */
const CONTEXT_ABOVE = 5;

/** [start, end) in JS string (UTF-16) indices of the ANSI-stripped line. */
type Span = readonly [number, number];

export async function runPreviewRender(
  args: readonly string[],
  context: CommandContext,
): Promise<number> {
  const [mode, batFlag, query = "", pathArg = "", lineHint = ""] = args;
  if (pathArg === "") return 0;
  const path = await resolveFile(pathArg);
  if (path === undefined) return 0;
  let lines = (await Deno.readTextFile(path)).split("\n");
  if (lines.at(-1) === "") lines.pop();

  const spans = mode === "grep"
    ? await grepSpans(context, query, path)
    : searchSpans(lines, parseTerms(query).positives);

  if (batFlag === "bat") {
    // --tabs=0 keeps tabs as-is and --wrap=never keeps lines 1:1 with the
    // raw file; both are required for span indices to land on the right
    // characters. --style=plain drops the grid/numbers for the same reason.
    const bat = await context.runner("bat", [
      "--color=always",
      "--style=plain",
      "--paging=never",
      "--wrap=never",
      "--tabs=0",
      "--",
      path,
    ]);
    const batLines = bat.stdout.split("\n");
    if (batLines.at(-1) === "") batLines.pop();
    // Only trust bat when its output maps 1:1 onto the raw lines; otherwise
    // the emphasis would land on the wrong text — plain beats wrong.
    if (bat.code === 0 && batLines.length === lines.length) lines = batLines;
  }

  const rendered = lines.map((line, i) => overlaySpans(line, spans.get(i + 1) ?? []));
  const hinted = /^[1-9][0-9]*$/.test(lineHint) ? Number(lineHint) : undefined;
  const anchor = hinted ?? firstSpanLine(spans);
  const start = anchor !== undefined && anchor > CONTEXT_ABOVE ? anchor - CONTEXT_ABOVE : 1;
  const out = rendered.slice(start - 1);
  if (out.length > 0) await writeText(context.stdout, out.join("\n") + "\n");
  return 0;
}

/** Same resolution as the old sh guards: {1} may lack the gists/ prefix. */
async function resolveFile(pathArg: string): Promise<string | undefined> {
  for (const candidate of [pathArg, `gists/${pathArg}`]) {
    try {
      if ((await Deno.stat(candidate)).isFile) return candidate;
    } catch {
      // Vanished/odd paths are a silent no-preview, never an error.
    }
  }
  return undefined;
}

/**
 * Every case-insensitive occurrence of every term, per line. Non-overlapping
 * per term; overlaps across terms are merged. Positions are found in the
 * lowercased line and used on the original — the same simplification
 * highlight() in search_render makes (locale-dependent length-changing
 * lowercasing is not worth handling here).
 */
export function searchSpans(
  lines: readonly string[],
  terms: readonly string[],
): Map<number, readonly Span[]> {
  const map = new Map<number, readonly Span[]>();
  const needles = terms.map((term) => term.toLowerCase()).filter((term) => term !== "");
  if (needles.length === 0) return map;
  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    const spans: Span[] = [];
    for (const needle of needles) {
      let at = lower.indexOf(needle);
      while (at !== -1) {
        spans.push([at, at + needle.length]);
        at = lower.indexOf(needle, at + needle.length);
      }
    }
    if (spans.length > 0) map.set(i + 1, mergeSpans(spans));
  });
  return map;
}

/** Shape of the `rg --json` events we consume (a subset of the real schema). */
interface RgJsonEvent {
  type?: string;
  data?: {
    line_number?: number;
    lines?: { text?: string };
    submatches?: { start?: number; end?: number }[];
  };
}

/**
 * Match spans from one `rg --json` pass. rg exit 1 (no match) and 2 (e.g. a
 * regex that is invalid mid-keystroke) both mean "no emphasis", never an
 * error — same stance as the old `2>/dev/null` pipelines. --smart-case
 * matches the reload command's behavior so the preview emphasizes exactly
 * what the list matched.
 */
async function grepSpans(
  context: CommandContext,
  query: string,
  path: string,
): Promise<Map<number, readonly Span[]>> {
  const map = new Map<number, readonly Span[]>();
  if (query === "") return map;
  const result = await context.runner("rg", ["--json", "--smart-case", "--", query, path]);
  for (const row of result.stdout.split("\n")) {
    if (row === "") continue;
    let event: RgJsonEvent;
    try {
      event = JSON.parse(row) as RgJsonEvent;
    } catch {
      continue;
    }
    if (event.type !== "match") continue;
    const text = event.data?.lines?.text;
    const lineNumber = event.data?.line_number;
    const submatches = event.data?.submatches;
    if (typeof text !== "string" || typeof lineNumber !== "number" || submatches === undefined) {
      continue;
    }
    const spans = submatches
      .filter((sub) => typeof sub.start === "number" && typeof sub.end === "number")
      // rg reports byte offsets into the line; JS strings index UTF-16 units.
      .map((sub) => [byteToCharIndex(text, sub.start!), byteToCharIndex(text, sub.end!)] as Span)
      .filter(([start, end]) => end > start);
    if (spans.length > 0) map.set(lineNumber, mergeSpans(spans));
  }
  return map;
}

const encoder = new TextEncoder();

/** UTF-8 byte offset -> UTF-16 string index; iterates code points so the result never splits a surrogate pair. */
export function byteToCharIndex(text: string, byteOffset: number): number {
  let bytes = 0;
  let chars = 0;
  for (const ch of text) {
    if (bytes >= byteOffset) break;
    bytes += encoder.encode(ch).length;
    chars += ch.length;
  }
  return chars;
}

function mergeSpans(spans: Span[]): readonly Span[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/** SGR color/style sequences (what bat emits); other escapes are not expected here. */
// deno-lint-ignore no-control-regex
const SGR = /^\x1b\[[0-9;:]*m/;

/**
 * Wraps the span ranges of a possibly ANSI-colored line in reverse video.
 * Walks the line tracking the "plain" index (escape sequences are copied
 * through without advancing it), so spans computed on the raw text land
 * correctly on bat's colored output too. REVERSE opens right before the
 * first in-span character and REVERSE_OFF closes right after the last one —
 * before any following escape, so a bat `\x1b[0m` never sits inside the
 * emphasized range.
 */
export function overlaySpans(line: string, spans: readonly Span[]): string {
  if (spans.length === 0) return line;
  let out = "";
  let i = 0;
  let plain = 0;
  let spanIndex = 0;
  let open = false;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      const esc = line.slice(i).match(SGR)?.[0];
      if (esc !== undefined) {
        out += esc;
        i += esc.length;
        continue;
      }
    }
    while (spanIndex < spans.length && plain >= spans[spanIndex][1]) spanIndex++;
    if (!open && spanIndex < spans.length && plain >= spans[spanIndex][0]) {
      out += REVERSE;
      open = true;
    }
    out += line[i];
    i++;
    plain++;
    if (open && plain >= spans[spanIndex][1]) {
      out += REVERSE_OFF;
      open = false;
    }
  }
  // Merged spans always close on a character, but stay safe on odd input.
  return open ? out + REVERSE_OFF : out;
}

function firstSpanLine(spans: Map<number, readonly Span[]>): number | undefined {
  let first: number | undefined;
  for (const line of spans.keys()) {
    if (first === undefined || line < first) first = line;
  }
  return first;
}
