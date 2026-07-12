import { join } from "@std/path";

export type Visibility = "public" | "secret";

/** Index entry for a published gist. The state key is the dirname, which IS the gist id (ADR-0003). */
export interface GistIndexEntry {
  readonly visibility: Visibility;
  /**
   * Description at last sync. Local description drift does not exist by design:
   * `publish -d` writes remote and index in the same operation, so this is
   * always "what the remote had when we last talked to it" (ADR-0003).
   */
  readonly description: string;
  readonly remote_updated_at: string;
  /** filename -> content hash at last sync. */
  readonly files: Readonly<Record<string, string>>;
}

/** Metadata for an unpublished dir; only dirs that have any (a description) get an entry. */
export interface LocalMeta {
  readonly description: string;
}

export interface State {
  readonly version: 3;
  /** key = dirname = gist id. */
  readonly gists: Readonly<Record<string, GistIndexEntry>>;
  /** key = dirname (local id). Unpublished dirs without metadata live only on the filesystem. */
  readonly locals: Readonly<Record<string, LocalMeta>>;
}

export const EMPTY_STATE: State = { version: 3, gists: {}, locals: {} };

// No "error:" prefix here — main.ts's top-level guard adds it when this throw
// surfaces to the user.
const OLD_SCHEMA_ERROR = (version: number) =>
  `index schema v${version} detected — gistan v0.7 renamed gist dirs to gist ids (ADR-0003) with no automatic migration. ` +
  "Start over: 'gistan root init' a fresh repo, 'gistan import', then re-create unpublished files with 'gistan new' " +
  "(.description.txt files are obsolete — descriptions now live in the index)";

export function statePath(repoDir: string): string {
  return join(repoDir, ".gistan", "state.json");
}

/** Missing index = empty v3 index. v1/v2 intentionally have no migration path. */
export async function loadState(repoDir: string): Promise<State> {
  let text: string;
  try {
    text = await Deno.readTextFile(statePath(repoDir));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return EMPTY_STATE;
    throw error;
  }
  const data = JSON.parse(text);
  if (data?.version === 1 || data?.version === 2) throw new Error(OLD_SCHEMA_ERROR(data.version));
  if (data?.version !== 3 || typeof data.gists !== "object" || data.gists === null) {
    throw new Error(`invalid index at ${statePath(repoDir)} — restore it from git history`);
  }
  // locals was optional in early v3 drafts; normalize so callers can index it freely.
  if (typeof data.locals !== "object" || data.locals === null) data.locals = {};
  return data as State;
}

export async function saveState(repoDir: string, state: State): Promise<void> {
  const gists: Record<string, GistIndexEntry> = {};
  for (const dir of Object.keys(state.gists).sort()) {
    const entry = state.gists[dir];
    const files: Record<string, string> = {};
    for (const filename of Object.keys(entry.files).sort()) files[filename] = entry.files[filename];
    gists[dir] = { ...entry, files };
  }
  const locals: Record<string, LocalMeta> = {};
  for (const dir of Object.keys(state.locals).sort()) locals[dir] = state.locals[dir];
  await Deno.mkdir(join(repoDir, ".gistan"), { recursive: true });
  // Write-then-rename so a crash mid-write can never leave a truncated index
  // behind (rename within a directory is atomic on POSIX filesystems).
  const path = statePath(repoDir);
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, `${JSON.stringify({ version: 3, gists, locals }, null, 2)}\n`);
  await Deno.rename(tmp, path);
}
