import { loadConfig } from "../core/config.ts";
import { gistUrl, listOwnGists } from "../core/gh.ts";
import { reconcile, type ReconcileItem } from "../core/reconcile.ts";
import { scanSnippets } from "../core/snippets.ts";
import { loadState } from "../core/state.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (text: string) => writeText(context.stdout, text);
  const err = (text: string) => writeText(context.stderr, text);

  const config = await loadConfig(context.configPath);
  if (config === undefined) {
    await err("error: gistan is not initialized — run `gistan init`\n");
    return 1;
  }

  const files = await scanSnippets(config.repo);
  const state = await loadState(config.repo);

  // Remote check is best-effort: status keeps working offline with degraded
  // (local-only) judgement instead of failing outright.
  let remote;
  try {
    remote = await listOwnGists(context.runner);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await err(`warn: remote check skipped — ${reason}\n`);
  }

  let items = reconcile(files, state, remote);

  const filter = command.args.at(0);
  if (filter !== undefined) {
    items = items.filter((item) => item.path === filter || item.path === `snippets/${filter}`);
    if (items.length === 0) {
      await err(`error: no snippet matches "${filter}"\n`);
      return 1;
    }
  }

  if (items.length === 0) {
    await out("no snippets yet — create one under snippets/ (or run `gistan import`)\n");
    return 0;
  }

  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.condition, (counts.get(item.condition) ?? 0) + 1);
    await out(formatLine(item));
  }
  const summary = [...counts.entries()]
    .map(([condition, count]) => `${count} ${condition}`)
    .join(", ");
  await out(`\n${items.length} snippet(s): ${summary}\n`);
  return 0;
}

function formatLine(item: ReconcileItem): string {
  const label = item.condition === "in-sync" && item.entry?.gist
    ? `in-sync (${item.entry.gist.visibility})`
    : item.condition;
  const url = item.entry?.gist ? `  ${gistUrl(item.entry.gist.id)}` : "";
  return `${label.padEnd(18)} ${item.path}${url}\n`;
}
