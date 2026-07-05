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

export interface GistFile {
  readonly filename: string;
  readonly content: string;
}

/**
 * Bodies go through stdin (`--input -`) instead of CLI args so large snippet
 * contents never hit the OS argument-length limit.
 */
export async function createGist(
  runner: Runner,
  options: { description: string; public: boolean; file: GistFile },
): Promise<{ id: string; updated_at: string }> {
  const body = JSON.stringify({
    description: options.description,
    public: options.public,
    files: { [options.file.filename]: { content: options.file.content } },
  });
  const result = await runner("gh", [
    "api",
    "gists",
    "--method",
    "POST",
    "--input",
    "-",
    "--jq",
    "[.id, .updated_at] | @tsv",
  ], { stdin: body });
  if (result.code !== 0) {
    throw new Error(`gist create failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  const [id, updated_at] = result.stdout.trim().split("\t");
  return { id, updated_at };
}

export async function updateGist(
  runner: Runner,
  id: string,
  options: { description?: string; file: GistFile },
): Promise<{ updated_at: string }> {
  const body = JSON.stringify({
    ...(options.description === undefined ? {} : { description: options.description }),
    files: { [options.file.filename]: { content: options.file.content } },
  });
  const result = await runner("gh", [
    "api",
    `gists/${id}`,
    "--method",
    "PATCH",
    "--input",
    "-",
    "--jq",
    ".updated_at",
  ], { stdin: body });
  if (result.code !== 0) {
    throw new Error(`gist update failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return { updated_at: result.stdout.trim() };
}

export async function deleteGist(runner: Runner, id: string): Promise<void> {
  const result = await runner("gh", ["api", `gists/${id}`, "--method", "DELETE"]);
  if (result.code !== 0) {
    throw new Error(`gist delete failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
}

export interface GistSummary {
  readonly id: string;
  readonly description: string;
  readonly public: boolean;
  readonly updated_at: string;
}

/**
 * Pages manually (no --paginate) so every response body is one valid JSON
 * array — `--paginate` concatenates arrays back to back, which JSON.parse
 * cannot read.
 */
export async function listOwnGistSummaries(
  runner: Runner,
  onPage?: (page: number, total: number) => Promise<void>,
): Promise<GistSummary[]> {
  const all: GistSummary[] = [];
  for (let page = 1;; page++) {
    const result = await runner("gh", ["api", `gists?per_page=100&page=${page}`]);
    if (result.code !== 0) {
      throw new Error(`gh api gists failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    }
    const items = JSON.parse(result.stdout) as Array<
      { id: string; description: string | null; public: boolean; updated_at: string }
    >;
    if (items.length === 0) {
      break;
    }
    all.push(...items.map((item) => ({
      id: item.id,
      description: item.description ?? "",
      public: item.public,
      updated_at: item.updated_at,
    })));
    await onPage?.(page, all.length);
    if (items.length < 100) {
      break;
    }
  }
  return all;
}

export interface GistDetailFile {
  readonly filename: string;
  readonly content?: string;
  /** Set by the API for files over ~1MB; the content field is then incomplete. */
  readonly truncated?: boolean;
}

/** The list endpoint has no file contents; each import needs this per-gist call. */
export async function getGistFiles(runner: Runner, id: string): Promise<GistDetailFile[]> {
  const result = await runner("gh", ["api", `gists/${id}`]);
  if (result.code !== 0) {
    throw new Error(`gist fetch failed (${id}): ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  const data = JSON.parse(result.stdout) as {
    files?: Record<string, GistDetailFile>;
  };
  return Object.values(data.files ?? {});
}
