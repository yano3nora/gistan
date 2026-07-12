import { parseArgs } from "@std/cli/parse-args";
import { descriptionFor, displayPath, loadDescriptions } from "../core/display.ts";
import { gistUrl } from "../core/gh.ts";
import { listFilesUnder, scanGistDirs } from "../core/snippets.ts";
import { loadState } from "../core/state.ts";
import { requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

/**
 * Same id-less view as search (ADR-0003): one line per file, described and
 * annotated instead of showing dirnames. Published files carry their gist
 * URL (the id is official there), local files carry the local id — the
 * thing `publish <id>` wants.
 */
export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (t: string) => writeText(context.stdout, t);
  const flags = parseArgs([...command.args], { boolean: ["published", "local", "stars"] });
  const config = await requireConfig(context);
  if (!config) return 1;
  const descriptions = await loadDescriptions(config.repo);
  if (flags.stars) {
    const files = await listFilesUnder(config.repo, "stars");
    const rows = files
      .map((file) => ({ display: displayPath(file), desc: descriptionFor(descriptions, file) }))
      .sort((a, b) => compare(a.display, b.display));
    for (const { display, desc } of rows) {
      await out(`${display}${desc === "" ? "" : `  — ${desc}`}\n`);
    }
    await out(`\n${files.length} starred file(s)\n`);
    return 0;
  }
  const scan = await scanGistDirs(config.repo);
  const state = await loadState(config.repo);
  const names = [...new Set([...scan.dirs.keys(), ...Object.keys(state.gists)])].sort();
  const rows: Array<{ display: string; line: string }> = [];
  let gists = 0;
  for (const name of names) {
    const entry = state.gists[name];
    if (flags.published && !entry) continue;
    if (flags.local && entry) continue;
    gists++;
    const files = Object.keys(scan.dirs.get(name)?.files ?? entry?.files ?? {}).sort();
    const desc = descriptionFor(descriptions, `gists/${name}/-`);
    for (const file of files) {
      const where = entry ? `${gistUrl(name)} (${entry.visibility})` : `(id: ${name})`;
      rows.push({
        display: file,
        line: `${file.padEnd(32)} ${where}${desc === "" ? "" : `  — ${desc}`}\n`,
      });
    }
  }
  rows.sort((a, b) => compare(a.display, b.display));
  for (const row of rows) await out(row.line);
  await out(`\n${gists} gist(s), ${rows.length} file(s)\n`);
  return 0;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
