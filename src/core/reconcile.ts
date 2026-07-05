import type { SnippetEntry, State } from "./state.ts";

export type SnippetCondition =
  | "unpublished" // file exists but has no gist link (tracked or not)
  | "in-sync" // published; neither side changed since last sync
  | "local-drift" // published; the local file changed
  | "remote-drift" // published; the gist changed upstream (edited elsewhere)
  | "conflict" // published; both sides changed — a human must pick a side
  | "remote-deleted" // published, but the gist no longer exists upstream
  | "remote-unknown" // published, no local changes, remote could not be checked
  | "file-missing"; // index entry remains but the file is gone (orphan candidate)

export interface RemoteInfo {
  readonly updated_at: string;
}

export interface ReconcileItem {
  readonly path: string;
  readonly condition: SnippetCondition;
  readonly entry?: SnippetEntry;
  readonly localHash?: string;
}

/**
 * The single source of drift judgement shared by status / pull / doctor
 * (SPEC-0001: those commands must never disagree). Pure function: takes the
 * scanned files, the committed index, and optionally the live remote gist
 * list — it never touches fs or network itself.
 *
 * `remote === undefined` means "remote was not checked" (offline / gh failed);
 * published snippets then degrade to local-only judgement.
 */
export function reconcile(
  files: ReadonlyMap<string, string>,
  state: State,
  remote?: ReadonlyMap<string, RemoteInfo>,
): ReconcileItem[] {
  const paths = new Set([...files.keys(), ...Object.keys(state.snippets)]);
  return [...paths].sort().map((path) => {
    const entry = state.snippets[path];
    const localHash = files.get(path);
    return { path, condition: classify(entry, localHash, remote), entry, localHash };
  });
}

function classify(
  entry: SnippetEntry | undefined,
  localHash: string | undefined,
  remote: ReadonlyMap<string, RemoteInfo> | undefined,
): SnippetCondition {
  if (localHash === undefined) {
    // The path came from the index, so an entry exists but the file does not.
    return "file-missing";
  }
  if (!entry?.gist) {
    return "unpublished";
  }
  const localDrift = localHash !== entry.gist.synced_hash;
  if (remote === undefined) {
    return localDrift ? "local-drift" : "remote-unknown";
  }
  const live = remote.get(entry.gist.id);
  if (live === undefined) {
    return "remote-deleted";
  }
  const remoteDrift = live.updated_at !== entry.gist.remote_updated_at;
  if (localDrift && remoteDrift) {
    return "conflict";
  }
  if (localDrift) {
    return "local-drift";
  }
  if (remoteDrift) {
    return "remote-drift";
  }
  return "in-sync";
}
