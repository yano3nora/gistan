import { getGist, gistUrl, listStarredGists, starGist } from "../core/gh.ts";
import {
  listMirrorDirs,
  loadStarCache,
  mirrorGist,
  removeMirrorDir,
  saveStarCache,
  type StarCacheEntry,
  starMirrorDirExists,
} from "../core/stars.ts";
import { requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

/**
 * `stars/` mirror management (TASK-260706 v3): `sync` diffs GitHub's starred
 * list against .gistan/cache/stars.json + the filesystem and refetches only
 * what changed; `add` stars one gist and mirrors it immediately. Modeled on
 * root.ts's dispatch (usage on no subcommand, exit 2 + usage on unknown).
 */
const USAGE = `gistan star - manage the star mirror (stars/)

Usage:
  gistan star sync         Mirror all starred gists into stars/ (idempotent).
  gistan star add <url>    Star a gist and mirror it immediately.
`;

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const [sub, ...rest] = command.args;
  switch (sub) {
    case "sync":
      return await runSync(context);
    case "add":
      return await runAdd(rest, context);
    case undefined:
      await writeText(context.stdout, USAGE);
      return 0;
    default:
      await writeText(context.stderr, `error: unknown 'gistan star' subcommand: ${sub}\n${USAGE}`);
      return 2;
  }
}

/**
 * Sync algorithm (TASK-260706 design): for each starred gist, skip the
 * getGist + mirror round trip when the cached updated_at is unchanged AND
 * the mirror dir still exists (a file may have been rm'd by hand; the dir
 * check keeps that self-healing). Cleanup diffs the dirs actually on disk
 * (not the cache) against the starred list, so orphan mirrors are removed
 * even after a lost/broken cache — without confirmation, since the mirror
 * is always re-fetchable from GitHub.
 */
async function runSync(context: CommandContext): Promise<number> {
  const out = (t: string) => writeText(context.stdout, t);
  const err = (t: string) => writeText(context.stderr, t);
  const config = await requireConfig(context);
  if (!config) return 1;

  let starred;
  try {
    starred = await listStarredGists(
      context.runner,
      (p, t) => out(`fetching starred list… page ${p} (${t} so far)\n`),
    );
  } catch (e) {
    await err(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  const cache = await loadStarCache(config.repo);
  const nextStars: Record<string, StarCacheEntry> = {};
  let synced = 0;
  let skipped = 0;
  let removed = 0;

  for (const [i, item] of starred.entries()) {
    const cached = cache.stars[item.id];
    const unchanged = cached !== undefined && cached.updated_at === item.updated_at &&
      cached.owner === item.owner;
    // Unchanged mirrors skip instantly with no output so re-runs stay quiet;
    // everything past this line hits the network, so announce progress first
    // (same stance as import — silence over hundreds of stars reads as a hang).
    if (unchanged && (await starMirrorDirExists(config.repo, item.owner, item.id))) {
      nextStars[item.id] = cached;
      skipped++;
      continue;
    }
    await out(`mirroring ${item.owner}/${item.id} (${i + 1}/${starred.length})…\n`);
    // Owner rename: the old owner/<id> path is now orphaned, drop it before
    // writing the new one so stale mirrors never accumulate.
    if (cached !== undefined && cached.owner !== item.owner) {
      await removeMirrorDir(config.repo, cached.owner, item.id);
    }
    let gist;
    try {
      gist = await getGist(context.runner, item.id);
    } catch (e) {
      await err(`error: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    const mirrored = await mirrorGist(config.repo, item.owner, item.id, gist);
    for (const w of mirrored.warnings) await err(`warn: ${w}\n`);
    nextStars[item.id] = {
      owner: item.owner,
      description: item.description,
      updated_at: item.updated_at,
      fetched_at: new Date().toISOString(),
    };
    synced++;
  }

  const keep = new Set(starred.map((item) => `${item.owner}/${item.id}`));
  for (const dir of await listMirrorDirs(config.repo)) {
    if (keep.has(`${dir.owner}/${dir.id}`)) continue;
    await removeMirrorDir(config.repo, dir.owner, dir.id);
    removed++;
  }

  await saveStarCache(config.repo, { version: 1, stars: nextStars });
  await out(`synced: ${synced}, skipped: ${skipped}, removed: ${removed}\n`);
  return 0;
}

/**
 * Accepts https://gist.github.com/<owner>/<id>, https://gist.github.com/<id>,
 * or a bare id — the trailing path segment is the id in all three (design
 * intentionally skips strict hex validation).
 */
export function parseGistArg(arg: string): string {
  const trimmed = arg.trim().replace(/\/+$/, "");
  const segments = trimmed.split("/");
  return segments[segments.length - 1];
}

async function runAdd(args: readonly string[], context: CommandContext): Promise<number> {
  const out = (t: string) => writeText(context.stdout, t);
  const err = (t: string) => writeText(context.stderr, t);
  // Missing-argument usage error is a pure argv check, so it fires even
  // before init (matches "引数なしは usage エラー exit 2" — not tied to config).
  const arg = args.at(0);
  if (!arg) {
    await err("error: usage: gistan star add <gist-url|id>\n");
    return 2;
  }
  const config = await requireConfig(context);
  if (!config) return 1;
  const id = parseGistArg(arg);

  try {
    await starGist(context.runner, id);
  } catch (e) {
    await err(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  let gist;
  try {
    gist = await getGist(context.runner, id);
  } catch (e) {
    await err(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  const mirrored = await mirrorGist(config.repo, gist.owner, id, gist);
  for (const w of mirrored.warnings) await err(`warn: ${w}\n`);

  const cache = await loadStarCache(config.repo);
  await saveStarCache(config.repo, {
    version: 1,
    stars: {
      ...cache.stars,
      [id]: {
        owner: gist.owner,
        description: gist.description,
        updated_at: gist.updated_at,
        fetched_at: new Date().toISOString(),
      },
    },
  });
  await out(`ok: starred and mirrored ${gistUrl(id)} (stars/${gist.owner}/${id}/)\n`);
  return 0;
}
