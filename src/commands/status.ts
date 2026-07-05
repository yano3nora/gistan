import { parseArgs } from "@std/cli/parse-args";
import { loadConfig } from "../core/config.ts";
import { gistUrl, listOwnGists } from "../core/gh.ts";
import { reconcile, type ReconcileItem, type SnippetCondition } from "../core/reconcile.ts";
import { scanSnippets } from "../core/snippets.ts";
import { loadState } from "../core/state.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (text: string) => writeText(context.stdout, text);
  const err = (text: string) => writeText(context.stderr, text);

  const flags = parseArgs([...command.args], { boolean: ["remote"] });

  const config = await loadConfig(context.configPath);
  if (config === undefined) {
    await err("error: gistan is not initialized — run `gistan init`\n");
    return 1;
  }

  const files = await scanSnippets(config.repo);
  const state = await loadState(config.repo);

  // The remote sweep costs ~10s for hundreds of gists (sequential paging), so
  // status is local-only by default; --remote opts into drift detection. Even
  // then it stays best-effort: offline degrades instead of failing outright.
  let remote;
  if (flags.remote) {
    try {
      remote = await listOwnGists(context.runner);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await err(`warn: remote check skipped — ${reason}\n`);
    }
  }

  let items = reconcile(files, state, remote);

  const filter = flags._.map(String).at(0);
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
    const base = baseLabel(item.condition);
    counts.set(base, (counts.get(base) ?? 0) + 1);
    await out(formatLine(item));
  }
  const summary = [...counts.entries()]
    .map(([condition, count]) => `${count} ${condition}`)
    .join(", ");
  await out(`\n${items.length} snippet(s): ${summary}\n`);
  if (!flags.remote) {
    await out("(local view — add --remote to detect drift against gist.github.com)\n");
  }
  return 0;
}

/** Without --remote every published snippet is "remote-unknown" — to the user that just reads "published". */
function baseLabel(condition: SnippetCondition): string {
  return condition === "remote-unknown" ? "published" : condition;
}

function formatLine(item: ReconcileItem): string {
  const base = baseLabel(item.condition);
  const label = (base === "in-sync" || base === "published") && item.entry?.gist
    ? `${base} (${item.entry.gist.visibility})`
    : base;
  const url = item.entry?.gist ? `  ${gistUrl(item.entry.gist.id)}` : "";
  // The snippets/ prefix is structural, not informational — never show it.
  return `${label.padEnd(18)} ${item.path.replace(/^snippets\//, "")}${url}\n`;
}
