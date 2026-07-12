import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { deleteGist, getGist, gistUrl, listOwnGists, updateGist } from "../core/gh.ts";
import { newLocalId, parseGistTarget } from "../core/ids.ts";
import { type GistCondition, reconcile, type ReconcileItem } from "../core/reconcile.ts";
import { contentHash, readGistFiles, scanGistDirs } from "../core/snippets.ts";
import type { LocalMeta } from "../core/state.ts";
import { loadState, saveState } from "../core/state.ts";
import { applyRemote, diffPayload, hashFiles } from "../core/sync.ts";
import { exists, requireConfig } from "./shared.ts";
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
    await err(`warn: ${file} is not managed — put files under gists/<dir>/ (gistan new)\n`);
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
  const filterArg = flags._.map(String).at(0);
  const filter = filterArg === undefined ? undefined : parseGistTarget(filterArg);
  if (filter) items = items.filter((i) => i.dirname === filter);
  if (flags.fix) return await fix(config.repo, items, remote ?? new Map(), context);
  if (items.length === 0) {
    // An id filter that matched nothing is a lookup miss, not an empty repo.
    if (filter) {
      await err(`error: ${filter} not found under gists/\n`);
      return 1;
    }
    await out("no gists yet — create one with gistan new\n");
    return 0;
  }
  // Default listing hides `in-sync` / `remote-unknown` (= published), the
  // same way `git status` only prints paths that need attention — at
  // hundreds of gists, an all-in-sync majority buries the handful of drift
  // lines that matter. `--all` restores the old full listing, and an
  // explicit id filter always shows its one match regardless of condition
  // (the user named it, so hiding it would be surprising).
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
  const desc = item.entry?.description ?? "";
  const url = item.entry ? `  ${gistUrl(item.dirname)}` : "";
  return `${label.padEnd(18)} ${item.dirname} (${files} files)${url}${
    desc === "" ? "" : `  — ${desc}`
  }\n`;
}

