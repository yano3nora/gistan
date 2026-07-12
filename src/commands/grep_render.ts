import { displayPath } from "../core/display.ts";
import type { CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

/**
 * Hidden subcommand behind `gistan grep` (`<self> __grep-render {q}`): the
 * line-level regex mode, moved from a sh pipeline to TypeScript when display
 * paths started hiding gist ids (ADR-0003) — the old
 * `sed 's|^gists/||' | sort` stages cannot produce id-less display paths
 * while keeping the real path recoverable. Rows use the shared protocol
 * `real\tline\tdisplay:line:col: text` (line empty for path-only hits).
 *
 * The query stays one rg regex end to end: display-path hits are matched by
 * piping the display list through `rg -i` (rg remains the regex dialect's
 * source of truth — no JS RegExp reimplementation), content hits come from
 * `rg --smart-case` over the repo, and the final coloring is one
 * `rg -i --color=always` pass over the assembled rows, exactly like the old
 * pipeline's last stage. Every row already matches the query by
 * construction, so that pass is a pure recolor, never a filter.
 */
export async function runGrepRender(
  args: readonly string[],
  context: CommandContext,
): Promise<number> {
  const query = args.join(" ");
  const listed = await context.runner("rg", ["--files", "--no-ignore", "gists", "stars"]);
  // Tab-bearing paths cannot ride the 3-field row protocol — drop them, same
  // stance as search_render's listFiles.
  const files = listed.stdout.split("\n").filter((line) => line !== "" && !line.includes("\t"))
    .map((file) => ({ file, display: displayPath(file) }));

  if (query === "") {
    const rows = files
      .sort((a, b) => compare(a.display, b.display))
      .map(({ file, display }) => `${file}\t\t${display}`);
    return await emit(context, rows);
  }

  interface Row {
    readonly display: string;
    readonly line: number;
    readonly text: string;
  }
  const rows: Row[] = [];

  // Path hits: the display list goes through rg so `-i` literal-vs-regex
  // semantics match the content pass. Multiple gists can share a filename,
  // so matched displays map back to every real path that renders to them.
  const pathHits = await context.runner("rg", ["-i", "--", query], {
    stdin: files.map(({ display }) => display).join("\n") + "\n",
  });
  const matchedDisplays = new Set(pathHits.stdout.split("\n").filter((line) => line !== ""));
  for (const { file, display } of files) {
    if (matchedDisplays.has(display)) {
      rows.push({ display, line: 0, text: `${file}\t\t${display}` });
    }
  }

  // Content hits: `real:line:col:text` (same rg flags as the old pipeline).
  // The path part is matched non-greedily up to the first :line:col: shape —
  // same ambiguity tolerance the old `sort -t:` had for exotic filenames.
  const contentHits = await context.runner("rg", [
    "--line-number",
    "--column",
    "--no-heading",
    "--smart-case",
    "--no-ignore",
    "--",
    query,
    "gists",
    "stars",
  ]);
  for (const raw of contentHits.stdout.split("\n")) {
    const match = raw.match(/^(.+?):(\d+):(\d+):(.*)$/);
    if (match === null) continue;
    const [, file, line, col, text] = match;
    if (file.includes("\t")) continue;
    rows.push({
      display: displayPath(file),
      line: Number(line),
      text: `${file}\t${line}\t${displayPath(file)}:${line}:${col}:${text}`,
    });
  }

  // Path sort so directories cluster; a file's path-only row (line 0) leads
  // its own content hits — the ordering the old `sort -t: -k1,1 -k2,2n` gave.
  rows.sort((a, b) => compare(a.display, b.display) || a.line - b.line);
  if (rows.length === 0) return 0;

  const colored = await context.runner("rg", ["-i", "--color=always", "--", query], {
    stdin: rows.map((row) => row.text).join("\n") + "\n",
  });
  const coloredRows = colored.stdout.split("\n").filter((line) => line !== "");
  // Recolor only when it stayed 1:1 (an rg oddity must degrade to plain, not drop rows).
  return await emit(
    context,
    coloredRows.length === rows.length ? coloredRows : rows.map((row) => row.text),
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function emit(context: CommandContext, rows: readonly string[]): Promise<number> {
  if (rows.length > 0) await writeText(context.stdout, rows.join("\n") + "\n");
  return 0;
}
