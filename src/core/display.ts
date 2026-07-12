import { loadStarCache } from "./stars.ts";
import { loadState } from "./state.ts";

/**
 * How repo paths are shown to the user (ADR-0003): gist ids are a
 * tool-managed namespace, so every list/search surface hides them and
 * presents a flat filename view. `stars/` keeps its owner segment — it marks
 * mirror results — but drops the id the same way.
 *
 *   gists/<id>/<file>          -> <file>
 *   stars/<owner>/<id>/<file>  -> stars/<owner>/<file>
 *
 * Anything else (bare files, nested paths) passes through unchanged; those
 * are unmanaged and `status` already warns about them.
 */
export function displayPath(path: string): string {
  const segments = path.split("/");
  if (segments[0] === "gists" && segments.length === 3) return segments[2];
  if (segments[0] === "stars" && segments.length === 4) {
    return `stars/${segments[1]}/${segments[3]}`;
  }
  return path;
}

/**
 * The id-bearing dir segment of a repo path: the dirname for gists/, the
 * gist id for stars/ mirrors, undefined for anything unmanaged.
 */
export function idSegment(path: string): string | undefined {
  const segments = path.split("/");
  if (segments[0] === "gists" && segments.length >= 2) return segments[1];
  if (segments[0] === "stars" && segments.length >= 3) return segments[2];
  return undefined;
}

/**
 * dir-segment -> description, merged from the index (published + locals) and
 * the star cache. Loaded once per render; search/list use it both to match
 * queries against descriptions and to append the dim description suffix that
 * disambiguates same-named files across gists (ADR-0003).
 */
export async function loadDescriptions(repoDir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const state = await loadState(repoDir);
  for (const [dirname, entry] of Object.entries(state.gists)) {
    if (entry.description !== "") map.set(dirname, entry.description);
  }
  for (const [dirname, meta] of Object.entries(state.locals)) {
    if (meta.description !== "") map.set(dirname, meta.description);
  }
  const cache = await loadStarCache(repoDir);
  for (const [id, entry] of Object.entries(cache.stars)) {
    if (entry.description !== "") map.set(id, entry.description);
  }
  return map;
}

export function descriptionFor(descriptions: ReadonlyMap<string, string>, path: string): string {
  const segment = idSegment(path);
  return segment === undefined ? "" : descriptions.get(segment) ?? "";
}
