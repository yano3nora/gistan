import { assert, assertEquals } from "@std/assert";
import type { Runner } from "../core/proc.ts";
import { contentHash } from "../core/snippets.ts";
import { loadState, saveState } from "../core/state.ts";
import { AT, AT2, fixture, join, memoryContext } from "./test_helpers.ts";
import { run } from "./pull.ts";

async function published(local = "A", synced = "A", description = "") {
  const f = await fixture();
  await Deno.mkdir(join(f.repo, "gists", "one"), { recursive: true });
  await Deno.writeTextFile(join(f.repo, "gists", "one", "a.md"), local);
  await saveState(f.repo, {
    version: 3,
    gists: {
      one: {
        visibility: "public",
        description,
        remote_updated_at: AT,
        files: { "a.md": await contentHash(new TextEncoder().encode(synced)) },
      },
    },
    locals: {},
  });
  return f;
}

/** Fakes `gh api gists?...` (list) and `gh api gists/<id>` (detail) for one gist. */
function runner(
  id: string,
  remote: { updated_at: string; content: string; description?: string },
): Runner {
  return (cmd, args) => {
    if (cmd === "gh" && args[1] === "gists?per_page=100") {
      return Promise.resolve({
        code: 0,
        stdout: `${id}\t${remote.updated_at}\ttrue\n`,
        stderr: "",
      });
    }
    if (cmd === "gh" && args[1] === `gists/${id}`) {
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          description: remote.description ?? "",
          updated_at: remote.updated_at,
          files: { "a.md": { filename: "a.md", content: remote.content } },
        }),
        stderr: "",
      });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
}

