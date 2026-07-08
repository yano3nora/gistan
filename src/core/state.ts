import { join } from "@std/path";

export type Visibility = "public" | "secret";

export interface GistIndexEntry {
  readonly id: string;
  readonly visibility: Visibility;
  readonly remote_updated_at: string;
  /** Hash of trimmed .description.txt content at last sync; null means empty/no description. */
  readonly synced_description_hash: string | null;
  /** filename -> content hash at last sync. Reserved .description.txt is never included. */
  readonly files: Readonly<Record<string, string>>;
}

export interface State {
  readonly version: 2;
  readonly gists: Readonly<Record<string, GistIndexEntry>>;
}

export const EMPTY_STATE: State = { version: 2, gists: {} };

const V1_ERROR =
  "error: index schema v1 detected — gistan v2 restructured the repo layout. Re-run 'gistan root init' with a fresh repo and 'gistan import'. See docs/TASK-260708-gists-multi-file-restructure.md";

export function statePath(repoDir: string): string {
  return join(repoDir, ".gistan", "state.json");
}

/** Missing index = empty v2 index. v1 intentionally has no migration path. */
export async function loadState(repoDir: string): Promise<State> {
  let text: string;
  try {
    text = await Deno.readTextFile(statePath(repoDir));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return EMPTY_STATE;
    throw error;
  }
  const data = JSON.parse(text);
  if (data?.version === 1) throw new Error(V1_ERROR);
  if (data?.version !== 2 || typeof data.gists !== "object" || data.gists === null) {
    throw new Error(`invalid index at ${statePath(repoDir)} — restore it from git history`);
  }
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
  await Deno.mkdir(join(repoDir, ".gistan"), { recursive: true });
  await Deno.writeTextFile(
    statePath(repoDir),
    `${JSON.stringify({ version: 2, gists }, null, 2)}\n`,
  );
}
