import { getGist, listOwnGists } from "../core/gh.ts";
import { reconcile } from "../core/reconcile.ts";
import { scanGistDirs } from "../core/snippets.ts";
import { loadState, saveState } from "../core/state.ts";
import { applyRemote } from "../core/sync.ts";
import { requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

/**
 * `push`'s twin (ADR-0003): list every published gist whose remote changed
 * while local stayed put, one confirm, mirror them all in. Conflicts and
 * remote deletions are skipped toward `status --fix` — bulk "yes" must never
 * be the thing that discards a local edit or drops an index entry.
 */
export async function run(_command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (t: string) => writeText(context.stdout, t);
  const err = (t: string) => writeText(context.stderr, t);
  const config = await requireConfig(context);
  if (!config) return 1;
  let remote;
  try {
    remote = await listOwnGists(context.runner);
  } catch (e) {
    await err(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const scan = await scanGistDirs(config.repo);
  let state = await loadState(config.repo);
  const items = reconcile(scan.dirs, state, remote);
  for (const item of items) {
    if (item.condition === "conflict") {
      await err(
        `warn: ${item.dirname}: local and remote both changed — resolve with gistan status --fix\n`,
      );
    } else if (item.condition === "remote-deleted") {
      await err(
        `warn: ${item.dirname}: gist deleted upstream — resolve with gistan status --fix\n`,
      );
    }
  }
  const candidates = items.filter((item) => item.condition === "remote-drift" && item.entry);
  if (candidates.length === 0) {
    await out("no remote drift\n");
    return 0;
  }
  await out("remote drift:\n");
  for (const item of candidates) {
    const desc = item.entry!.description === "" ? "" : `  — ${item.entry!.description}`;
    await out(`  ${item.dirname}${desc}\n`);
  }
  if (!(await context.confirm(`Pull ${candidates.length} gist(s) from gist.github.com?`))) {
    await err("aborted\n");
    return 1;
  }
  let pulled = 0, failed = 0;
  for (const item of candidates) {
    try {
      const gist = await getGist(context.runner, item.dirname);
      const applied = await applyRemote(config.repo, item.dirname, gist);
      if (!applied.ok) {
        failed++;
        await err(
          `warn: ${item.dirname}: skipped — remote file(s) truncated by the API (>1MB): ${
            applied.truncated.join(", ")
          }; fetch the gist manually (e.g. git clone)\n`,
        );
        continue;
      }
      state = {
        version: 3,
        gists: {
          ...state.gists,
          [item.dirname]: {
            ...item.entry!,
            description: gist.description.trim(),
            remote_updated_at: gist.updated_at ||
              remote.get(item.dirname)?.updated_at ||
              item.entry!.remote_updated_at,
            files: applied.hashes,
          },
        },
        locals: state.locals,
      };
      await saveState(config.repo, state);
      pulled++;
      await out(`pulled: ${item.dirname}\n`);
    } catch (e) {
      failed++;
      await err(
        `warn: failed to pull ${item.dirname}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
  await out(`done: ${pulled} pulled${failed > 0 ? `, ${failed} failed` : ""}\n`);
  return failed > 0 ? 1 : 0;
}
