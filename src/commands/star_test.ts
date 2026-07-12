import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { Runner } from "../core/proc.ts";
import { loadStarCache, starCachePath, starMirrorDir } from "../core/stars.ts";
import { AT, AT2, fixture, memoryContext } from "./test_helpers.ts";
import { parseGistArg, run } from "./star.ts";

interface Call {
  cmd: string;
  args: readonly string[];
}

function recordingRunner(handler: Runner): { runner: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: Runner = (cmd, args, options) => {
    calls.push({ cmd, args });
    return handler(cmd, args, options);
  };
  return { runner, calls };
}

interface StarredItem {
  readonly id: string;
  readonly owner: string;
  readonly description: string;
  readonly updated_at: string;
}

interface GistFixture {
  readonly owner: string;
  readonly description?: string;
  readonly updated_at: string;
  readonly files: Readonly<Record<string, { content?: string; truncated?: boolean }>>;
}

/** Fakes gh for gists/starred, gists/{id}, and gists/{id}/star — the whole gh.ts surface star.ts uses. */
function ghRunner(
  starred: readonly StarredItem[],
  gists: Readonly<Record<string, GistFixture>>,
): Runner {
  return (cmd, args) => {
    if (cmd !== "gh") return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    const resource = args[1] ?? "";
    if (resource.startsWith("gists/starred?per_page=100&page=")) {
      const page = Number(resource.split("page=").at(-1));
      // Real gh API shape: owner is a nested { login } object, not a flat string.
      const payload = starred.map((s) => ({
        id: s.id,
        description: s.description,
        updated_at: s.updated_at,
        owner: { login: s.owner },
      }));
      return Promise.resolve({
        code: 0,
        stdout: page === 1 ? JSON.stringify(payload) : "[]",
        stderr: "",
      });
    }
    const starMatch = resource.match(/^gists\/([^/]+)\/star$/);
    if (starMatch) return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    const getMatch = resource.match(/^gists\/([^/]+)$/);
    if (getMatch) {
      const gist = gists[getMatch[1]];
      if (!gist) return Promise.resolve({ code: 1, stdout: "", stderr: "not found" });
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          description: gist.description ?? "",
          updated_at: gist.updated_at,
          owner: { login: gist.owner },
          files: Object.fromEntries(
            Object.entries(gist.files).map(([filename, f]) => [filename, { filename, ...f }]),
          ),
        }),
        stderr: "",
      });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
}

// -- dispatch -----------------------------------------------------------------

Deno.test("star with no subcommand prints usage", async () => {
  const home = await Deno.makeTempDir();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "star", args: [] }, io.context), 0);
  assert(io.stdout.includes("gistan star sync"));
  assert(io.stdout.includes("gistan star add"));
});

Deno.test("star rejects an unknown subcommand", async () => {
  const home = await Deno.makeTempDir();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "star", args: ["bogus"] }, io.context), 2);
  assert(io.stderr.includes("unknown"));
});

// -- star sync ------------------------------------------------------------------

Deno.test("star sync mirrors a starred gist and writes the cache", async () => {
  const { home, repo } = await fixture();
  const runner = ghRunner(
    [{ id: "gid1", owner: "octocat", description: "desc", updated_at: AT }],
    {
      gid1: {
        owner: "octocat",
        description: "desc",
        updated_at: AT,
        files: { "a.md": { content: "A" } },
      },
    },
  );
  const io = memoryContext(runner, home);
  assertEquals(await run({ name: "star", args: ["sync"] }, io.context), 0);
  assertEquals(
    await Deno.readTextFile(join(repo, starMirrorDir("octocat", "gid1"), "a.md")),
    "A",
  );
  const cached = (await loadStarCache(repo)).stars.gid1;
  assertEquals(cached.owner, "octocat");
  assertEquals(cached.description, "desc");
  assertEquals(cached.updated_at, AT);
  assert(cached.fetched_at.length > 0);
  // Progress: the page fetch and each network-hitting mirror announce themselves.
  assert(io.stdout.includes("fetching starred list… page 1 (1 so far)"));
  assert(io.stdout.includes("mirroring octocat/gid1 (1/1)…"));
  assert(io.stdout.includes("synced: 1, skipped: 0, removed: 0"));
});

