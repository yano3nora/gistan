import { copyToClipboard } from "../core/clipboard.ts";
import { descriptionFor, displayPath, idSegment, loadDescriptions } from "../core/display.ts";
import { gistUrl } from "../core/gh.ts";
import { EMPTY_STATE, loadState, type State } from "../core/state.ts";
import type { CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

/**
 * Hidden subcommands behind the fzf binds of search / grep / pickFile. All
 * run with cwd = repo (fzf spawns binds in its own cwd) and receive {1} — the
 * row's hidden real-path field (see runQueryUi's row protocol). Display paths
 * hide gist ids (ADR-0003), so anything that needs the id resolves it here,
 * in TypeScript, instead of the old awk-over-tempfile lookup.
 */

const OPENER = Deno.build.os === "darwin" ? "open" : "xdg-open";

/** Index errors (e.g. an old schema) must not crash a keystroke-driven bind. */
async function safeLoadState(): Promise<State> {
  try {
    return await loadState(".");
  } catch {
    return EMPTY_STATE;
  }
}

/**
 * `__copy {1}`: puts the selected item's gist URL (published / star) or its
 * local id (unpublished) on the clipboard — the handoff into
 * `publish <id>` / `unpublish <id>` / `new --id <id>` (ctrl-y, ADR-0003).
 */
export async function runCopyAction(
  args: readonly string[],
  context: CommandContext,
): Promise<number> {
  const path = args.at(0) ?? "";
  const segment = idSegment(path);
  if (segment === undefined) return 0;
  const target = path.startsWith("stars/") || segment in (await safeLoadState()).gists
    ? gistUrl(segment)
    : segment;
  await copyToClipboard(context.runner, target);
  return 0;
}

/** `__open {1}`: opens the item's gist in the browser; unpublished items are a silent no-op. */
export async function runOpenAction(
  args: readonly string[],
  context: CommandContext,
): Promise<number> {
  const path = args.at(0) ?? "";
  const segment = idSegment(path);
  if (segment === undefined) return 0;
  if (!path.startsWith("stars/") && !(segment in (await safeLoadState()).gists)) return 0;
  await context.runner(OPENER, [gistUrl(segment)]);
  return 0;
}

/**
 * `__list`: the file list behind pickFile (edit / rm), in the shared
 * `real\t\tdisplay` row protocol so ids stay hidden while selections still
 * resolve to real paths. Descriptions ride along as plain-text suffixes —
 * pickFile uses fzf-native matching over displayed fields, so they are
 * searchable for free.
 */
export async function runListRender(context: CommandContext): Promise<number> {
  const result = await context.runner("rg", ["--files", "--no-ignore", "gists", "stars"]);
  // Tab-bearing paths cannot ride the row protocol — same stance as search_render.
  const files = result.stdout.split("\n").filter((line) => line !== "" && !line.includes("\t"));
  const descriptions = await loadDescriptionsSafe();
  const rows = files
    .map((file) => ({ file, display: displayPath(file) }))
    .sort((a, b) => a.display < b.display ? -1 : a.display > b.display ? 1 : 0)
    .map(({ file, display }) => {
      const desc = descriptionFor(descriptions, file);
      return `${file}\t\t${display}${desc === "" ? "" : `  — ${desc}`}`;
    });
  if (rows.length > 0) await writeText(context.stdout, rows.join("\n") + "\n");
  return 0;
}

/** Same stance as safeLoadState: a broken index degrades to no descriptions, never a crash. */
export async function loadDescriptionsSafe(): Promise<Map<string, string>> {
  try {
    return await loadDescriptions(".");
  } catch {
    return new Map();
  }
}
