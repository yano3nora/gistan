import { gistUrl, listOwnGists, updateGist } from "../core/gh.ts";
import { reconcile } from "../core/reconcile.ts";
import { readGistFiles, scanGistDirs } from "../core/snippets.ts";
import { loadState, saveState } from "../core/state.ts";
import { diffPayload, hashFiles } from "../core/sync.ts";
import { requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

/**
 * The everyday "sync up" command (ADR-0003): list every published gist whose
 * local files drifted, one confirm, update them all. Deliberately narrow:
 * - unpublished dirs are never included (a blanket "yes" must not be able to
 *   put something online — that stays the explicit `publish` / `new --publish`)
 * - conflicts (both sides changed) are skipped toward `status --fix`, keeping
 *   ADR-0001's "conflicts are resolved by a human looking at both sides"
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
    }
  }
  const candidates = items.filter((item) =>
    item.condition === "local-drift" && item.entry && item.local
  );
  if (candidates.length === 0) {
    await out("no local drift\n");
    return 0;
  }
  await out("local drift:\n");
  for (const item of candidates) {
    const desc = item.entry!.description === "" ? "" : `  — ${item.entry!.description}`;
    await out(`  ${item.dirname}  ${changeSummary(item.entry!.files, item.local!.files)}${desc}\n`);
  }
  if (!(await context.confirm(`Push ${candidates.length} gist(s) to gist.github.com?`))) {
    await err("aborted\n");
    return 1;
  }
  let pushed = 0, failed = 0;
  for (const item of candidates) {
    try {
      const allFiles = await readGistFiles(config.repo, item.dirname);
      const payload = await diffPayload(item.entry!.files, allFiles);
      const updated = await updateGist(context.runner, item.dirname, { files: payload });
      state = {
        version: 3,
        gists: {
          ...state.gists,
          [item.dirname]: {
            ...item.entry!,
            remote_updated_at: updated.updated_at,
            files: await hashFiles(allFiles),
          },
        },
        locals: state.locals,
      };
      await saveState(config.repo, state);
      pushed++;
      await out(`pushed: ${item.dirname} ${gistUrl(item.dirname)}\n`);
    } catch (e) {
      failed++;
      await err(
        `warn: failed to push ${item.dirname}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
  await out(`done: ${pushed} pushed${failed > 0 ? `, ${failed} failed` : ""}\n`);
  return failed > 0 ? 1 : 0;
}

/** `+added ~changed -removed` between last-synced hashes and the local scan. */
export function changeSummary(
  synced: Readonly<Record<string, string>>,
  local: Readonly<Record<string, string>>,
): string {
  let added = 0, changed = 0, removed = 0;
  for (const [name, hash] of Object.entries(local)) {
    if (!(name in synced)) added++;
    else if (synced[name] !== hash) changed++;
  }
  for (const name of Object.keys(synced)) if (!(name in local)) removed++;
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (changed > 0) parts.push(`~${changed}`);
  if (removed > 0) parts.push(`-${removed}`);
  return parts.join(" ");
}