Deno.test("star sync is idempotent: no gists/{id} GET on the second sync", async () => {
  const { home, repo } = await fixture();
  const starred = [{ id: "gid1", owner: "octocat", description: "desc", updated_at: AT }];
  const gists = {
    gid1: {
      owner: "octocat",
      description: "desc",
      updated_at: AT,
      files: { "a.md": { content: "A" } },
    },
  };

  const first = recordingRunner(ghRunner(starred, gists));
  const io1 = memoryContext(first.runner, home);
  assertEquals(await run({ name: "star", args: ["sync"] }, io1.context), 0);
  assert(first.calls.some((c) => c.cmd === "gh" && c.args[1] === "gists/gid1"));

  const second = recordingRunner(ghRunner(starred, gists));
  const io2 = memoryContext(second.runner, home);
  assertEquals(await run({ name: "star", args: ["sync"] }, io2.context), 0);
  assert(second.calls.some((c) => c.cmd === "gh" && c.args[1]?.startsWith("gists/starred?")));
  assertEquals(second.calls.some((c) => c.cmd === "gh" && c.args[1] === "gists/gid1"), false);
  // Skips are quiet: an all-unchanged re-run prints no per-gist progress.
  assertEquals(io2.stdout.includes("mirroring"), false);
  assert(io2.stdout.includes("synced: 0, skipped: 1, removed: 0"));
  // Sanity: the mirror is still on disk untouched.
  assertEquals(
    await Deno.readTextFile(join(repo, starMirrorDir("octocat", "gid1"), "a.md")),
    "A",
  );
});

Deno.test("star sync refetches a gist whose updated_at changed and drops its stale file", async () => {
  const { home, repo } = await fixture();
  const firstRunner = ghRunner(
    [{ id: "gid1", owner: "octocat", description: "desc", updated_at: AT }],
    {
      gid1: {
        owner: "octocat",
        description: "desc",
        updated_at: AT,
        files: { "a.md": { content: "A" }, "b.md": { content: "B" } },
      },
    },
  );
  const io1 = memoryContext(firstRunner, home);
  assertEquals(await run({ name: "star", args: ["sync"] }, io1.context), 0);

  const second = recordingRunner(
    ghRunner(
      [{ id: "gid1", owner: "octocat", description: "desc2", updated_at: AT2 }],
      {
        gid1: {
          owner: "octocat",
          description: "desc2",
          updated_at: AT2,
          files: { "a.md": { content: "A2" } },
        },
      },
    ),
  );
  const io2 = memoryContext(second.runner, home);
  assertEquals(await run({ name: "star", args: ["sync"] }, io2.context), 0);
  assert(second.calls.some((c) => c.cmd === "gh" && c.args[1] === "gists/gid1"));
  assertEquals(
    await Deno.readTextFile(join(repo, starMirrorDir("octocat", "gid1"), "a.md")),
    "A2",
  );
  await assertMissing(join(repo, starMirrorDir("octocat", "gid1"), "b.md"));
  assertEquals((await loadStarCache(repo)).stars.gid1.updated_at, AT2);
  assert(io2.stdout.includes("synced: 1, skipped: 0, removed: 0"));
});

