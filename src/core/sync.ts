import { join } from "@std/path";
import type { GistDetail, GistFilesPayload } from "./gh.ts";
import { contentHash } from "./snippets.ts";

/** filename -> content hash, for building index entries after a sync. */
export async function hashFiles(
  files: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    hashes[name] = await contentHash(new TextEncoder().encode(content));
  }
  return hashes;
}

/** Update payload: only changed files are sent; files gone locally are sent as null (= delete). */
export async function diffPayload(
  oldHashes: Readonly<Record<string, string>>,
  files: Readonly<Record<string, string>>,
): Promise<GistFilesPayload> {
  const payload: GistFilesPayload = {};
  for (const [name, content] of Object.entries(files)) {
    if (await contentHash(new TextEncoder().encode(content)) !== oldHashes[name]) {
      payload[name] = { content };
    }
  }
  for (const name of Object.keys(oldHashes)) if (!(name in files)) payload[name] = null;
  return payload;
}

export type ApplyRemoteResult =
  /** filename -> hash of what was written; feeds the index entry. */
  | { readonly ok: true; readonly hashes: Readonly<Record<string, string>> }
  /** gist contains truncated (>1MB) files gh api cannot deliver — NOTHING was touched. */
  | { readonly ok: false; readonly truncated: readonly string[] };

/**
 * Makes gists/<dirname>/ mirror a remote gist: writes every remote file and
 * removes local files the remote no longer has. Shared by `pull` and the
 * `status --fix` repair paths so "take the remote side" always means the
 * same thing.
 *
 * All-or-nothing: a truncated (>1MB) file means the remote content is not
 * fully known, so applying anyway would delete/keep local files based on a
 * partial view and then record the gist as synced — callers must skip the
 * gist instead (the pre-v3 pull silently deleted the local counterpart of a
 * truncated file; that was a data-loss bug, not a behavior to keep).
 */
export async function applyRemote(
  repoDir: string,
  dirname: string,
  gist: GistDetail,
): Promise<ApplyRemoteResult> {
  const truncated = gist.files
    .filter((f) => f.content === undefined || f.truncated)
    .map((f) => f.filename);
  if (truncated.length > 0) return { ok: false, truncated };
  const dirPath = join(repoDir, "gists", dirname);
  await Deno.mkdir(dirPath, { recursive: true });
  const remoteFileNames = new Set<string>();
  const hashes: Record<string, string> = {};
  for (const f of gist.files) {
    remoteFileNames.add(f.filename);
    await Deno.writeTextFile(join(dirPath, f.filename), f.content!);
    hashes[f.filename] = await contentHash(new TextEncoder().encode(f.content!));
  }
  for await (const local of Deno.readDir(dirPath)) {
    if (!local.isFile || local.name === ".gitkeep") continue;
    if (!remoteFileNames.has(local.name)) await Deno.remove(join(dirPath, local.name));
  }
  return { ok: true, hashes };
}
