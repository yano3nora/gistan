import { join } from "@std/path";

/** Hash format stored in the index (`synced_hash`); keep in sync with SPEC-0001. */
export async function contentHash(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `sha256:${hex}`;
}

/**
 * Recursive file listing under a top-level dir (snippets/stars); returns
 * repo-relative POSIX paths — the index key format. No hashing (cheap).
 */
export async function listFilesUnder(repoDir: string, top: string): Promise<string[]> {
  const result: string[] = [];

  async function walk(abs: string, rel: string): Promise<void> {
    try {
      for await (const entry of Deno.readDir(abs)) {
        if (entry.name === ".gitkeep") {
          continue;
        }
        const absChild = join(abs, entry.name);
        const relChild = `${rel}/${entry.name}`;
        if (entry.isDirectory) {
          await walk(absChild, relChild);
        } else if (entry.isFile) {
          result.push(relChild);
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return;
      }
      throw error;
    }
  }

  await walk(join(repoDir, top), top);
  return result.sort();
}

/**
 * Scans snippets/ recursively (multi-file gist imports live in subdirectories)
 * and maps each repo-relative path to its current content hash.
 */
export async function scanSnippets(repoDir: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const rel of await listFilesUnder(repoDir, "snippets")) {
    result.set(rel, await contentHash(await Deno.readFile(join(repoDir, rel))));
  }
  return result;
}
