import type { Runner } from "./proc.ts";

export interface RemoteGist {
  readonly id: string;
  readonly updated_at: string;
  readonly public: boolean;
}

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
    if (line.trim() === "") continue;
    const [id, updated_at, publicFlag] = line.split("\t");
    gists.set(id, { id, updated_at, public: publicFlag === "true" });
  }
  return gists;
}

export function gistUrl(id: string): string {
  return `https://gist.github.com/${id}`;
}

export type GistFilesPayload = Record<string, { content: string } | null>;
export interface GistFile {
  readonly filename: string;
  readonly content: string;
}

export async function createGist(
  runner: Runner,
  options: { description: string; public: boolean; files: Readonly<Record<string, string>> },
): Promise<{ id: string; updated_at: string }> {
  const files: GistFilesPayload = {};
  for (const [filename, content] of Object.entries(options.files)) files[filename] = { content };
  const body = JSON.stringify({ description: options.description, public: options.public, files });
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
  options: { description?: string; files: GistFilesPayload },
): Promise<{ updated_at: string }> {
  const body = JSON.stringify({
    ...(options.description === undefined ? {} : { description: options.description }),
    files: options.files,
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
    if (items.length === 0) break;
    all.push(
      ...items.map((item) => ({
        id: item.id,
        description: item.description ?? "",
        public: item.public,
        updated_at: item.updated_at,
      })),
    );
    await onPage?.(page, all.length);
    if (items.length < 100) break;
  }
  return all;
}

export interface GistDetailFile {
  readonly filename: string;
  readonly content?: string;
  readonly truncated?: boolean;
}

export interface GistDetail {
  readonly description: string;
  readonly updated_at: string;
  readonly files: readonly GistDetailFile[];
}

export async function getGist(runner: Runner, id: string): Promise<GistDetail> {
  const result = await runner("gh", ["api", `gists/${id}`]);
  if (result.code !== 0) {
    throw new Error(`gist fetch failed (${id}): ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  const data = JSON.parse(result.stdout) as {
    description?: string | null;
    updated_at?: string;
    files?: Record<string, GistDetailFile>;
  };
  return {
    description: data.description ?? "",
    updated_at: data.updated_at ?? "",
    files: Object.values(data.files ?? {}),
  };
}

export async function getGistFiles(runner: Runner, id: string): Promise<GistDetailFile[]> {
  return [...(await getGist(runner, id)).files];
}
