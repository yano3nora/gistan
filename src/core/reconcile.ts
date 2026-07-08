import type { GistIndexEntry, State } from "./state.ts";
import type { LocalGistDir } from "./snippets.ts";

export type GistCondition =
  | "unpublished"
  | "in-sync"
  | "local-drift"
  | "remote-drift"
  | "conflict"
  | "remote-deleted"
  | "remote-unknown"
  | "dir-missing";

export interface RemoteInfo {
  readonly updated_at: string;
}

export interface ReconcileItem {
  readonly dirname: string;
  readonly condition: GistCondition;
  readonly entry?: GistIndexEntry;
  readonly local?: LocalGistDir;
}

export function reconcile(
  local: ReadonlyMap<string, LocalGistDir>,
  state: State,
  remote?: ReadonlyMap<string, RemoteInfo>,
): ReconcileItem[] {
  const names = new Set([...local.keys(), ...Object.keys(state.gists)]);
  return [...names].sort().map((dirname) => {
    const entry = state.gists[dirname];
    const dir = local.get(dirname);
    return { dirname, condition: classify(entry, dir, remote), entry, local: dir };
  });
}

function classify(
  entry: GistIndexEntry | undefined,
  dir: LocalGistDir | undefined,
  remote: ReadonlyMap<string, RemoteInfo> | undefined,
): GistCondition {
  if (!entry && dir) return "unpublished";
  if (entry && !dir) return "dir-missing";
  if (!entry || !dir) return "unpublished";

  const localDrift = entry.synced_description_hash !== dir.descriptionHash ||
    JSON.stringify(sortRecord(entry.files)) !== JSON.stringify(sortRecord(dir.files));
  if (remote === undefined) return localDrift ? "local-drift" : "remote-unknown";
  const live = remote.get(entry.id);
  if (!live) return "remote-deleted";
  const remoteDrift = live.updated_at !== entry.remote_updated_at;
  if (localDrift && remoteDrift) return "conflict";
  if (localDrift) return "local-drift";
  if (remoteDrift) return "remote-drift";
  return "in-sync";
}

function sortRecord(record: Readonly<Record<string, string>>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = record[key];
  return sorted;
}
