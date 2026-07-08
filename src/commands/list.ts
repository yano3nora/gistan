import { parseArgs } from "@std/cli/parse-args";
import { gistUrl } from "../core/gh.ts";
import { listFilesUnder, scanGistDirs } from "../core/snippets.ts";
import { loadState } from "../core/state.ts";
import { requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";
export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (t: string) => writeText(context.stdout, t);
  const flags = parseArgs([...command.args], { boolean: ["published", "local", "stars"] });
  const config = await requireConfig(context);
  if (!config) return 1;
  if (flags.stars) {
    const files = await listFilesUnder(config.repo, "stars");
    for (const f of files) await out(`${f}\n`);
    await out(`\n${files.length} starred file(s)\n`);
    return 0;
  }
  const scan = await scanGistDirs(config.repo);
  const state = await loadState(config.repo);
  const names = [...new Set([...scan.dirs.keys(), ...Object.keys(state.gists)])].sort();
  let shown = 0;
  for (const name of names) {
    const entry = state.gists[name];
    if (flags.published && !entry) continue;
    if (flags.local && entry) continue;
    const files = Object.keys(scan.dirs.get(name)?.files ?? entry?.files ?? {}).length;
    const url = entry ? `  ${gistUrl(entry.id)} (${entry.visibility})` : "";
    await out(`${name.padEnd(40)} ${files} file(s)${url}\n`);
    shown++;
  }
  await out(`\n${shown} gist(s)\n`);
  return 0;
}
