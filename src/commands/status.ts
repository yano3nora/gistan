import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { deleteGist, getGist, gistUrl, listOwnGists } from "../core/gh.ts";
import { type GistCondition, reconcile, type ReconcileItem } from "../core/reconcile.ts";
import { contentHash, DESCRIPTION_FILE, scanGistDirs, textHash } from "../core/snippets.ts";
import { loadState, saveState } from "../core/state.ts";
import { requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (text: string) => writeText(context.stdout, text);
  const err = (text: string) => writeText(context.stderr, text);
  const flags = parseArgs([...command.args], { boolean: ["remote", "fix", "all"] });
  const config = await requireConfig(context);
  if (!config) return 1;
  const scan = await scanGistDirs(config.repo);
  const state = await loadState(config.repo);
  for (const file of scan.bareFiles) {
    await err(`warn: ${file} is not managed — put files under gists/<dirname>/\n`);
  }
  for (const file of scan.nestedFiles) {
    await err(`warn: ${file} is nested too deeply for gist publishing\n`);
  }
  let remote;
  if (flags.remote || flags.fix) {
    try {
      remote = await listOwnGists(context.runner);
    } catch (e) {
      if (flags.fix) {
        await err(`error: ${e instanceof Error ? e.message : String(e)}\n`);
        return 1;
      }
      await err(`warn: remote check skipped — ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  let items = reconcile(scan.dirs, state, remote);
  const filter = flags._.map(String).at(0)?.replace(/^gists\//, "").split("/")[0];
  if (filter) items = items.filter((i) => i.dirname === filter);
  if (flags.fix) return await fix(config.repo, items, remote ?? new Map(), context);
  if (items.length === 0) {
    await out("no gists yet — create one under gists/<dirname>/\n");
    return 0;
  }
  // Default listing hides `in-sync` / `remote-unknown` (= published), the
  // same way `git status` only prints paths that need attention — at
  // hundreds of gists, an all-in-sync majority buries the handful of drift
  // lines that matter. `--all` restores the old full listing, and an
  // explicit dirname filter always shows its one match regardless of
  // condition (the user named it, so hiding it would be surprising).
  const visible = flags.all || filter
    ? items
    : items.filter((item) => !HIDDEN_BY_DEFAULT.has(item.condition));
  const counts = new Map<string, number>();
  for (const item of items) {
    const base = baseLabel(item.condition);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  for (const item of visible) {
    await out(formatLine(item));
  }
  await out(
    `\n${items.length} gist(s): ${[...counts.entries()].map(([c, n]) => `${n} ${c}`).join(", ")}\n`,
  );
  if (!flags.remote) {
    await out(
      "(local view — add --remote to detect drift against gist.github.com; --fix runs remote repair)\n",
    );
  }
  return 0;
}
const HIDDEN_BY_DEFAULT: ReadonlySet<GistCondition> = new Set(["in-sync", "remote-unknown"]);
function baseLabel(c: GistCondition) {
  return c === "remote-unknown" ? "published" : c;
}
function formatLine(item: ReconcileItem): string {
  const base = baseLabel(item.condition);
  const label = (base === "in-sync" || base === "published") && item.entry
    ? `${base} (${item.entry.visibility})`
    : base;
  const files = item.local
    ? Object.keys(item.local.files).length
    : Object.keys(item.entry?.files ?? {}).length;
  const url = item.entry ? `  ${gistUrl(item.entry.id)}` : "";
  return `${label.padEnd(18)} ${item.dirname} (${files} files)${url}\n`;
}
async function fix(
  repo: string,
  items: readonly ReconcileItem[],
  remote: ReadonlyMap<string, { updated_at: string }>,
  context: CommandContext,
): Promise<number> {
  const out = (t: string) => writeText(context.stdout, t);
  const err = (t: string) => writeText(context.stderr, t);
  const state = await loadState(repo);
  const gists = { ...state.gists };
  let fixed = 0, left = 0;
  for (const item of items) {
    if (item.condition === "remote-deleted" && item.entry) {
      if (
        await context.confirm(`${item.dirname}: gist deleted upstream. Unlink it (keep local dir)?`)
      ) {
        delete gists[item.dirname];
        fixed++;
      } else left++;
    } else if (item.condition === "dir-missing" && item.entry) {
      if (
        remote.has(item.entry.id) &&
        await context.confirm(`${item.dirname}: local dir missing. Restore files from gist?`)
      ) {
        const gist = await getGist(context.runner, item.entry.id);
        await Deno.mkdir(join(repo, "gists", item.dirname), { recursive: true });
        const hashes: Record<string, string> = {};
        for (const f of gist.files) {
          if (f.content === undefined || f.truncated) continue;
          await Deno.writeTextFile(join(repo, "gists", item.dirname, f.filename), f.content);
          hashes[f.filename] = await contentHash(new TextEncoder().encode(f.content));
        }
        const description = gist.description.trim();
        if (description !== "") {
          await Deno.writeTextFile(
            join(repo, "gists", item.dirname, DESCRIPTION_FILE),
            description,
          );
        }
        gists[item.dirname] = {
          ...item.entry,
          remote_updated_at: gist.updated_at ||
            remote.get(item.entry.id)?.updated_at ||
            item.entry.remote_updated_at,
          synced_description_hash: description === "" ? null : await textHash(description),
          files: hashes,
        };
        fixed++;
      } else if (
        await context.confirm(
          `${item.dirname}: delete orphan gist ${gistUrl(item.entry.id)} and forget index entry?`,
        )
      ) {
        await deleteGist(context.runner, item.entry.id);
        delete gists[item.dirname];
        fixed++;
      } else left++;
    } else if ((item.condition === "remote-drift" || item.condition === "conflict")) {
      await err(`warn: ${item.dirname}: remote changes exist — run gistan pull ${item.dirname}\n`);
    }
  }
  await saveState(repo, { version: 2, gists });
  await out(`status --fix: ${fixed} fixed, ${left} left as-is\n`);
  return 0;
}
