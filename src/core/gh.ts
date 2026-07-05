import type { Runner } from "./proc.ts";

export interface RemoteGist {
  readonly id: string;
  readonly updated_at: string;
  readonly public: boolean;
}

/**
 * Fetches all own gists in one paginated sweep (~8 requests for 753 gists)
 * instead of one request per snippet. The --jq filter emits one TSV line per
 * gist so the output stays parseable across gh versions.
 */
export async function listOwnGists(runner: Runner): Promise<Map<string, RemoteGist>> {
  const result = await runner("gh", [
    "api",
    "gists?per_page=100",
    "--paginate",
    "--jq",
    ".[] | [.id, .updated_at, (.public | tostring)] | @tsv",
  ]);
  if (result.code !== 0) {
    throw new Error(`gh api gists failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  const gists = new Map<string, RemoteGist>();
  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const [id, updated_at, publicFlag] = line.split("\t");
    gists.set(id, { id, updated_at, public: publicFlag === "true" });
  }
  return gists;
}

export function gistUrl(id: string): string {
  return `https://gist.github.com/${id}`;
}