async function assertMissing(path: string) {
  try {
    await Deno.stat(path);
    throw new Error(`expected missing: ${path}`);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

Deno.test("pull with no remote drift prints no remote drift and changes nothing", async () => {
  const { home, repo } = await published();
  const io = memoryContext(runner("one", { updated_at: AT, content: "A" }), home);
  assertEquals(await run({ name: "pull", args: [] }, io.context), 0);
  assert(io.stdout.includes("no remote drift"));
  assertEquals(await Deno.readTextFile(join(repo, "gists", "one", "a.md")), "A");
});

Deno.test("pull lists remote drift, applies remote files on confirm, and updates the index", async () => {
  const { home, repo } = await published();
  // "stale.md" is already synced (present locally AND in the index), so adding
  // it does not itself create local drift — only the remote side moves here,
  // by no longer listing it, which is what should make pull delete it locally.
  await Deno.writeTextFile(join(repo, "gists", "one", "stale.md"), "stale");
  const before = await loadState(repo);
  await saveState(repo, {
    version: 3,
    gists: {
      one: {
        ...before.gists.one,
        files: {
          ...before.gists.one.files,
          "stale.md": await contentHash(new TextEncoder().encode("stale")),
        },
      },
    },
    locals: {},
  });
  const io = memoryContext(
    runner("one", { updated_at: AT2, content: "Remote", description: "New desc" }),
    home,
    { confirmAnswer: true },
  );
  assertEquals(await run({ name: "pull", args: [] }, io.context), 0);
  assert(io.stdout.includes("remote drift:"));
  assert(io.stdout.includes("one"));
  assertEquals(await Deno.readTextFile(join(repo, "gists", "one", "a.md")), "Remote");
  await assertMissing(join(repo, "gists", "one", "stale.md"));
  const state = await loadState(repo);
  assertEquals(state.gists.one.description, "New desc");
  assertEquals(state.gists.one.remote_updated_at, AT2);
});

Deno.test("pull decline aborts without changing local files", async () => {
  const { home, repo } = await published();
  const io = memoryContext(
    runner("one", { updated_at: AT2, content: "Remote" }),
    home,
    { confirmAnswer: false },
  );
  assertEquals(await run({ name: "pull", args: [] }, io.context), 1);
  assert(io.stderr.includes("aborted"));
  assertEquals(await Deno.readTextFile(join(repo, "gists", "one", "a.md")), "A");
});

Deno.test("pull skips a conflict item and points to status --fix", async () => {
  const { home, repo } = await published("local-changed", "A");
  const io = memoryContext(
    runner("one", { updated_at: AT2, content: "Remote" }),
    home,
    { confirmAnswer: true },
  );
  assertEquals(await run({ name: "pull", args: [] }, io.context), 0);
  assert(io.stderr.includes("status --fix"));
  assert(io.stdout.includes("no remote drift"));
  assertEquals(await Deno.readTextFile(join(repo, "gists", "one", "a.md")), "local-changed");
});

Deno.test("pull skips a remote-deleted item and points to status --fix", async () => {
  const { home } = await published();
  const r: Runner = (cmd, args) => {
    if (cmd === "gh" && args[1] === "gists?per_page=100") {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" }); // "one" not listed = deleted upstream
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(r, home);
  assertEquals(await run({ name: "pull", args: [] }, io.context), 0);
  assert(io.stderr.includes("status --fix"));
});

Deno.test("pull reports a per-item failure and exits 1 while continuing other gists", async () => {
  const { home, repo } = await published();
  await Deno.mkdir(join(repo, "gists", "two"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "two", "b.md"), "B");
  const twoHash = await contentHash(new TextEncoder().encode("B"));
  const state = await loadState(repo);
  await saveState(repo, {
    version: 3,
    gists: {
      ...state.gists,
      two: {
        visibility: "public",
        description: "",
        remote_updated_at: AT,
        files: { "b.md": twoHash },
      },
    },
    locals: {},
  });
  const r: Runner = (cmd, args) => {
    if (cmd === "gh" && args[1] === "gists?per_page=100") {
      return Promise.resolve({
        code: 0,
        stdout: `one\t${AT2}\ttrue\ntwo\t${AT2}\ttrue\n`,
        stderr: "",
      });
    }
    if (cmd === "gh" && args[1] === "gists/one") {
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          description: "",
          updated_at: AT2,
          files: { "a.md": { filename: "a.md", content: "R" } },
        }),
        stderr: "",
      });
    }
    if (cmd === "gh" && args[1] === "gists/two") {
      return Promise.resolve({ code: 1, stdout: "", stderr: "boom" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(r, home, { confirmAnswer: true });
  assertEquals(await run({ name: "pull", args: [] }, io.context), 1);
  assertEquals(await Deno.readTextFile(join(repo, "gists", "one", "a.md")), "R");
  assert(io.stderr.includes("failed to pull two"));
});

Deno.test("pull returns the gh list failure", async () => {
  const { home } = await published();
  const io = memoryContext(() => Promise.resolve({ code: 1, stdout: "", stderr: "bad" }), home);
  assertEquals(await run({ name: "pull", args: [] }, io.context), 1);
  assert(io.stderr.includes("gh api gists failed"));
});

Deno.test("pull skips a gist whose remote has truncated files, leaving local files and index untouched", async () => {
  const { home, repo } = await published();
  const r: Runner = (cmd, args) => {
    if (cmd === "gh" && args[1] === "gists?per_page=100") {
      return Promise.resolve({ code: 0, stdout: `one\t${AT2}\ttrue\n`, stderr: "" });
    }
    if (cmd === "gh" && args[1] === "gists/one") {
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          description: "",
          updated_at: AT2,
          files: { "a.md": { filename: "a.md", truncated: true } },
        }),
        stderr: "",
      });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(r, home, { confirmAnswer: true });
  assertEquals(await run({ name: "pull", args: [] }, io.context), 1);
  assert(io.stderr.includes("truncated"));
  // The local counterpart of an unfetchable file must never be deleted, and
  // the gist must not be recorded as synced (pre-v3 pull had that data-loss bug).
  assertEquals(await Deno.readTextFile(join(repo, "gists", "one", "a.md")), "A");
  assertEquals((await loadState(repo)).gists.one.remote_updated_at, AT);
});
