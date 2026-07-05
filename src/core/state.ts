import { join } from "@std/path";

export type Visibility = "public" | "secret";

/** Field names mirror the on-disk JSON (SPEC-0001) — no case conversion layer. */
export interface GistLink {
  readonly id: string;
  readonly visibility: Visibility;
  /** Content hash at last sync; a differing current hash means local drift. */
  readonly synced_hash: string;
  /** Remote updated_at at last sync; a differing live value means remote drift. */
  readonly remote_updated_at: string;
}

export interface SnippetEntry {
  readonly tags: readonly string[];
  /** null = tracked but never published. */
  readonly gist: GistLink | null;
}

export interface State {
  readonly version: 1;
  readonly snippets: Readonly<Record<string, SnippetEntry>>;
}

export const EMPTY_STATE: State = { version: 1, snippets: {} };

export function statePath(repoDir: string): string {
  return join(repoDir, ".gistan", "state.json");
}

/** A missing file is treated as an empty index — direct deletion must not break gistan. */
export async function loadState(repoDir: string): Promise<State> {
  let text: string;
  try {
    text = await Deno.readTextFile(statePath(repoDir));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return EMPTY_STATE;
    }
    throw error;
  }
  const data = JSON.parse(text);
  if (data?.version !== 1 || typeof data.snippets !== "object" || data.snippets === null) {
    throw new Error(`invalid index at ${statePath(repoDir)} — restore it from git history`);
  }
  return data as State;
}

export async function saveState(repoDir: string, state: State): Promise<void> {
  // Keys are written sorted for stable diffs and fewer merge conflicts (SPEC-0001).
  const snippets: Record<string, SnippetEntry> = {};
  for (const key of Object.keys(state.snippets).sort()) {
    snippets[key] = state.snippets[key];
  }
  await Deno.writeTextFile(
    statePath(repoDir),
    `${JSON.stringify({ version: 1, snippets }, null, 2)}\n`,
  );
}
