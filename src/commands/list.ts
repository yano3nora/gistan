import { parseArgs } from "@std/cli/parse-args";
import { gistUrl } from "../core/gh.ts";
import { listFilesUnder } from "../core/snippets.ts";
import { loadState } from "../core/state.ts";
import { requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (text: string) => writeText(context.stdout, text);

  const flags = parseArgs([...command.args], {
    boolean: ["published", "local", "stars"],
    string: ["tag"],
  });

  const config = await requireConfig(context);
  if (config === undefined) {
    return 1;
  }

  if (flags.stars) {
    const files = await listFilesUnder(config.repo, "stars");
    for (const file of files) {
      await out(`${file}\n`);
    }
    await out(`\n${files.length} starred file(s)\n`);
    return 0;
  }

  const files = await listFilesUnder(config.repo, "snippets");
  const state = await loadState(config.repo);
  const paths = [...new Set([...files, ...Object.keys(state.snippets)])].sort();

  let shown = 0;
  for (const path of paths) {
    const entry = state.snippets[path];
    if (flags.published && !entry?.gist) {
      continue;
    }
    if (flags.local && entry?.gist) {
      continue;
    }
    if (flags.tag !== undefined && !(entry?.tags ?? []).includes(flags.tag)) {
      continue;
    }
    const tags = (entry?.tags ?? []).map((tag) => `[${tag}]`).join("");
    const url = entry?.gist ? `  ${gistUrl(entry.gist.id)} (${entry.gist.visibility})` : "";
    await out(`${path.replace(/^snippets\//, "").padEnd(40)} ${tags}${url}\n`);
    shown++;
  }
  await out(`\n${shown} snippet(s)\n`);
  return 0;
}
