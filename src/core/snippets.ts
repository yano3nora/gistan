import { join } from "@std/path";

export const GISTS_DIR = "gists";
export const DESCRIPTION_FILE = ".description.txt";

export async function contentHash(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `sha256:${hex}`;
}

export async function textHash(text: string): Promise<string> {
  return await contentHash(new TextEncoder().encode(text));
}

export async function listFilesUnder(repoDir: string, top: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(abs: string, rel: string): Promise<void> {
    try {
      for await (const entry of Deno.readDir(abs)) {
        if (entry.name === ".gitkeep") continue;
        const absChild = join(abs, entry.name);
        const relChild = `${rel}/${entry.name}`;
        if (entry.isDirectory) await walk(absChild, relChild);
        else if (entry.isFile) result.push(relChild);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
  }
  await walk(join(repoDir, top), top);
  return result.sort();
}

export interface LocalGistDir {
  readonly dirname: string;
  /** gist filenames only, never .description.txt. */
  readonly files: Readonly<Record<string, string>>;
  readonly description: string;
  readonly descriptionHash: string | null;
}

export interface GistScan {
  readonly dirs: ReadonlyMap<string, LocalGistDir>;
  readonly bareFiles: readonly string[];
  readonly nestedFiles: readonly string[];
}

/**
 * Scans gists/: one direct child directory is one gist. Nested files are warned
 * separately because gist filenames cannot contain '/'. .description.txt is
 * reserved metadata and intentionally excluded from LocalGistDir.files.
 */
export async function scanGistDirs(repoDir: string): Promise<GistScan> {
  const dirs = new Map<string, LocalGistDir>();
  const bareFiles: string[] = [];
  const nestedFiles: string[] = [];
  try {
    for await (const entry of Deno.readDir(join(repoDir, GISTS_DIR))) {
      if (entry.name === ".gitkeep") continue;
      const abs = join(repoDir, GISTS_DIR, entry.name);
      if (entry.isFile) {
        bareFiles.push(`${GISTS_DIR}/${entry.name}`);
        continue;
      }
      if (!entry.isDirectory) continue;
      const files: Record<string, string> = {};
      for await (const child of Deno.readDir(abs)) {
        const rel = `${GISTS_DIR}/${entry.name}/${child.name}`;
        if (child.isDirectory) {
          for (const nested of await listFilesUnder(repoDir, rel)) nestedFiles.push(nested);
          continue;
        }
        if (!child.isFile || child.name === ".gitkeep") continue;
        if (child.name === DESCRIPTION_FILE) continue;
        files[child.name] = await contentHash(await Deno.readFile(join(abs, child.name)));
      }
      const description = await readDescription(repoDir, entry.name);
      dirs.set(entry.name, {
        dirname: entry.name,
        files,
        description,
        descriptionHash: description === "" ? null : await textHash(description),
      });
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return { dirs, bareFiles: bareFiles.sort(), nestedFiles: nestedFiles.sort() };
}

export async function readDescription(repoDir: string, dirname: string): Promise<string> {
  try {
    return (await Deno.readTextFile(join(repoDir, GISTS_DIR, dirname, DESCRIPTION_FILE))).trim();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "";
    throw error;
  }
}

export async function readGistFiles(
  repoDir: string,
  dirname: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const dir = join(repoDir, GISTS_DIR, dirname);
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || entry.name === DESCRIPTION_FILE || entry.name === ".gitkeep") continue;
    result[entry.name] = await Deno.readTextFile(join(dir, entry.name));
  }
  return result;
}