/**
 * The repair loop — the receiving end for everything `push` / `pull` skip
 * (ADR-0003): conflicts get an interactive local-vs-remote choice here,
 * remote deletions and missing dirs get unlink/restore prompts. Plain drift
 * is only hinted at (push/pull are the right tools and stay the only writers
 * for the easy cases).
 */
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
  const locals: Record<string, LocalMeta> = { ...state.locals };
  // Persist after EVERY repair, not once at the end: --fix mixes filesystem
  // renames and remote deletes, so a mid-loop failure must never orphan the
  // repairs that already happened (same per-item stance as push/pull).
  const persist = () => saveState(repo, { version: 3, gists, locals });
  let fixed = 0, left = 0;
  for (const item of items) {
    try {
      if (item.condition === "remote-deleted" && item.entry) {
        if (
          await context.confirm(
            `${item.dirname}: gist deleted upstream. Unlink it (keep local dir)?`,
          )
        ) {
          delete gists[item.dirname];
          // The dirname is a dead gist id now — same treatment as unpublish:
          // move to a fresh local id and keep the description as local metadata.
          if (await exists(join(repo, "gists", item.dirname))) {
            let localId: string;
            do {
              localId = newLocalId((candidate) => candidate in gists || candidate in locals);
            } while (await exists(join(repo, "gists", localId)));
            await Deno.rename(join(repo, "gists", item.dirname), join(repo, "gists", localId));
            if (item.entry.description !== "") {
              locals[localId] = { description: item.entry.description };
            }
            await out(`moved: gists/${item.dirname} -> gists/${localId}\n`);
          }
          await persist();
          fixed++;
        } else left++;
      } else if (item.condition === "dir-missing" && item.entry) {
        if (remote.has(item.dirname)) {
          if (
            await context.confirm(`${item.dirname}: local dir missing. Restore files from gist?`)
          ) {
            const gist = await getGist(context.runner, item.dirname);
            const applied = await applyRemote(repo, item.dirname, gist);
            if (!applied.ok) {
              await err(
                `warn: ${item.dirname}: cannot restore — remote file(s) truncated by the API (>1MB): ${
                  applied.truncated.join(", ")
                }; fetch the gist manually (e.g. git clone)\n`,
              );
              left++;
              continue;
            }
            gists[item.dirname] = {
              ...item.entry,
              description: gist.description.trim(),
              remote_updated_at: gist.updated_at ||
                remote.get(item.dirname)?.updated_at ||
                item.entry.remote_updated_at,
              files: applied.hashes,
            };
            await persist();
            fixed++;
          } else if (
            await context.confirm(
              `${item.dirname}: delete orphan gist ${
                gistUrl(item.dirname)
              } and forget index entry?`,
            )
          ) {
            await deleteGist(context.runner, item.dirname);
            delete gists[item.dirname];
            await persist();
            fixed++;
          } else left++;
        } else if (
          // No dir AND the gist is gone upstream (e.g. an unpublish that
          // failed between the remote delete and the index save) — the only
          // repair is forgetting the stale entry; there is nothing to delete.
          await context.confirm(
            `${item.dirname}: local dir missing and gist gone upstream. Forget index entry?`,
          )
        ) {
          delete gists[item.dirname];
          await persist();
          fixed++;
        } else left++;
      } else if (item.condition === "conflict" && item.entry && item.local) {
        const resolution = await resolveConflict(repo, item, context);
        if (resolution === undefined) left++;
        else {
          gists[item.dirname] = resolution;
          await persist();
          fixed++;
        }
      } else if (item.condition === "remote-drift") {
        await err(`warn: ${item.dirname}: remote changes exist — run gistan pull\n`);
      } else if (item.condition === "local-drift") {
        await err(`warn: ${item.dirname}: local changes exist — run gistan push\n`);
      }
    } catch (e) {
      left++;
      await err(
        `warn: ${item.dirname}: fix failed — ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
  await persist();
  await out(`status --fix: ${fixed} fixed, ${left} left as-is\n`);
  return 0;
}

/**
 * Conflict = both sides changed since last sync. Shows which files moved on
 * which side, then offers remote-wins (pull) and local-wins (push) in that
 * order; declining both leaves the gist untouched. Returns the new index
 * entry, or undefined when left as-is.
 */
async function resolveConflict(
  repo: string,
  item: ReconcileItem,
  context: CommandContext,
) {
  const out = (t: string) => writeText(context.stdout, t);
  const err = (t: string) => writeText(context.stderr, t);
  const entry = item.entry!;
  const gist = await getGist(context.runner, item.dirname);
  const remoteHashes: Record<string, string> = {};
  for (const f of gist.files) {
    if (f.content === undefined || f.truncated) continue;
    remoteHashes[f.filename] = await contentHash(new TextEncoder().encode(f.content));
  }
  await out(`${item.dirname}: local and remote both changed\n`);
  const names = [
    ...new Set([
      ...Object.keys(entry.files),
      ...Object.keys(item.local!.files),
      ...Object.keys(remoteHashes),
    ]),
  ].sort();
  for (const name of names) {
    const localChanged = entry.files[name] !== item.local!.files[name];
    const remoteChanged = entry.files[name] !== remoteHashes[name];
    if (!localChanged && !remoteChanged) continue;
    const side = localChanged && remoteChanged ? "both" : localChanged ? "local" : "remote";
    await out(`  ${side.padEnd(6)} ${name}\n`);
  }
  if (await context.confirm(`${item.dirname}: overwrite local with remote (pull)?`)) {
    const applied = await applyRemote(repo, item.dirname, gist);
    if (!applied.ok) {
      await err(
        `warn: ${item.dirname}: cannot apply remote — file(s) truncated by the API (>1MB): ${
          applied.truncated.join(", ")
        }; fetch the gist manually (e.g. git clone)\n`,
      );
      return undefined;
    }
    return {
      ...entry,
      description: gist.description.trim(),
      remote_updated_at: gist.updated_at || entry.remote_updated_at,
      files: applied.hashes,
    };
  }
  if (await context.confirm(`${item.dirname}: overwrite remote with local (push)?`)) {
    const allFiles = await readGistFiles(repo, item.dirname);
    const payload = await diffPayload(entry.files, allFiles);
    const updated = await updateGist(context.runner, item.dirname, { files: payload });
    return {
      ...entry,
      remote_updated_at: updated.updated_at,
      files: await hashFiles(allFiles),
    };
  }
  return undefined;
}
