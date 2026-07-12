import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { GistDetail } from "./gh.ts";
import {
  EMPTY_STAR_CACHE,
  listMirrorDirs,
  loadStarCache,
  mirrorGist,
  removeMirrorDir,
  saveStarCache,
  starCachePath,
  starMirrorDir,
  starMirrorDirExists,
} from "./stars.ts";

function gist(files: Record<string, { content?: string; truncated?: boolean }>): GistDetail {
  return {
    description: "",
    updated_at: "2026-07-08T00:00:00Z",
    owner: "octocat",
    files: Object.entries(files).map(([filename, f]) => ({ filename, ...f })),
  };
}

// -- cache load/save ---------------------------------------------------------

Deno.test("star cache load/save round-trip with sorted keys", async () => {
  const repo = await Deno.makeTempDir();
  await saveStarCache(repo, {
    version: 1,
    stars: {
      zeta: { owner: "b", description: "z", updated_at: "t1", fetched_at: "f1" },
      alpha: { owner: "a", description: "a", updated_at: "t2", fetched_at: "f2" },
    },
  });
  const text = await Deno.readTextFile(starCachePath(repo));
  assert(text.endsWith("\n"));
  assert(text.indexOf('"alpha"') < text.indexOf('"zeta"'));
  assertEquals(await loadStarCache(repo), {
    version: 1,
    stars: {
      alpha: { owner: "a", description: "a", updated_at: "t2", fetched_at: "f2" },
      zeta: { owner: "b", description: "z", updated_at: "t1", fetched_at: "f1" },
    },
  });
});

Deno.test("missing star cache loads as empty", async () => {
  const repo = await Deno.makeTempDir();
  assertEquals(await loadStarCache(repo), EMPTY_STAR_CACHE);
});

Deno.test("unparsable star cache loads as empty instead of throwing", async () => {
  const repo = await Deno.makeTempDir();
  await Deno.mkdir(join(repo, ".gistan", "cache"), { recursive: true });
  await Deno.writeTextFile(starCachePath(repo), "{not json");
  assertEquals(await loadStarCache(repo), EMPTY_STAR_CACHE);
});

Deno.test("version-mismatched star cache loads as empty instead of throwing", async () => {
  const repo = await Deno.makeTempDir();
  await Deno.mkdir(join(repo, ".gistan", "cache"), { recursive: true });
  await Deno.writeTextFile(starCachePath(repo), JSON.stringify({ version: 2, stars: {} }));
  assertEquals(await loadStarCache(repo), EMPTY_STAR_CACHE);
});

// -- mirrorGist ---------------------------------------------------------------

Deno.test("mirrorGist writes files under stars/<owner>/<id>/", async () => {
  const repo = await Deno.makeTempDir();
  const result = await mirrorGist(
    repo,
    "octocat",
    "gid1",
    gist({ "a.md": { content: "A" }, "b.md": { content: "B" } }),
  );
  assertEquals(result.warnings, []);
  assertEquals(await Deno.readTextFile(join(repo, "stars", "octocat", "gid1", "a.md")), "A");
  assertEquals(await Deno.readTextFile(join(repo, "stars", "octocat", "gid1", "b.md")), "B");
});

Deno.test("mirrorGist removes stale files no longer present remotely", async () => {
  const repo = await Deno.makeTempDir();
  await mirrorGist(
    repo,
    "octocat",
    "gid1",
    gist({ "a.md": { content: "A" }, "b.md": { content: "B" } }),
  );
  await mirrorGist(repo, "octocat", "gid1", gist({ "a.md": { content: "A2" } }));
  assertEquals(await Deno.readTextFile(join(repo, "stars", "octocat", "gid1", "a.md")), "A2");
  await assertMissing(join(repo, "stars", "octocat", "gid1", "b.md"));
});

Deno.test("mirrorGist warns and skips truncated files", async () => {
  const repo = await Deno.makeTempDir();
  const result = await mirrorGist(
    repo,
    "octocat",
    "gid1",
    gist({ "a.md": { content: "A" }, "big.bin": { truncated: true } }),
  );
  assertEquals(result.warnings, ["octocat/gid1/big.bin: truncated; skipped"]);
  await assertMissing(join(repo, "stars", "octocat", "gid1", "big.bin"));
});

// -- starMirrorDirExists / removeMirrorDir -------------------------------------

Deno.test("starMirrorDirExists reflects filesystem state", async () => {
  const repo = await Deno.makeTempDir();
  assertEquals(await starMirrorDirExists(repo, "octocat", "gid1"), false);
  await mirrorGist(repo, "octocat", "gid1", gist({ "a.md": { content: "A" } }));
  assertEquals(await starMirrorDirExists(repo, "octocat", "gid1"), true);
});

Deno.test("removeMirrorDir deletes the mirror dir and the now-empty owner dir", async () => {
  const repo = await Deno.makeTempDir();
  await mirrorGist(repo, "octocat", "gid1", gist({ "a.md": { content: "A" } }));
  await removeMirrorDir(repo, "octocat", "gid1");
  await assertMissing(join(repo, starMirrorDir("octocat", "gid1")));
  await assertMissing(join(repo, "stars", "octocat"));
});

Deno.test("removeMirrorDir keeps the owner dir when other mirrors remain", async () => {
  const repo = await Deno.makeTempDir();
  await mirrorGist(repo, "octocat", "gid1", gist({ "a.md": { content: "A" } }));
  await mirrorGist(repo, "octocat", "gid2", gist({ "b.md": { content: "B" } }));
  await removeMirrorDir(repo, "octocat", "gid1");
  await assertMissing(join(repo, starMirrorDir("octocat", "gid1")));
  assertEquals(await starMirrorDirExists(repo, "octocat", "gid2"), true);
});

Deno.test("removeMirrorDir on an already-absent mirror is a no-op", async () => {
  const repo = await Deno.makeTempDir();
  await removeMirrorDir(repo, "octocat", "gid1");
});

async function assertMissing(path: string) {
  try {
    await Deno.stat(path);
    throw new Error(`expected missing: ${path}`);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

// -- listMirrorDirs ------------------------------------------------------------

Deno.test("listMirrorDirs enumerates owner/id dirs sorted, skipping non-dirs and a missing stars/", async () => {
  const repo = await Deno.makeTempDir();
  assertEquals(await listMirrorDirs(repo), []);
  await Deno.mkdir(join(repo, "stars", "zeta", "gid2"), { recursive: true });
  await Deno.mkdir(join(repo, "stars", "alpha", "gid1"), { recursive: true });
  await Deno.writeTextFile(join(repo, "stars", "stray.txt"), "");
  await Deno.writeTextFile(join(repo, "stars", "alpha", "stray.txt"), "");
  assertEquals(await listMirrorDirs(repo), [
    { owner: "alpha", id: "gid1" },
    { owner: "zeta", id: "gid2" },
  ]);
});