Deno.test("star sync removes the mirror dir and cache entry for an unstarred gist", async () => {
  const { home, repo } = await fixture();
  const io1 = memoryContext(
    ghRunner(
      [{ id: "gid1", owner: "octocat", description: "desc", updated_at: AT }],
      {
        gid1: {
          owner: "octocat",
          description: "desc",
          updated_at: AT,
          files: { "a.md": { content: "A" } },
        },
      },
    ),
    home,
  );
  assertEquals(await run({ name: "star", args: ["sync"] }, io1.context), 0);

  const io2 = memoryContext(ghRunner([], {}), home);
  assertEquals(await run({ name: "star", args: ["sync"] }, io2.context), 0);
  await assertMissing(join(repo, starMirrorDir("octocat", "gid1")));
  await assertMissing(join(repo, "stars", "octocat"));
  assertEquals((await loadStarCache(repo)).stars, {});
  assert(io2.stdout.includes("synced: 0, skipped: 0, removed: 1"));
});

Deno.test("star sync treats a broken stars.json cache as empty and still succeeds", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, ".gistan", "cache"), { recursive: true });
  await Deno.writeTextFile(starCachePath(repo), "{not json");
  const runner = ghRunner(
    [{ id: "gid1", owner: "octocat", description: "desc", updated_at: AT }],
    {
      gid1: {
        owner: "octocat",
        description: "desc",
        updated_at: AT,
        files: { "a.md": { content: "A" } },
      },
    },
  );
  const io = memoryContext(runner, home);
  assertEquals(await run({ name: "star", args: ["sync"] }, io.context), 0);
  assertEquals(
    await Deno.readTextFile(join(repo, starMirrorDir("octocat", "gid1"), "a.md")),
    "A",
  );
});

// -- star add ------------------------------------------------------------------

Deno.test("parseGistArg accepts owner/id url, bare-id url, and a bare id", () => {
  assertEquals(parseGistArg("https://gist.github.com/octocat/abc123"), "abc123");
  assertEquals(parseGistArg("https://gist.github.com/abc123"), "abc123");
  assertEquals(parseGistArg("abc123"), "abc123");
  assertEquals(parseGistArg("https://gist.github.com/octocat/abc123/"), "abc123");
});

Deno.test("star add stars the gist and mirrors it under stars/<owner>/<id>/", async () => {
  const { home, repo } = await fixture();
  const runner = recordingRunner(
    ghRunner([], {
      abc123: {
        owner: "octocat",
        description: "desc",
        updated_at: AT,
        files: { "a.md": { content: "A" } },
      },
    }),
  );
  const io = memoryContext(runner.runner, home);
  assertEquals(
    await run(
      { name: "star", args: ["add", "https://gist.github.com/octocat/abc123"] },
      io.context,
    ),
    0,
  );
  assert(
    runner.calls.some((c) =>
      c.cmd === "gh" && c.args[1] === "gists/abc123/star" && c.args.includes("PUT")
    ),
  );
  assert(runner.calls.some((c) => c.cmd === "gh" && c.args[1] === "gists/abc123"));
  assertEquals(
    await Deno.readTextFile(join(repo, starMirrorDir("octocat", "abc123"), "a.md")),
    "A",
  );
  assertEquals((await loadStarCache(repo)).stars.abc123.owner, "octocat");
  assert(io.stdout.includes("stars/octocat/abc123/"));
});

Deno.test("star add without an argument is a usage error (exit 2)", async () => {
  const home = await Deno.makeTempDir();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "star", args: ["add"] }, io.context), 2);
  assert(io.stderr.includes("usage"));
});

async function assertMissing(path: string) {
  try {
    await Deno.stat(path);
    throw new Error(`expected missing: ${path}`);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

Deno.test("star sync removes an orphan mirror dir the cache lost track of", async () => {
  const { home, repo } = await fixture();
  // Orphan: a mirror on disk with no cache entry (e.g. stars.json was deleted).
  await Deno.mkdir(join(repo, "stars", "ghost", "gid9"), { recursive: true });
  await Deno.writeTextFile(join(repo, "stars", "ghost", "gid9", "a.md"), "A");
  const io = memoryContext(ghRunner([], {}), home);
  assertEquals(await run({ name: "star", args: ["sync"] }, io.context), 0);
  await assertMissing(join(repo, "stars", "ghost"));
  assert(io.stdout.includes("synced: 0, skipped: 0, removed: 1"));
});
