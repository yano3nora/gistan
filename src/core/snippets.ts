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
 * Scans snippets/ recursively (multi-file gist imports live in subdirectories)
 * and returns repo-relative POSIX paths — the index key format — mapped to
 * their current content hash.
 */
export async function scanSnippets(repoDir: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();

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
          result.set(relChild, await contentHash(await Deno.readFile(absChild)));
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return;
      }
      throw error;
    }
  }

  await walk(join(repoDir, "snippets"), "snippets");
  return result;
}
