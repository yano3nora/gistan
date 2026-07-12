import { join } from "@std/path";
import type { GistDetail } from "./gh.ts";

export const STARS_DIR = "stars";

export interface StarCacheEntry {
  readonly owner: string;
  readonly description: string;
  /** remote gist's updated_at at the time it was last mirrored — the sync diff key. */
  readonly updated_at: string;
  /** when this mirror was actually fetched (may lag updated_at if sync ran offline before). */
  readonly fetched_at: string;
}

export interface StarCache {
  readonly version: 1;
  readonly stars: Readonly<Record<string, StarCacheEntry>>;
}

export const EMPTY_STAR_CACHE: StarCache = { version: 1, stars: {} };

export function starCachePath(repoDir: string): string {
  return join(repoDir, ".gistan", "cache", "stars.json");
}

/**
 * Missing/unparsable/version-mismatched cache = empty cache, never an error:
 * unlike state.json (source of truth for published gists) this is a
 * re-fetchable cache of other people's gists, so `star sync` just rebuilds it
 * (TASK-260706).
 */
export async function loadStarCache(repoDir: string): Promise<StarCache> {
  let text: string;
  try {
    text = await Deno.readTextFile(starCachePath(repoDir));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return EMPTY_STAR_CACHE;
    throw error;
  }
  try {
    const data = JSON.parse(text);
    if (data?.version !== 1 || typeof data.stars !== "object" || data.stars === null) {
      return EMPTY_STAR_CACHE;
    }
    return data as StarCache;
  } catch {
    return EMPTY_STAR_CACHE;
  }
}

export async function saveStarCache(repoDir: string, cache: StarCache): Promise<void> {
  const stars: Record<string, StarCacheEntry> = {};
  for (const id of Object.keys(cache.stars).sort()) stars[id] = cache.stars[id];
  await Deno.mkdir(join(repoDir, ".gistan", "cache"), { recursive: true });
  await Deno.writeTextFile(
    starCachePath(repoDir),
    `${JSON.stringify({ version: 1, stars }, null, 2)}\n`,
  );
}

export function starMirrorDir(owner: string, id: string): string {
  return join(STARS_DIR, owner, id);
}

export async function starMirrorDirExists(
  repoDir: string,
  owner: string,
  id: string,
): Promise<boolean> {
  try {
    const stat = await Deno.stat(join(repoDir, starMirrorDir(owner, id)));
    return stat.isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export interface MirrorResult {
  /** One line per truncated (>1MB) file, gh api omits `content` for those; caller decides how to log. */
  readonly warnings: readonly string[];
}

/**
 * Writes a starred gist's files into stars/<owner>/<id>/ and removes any file
 * in that dir no longer present remotely (stale-file cleanup, same as pull).
 * No .description.txt is written here — that reserved name belongs to
 * gists/, and star description lives only in the cache (TASK-260706 design).
 */
export async function mirrorGist(
  repoDir: string,
  owner: string,
  id: string,
  gist: GistDetail,
): Promise<MirrorResult> {
  const dirPath = join(repoDir, starMirrorDir(owner, id));
  await Deno.mkdir(dirPath, { recursive: true });
  const warnings: string[] = [];
  const remoteFileNames = new Set<string>();
  for (const f of gist.files) {
    if (f.content === undefined || f.truncated) {
      warnings.push(`${owner}/${id}/${f.filename}: truncated; skipped`);
      continue;
    }
    remoteFileNames.add(f.filename);
    await Deno.writeTextFile(join(dirPath, f.filename), f.content);
  }
  for await (const local of Deno.readDir(dirPath)) {
    if (!local.isFile) continue;
    if (!remoteFileNames.has(local.name)) await Deno.remove(join(dirPath, local.name));
  }
  return { warnings };
}

/**
 * Enumerates every stars/<owner>/<id>/ dir actually on disk. `star sync`
 * diffs this against the starred list (not against the cache) when cleaning
 * up, so orphan mirrors survive a lost/broken cache for at most one sync.
 * Non-directory entries under stars/ are ignored, not deleted.
 */
export async function listMirrorDirs(
  repoDir: string,
): Promise<Array<{ owner: string; id: string }>> {
  const result: Array<{ owner: string; id: string }> = [];
  try {
    for await (const ownerEntry of Deno.readDir(join(repoDir, STARS_DIR))) {
      if (!ownerEntry.isDirectory) continue;
      for await (const idEntry of Deno.readDir(join(repoDir, STARS_DIR, ownerEntry.name))) {
        if (!idEntry.isDirectory) continue;
        result.push({ owner: ownerEntry.name, id: idEntry.name });
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return result.sort((a, b) => `${a.owner}/${a.id}`.localeCompare(`${b.owner}/${b.id}`));
}

/**
 * Removes a mirror dir entirely (unstarred gist, or the stale side of an
 * owner rename) and its owner dir if that was the last mirror under it —
 * mirrors are re-fetchable cache, so this never prompts for confirmation.
 */
export async function removeMirrorDir(repoDir: string, owner: string, id: string): Promise<void> {
  try {
    await Deno.remove(join(repoDir, starMirrorDir(owner, id)), { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const ownerDir = join(repoDir, STARS_DIR, owner);
  try {
    for await (const _entry of Deno.readDir(ownerDir)) return;
    await Deno.remove(ownerDir);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
