import { assert, assertEquals } from "@std/assert";
import { contentHash } from "../core/snippets.ts";
import { loadState, saveState } from "../core/state.ts";
import { AT, fixture, join, memoryContext } from "./test_helpers.ts";
import { run } from "./status.ts";

async function published() {
  const f = await fixture();
  await Deno.mkdir(join(f.repo, "gists", "one"), { recursive: true });
  await Deno.writeTextFile(join(f.repo, "gists", "one", "a.md"), "A");
  await saveState(f.repo, {
    version: 2,
    gists: {
      one: {
        id: "gid",
        visibility: "public",
        remote_updated_at: AT,
        synced_description_hash: null,
        files: { "a.md": await contentHash(new TextEncoder().encode("A")) },
      },
    },
  });
  return f;
}

Deno.test("status default does not call gh", async () => {
  const { home } = await published();
  const calls: string[] = [];
  const io = memoryContext((cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  }, home);
  assertEquals(await run({ name: "status", args: [] }, io.context), 0);
  assertEquals(calls.filter((c) => c.startsWith("gh ")), []);
});

Deno.test("status warns for bare and nested files", async () => {
  const { home, repo } = await fixture();
  await Deno.writeTextFile(join(repo, "gists", "bare.md"), "B");
  await Deno.mkdir(join(repo, "gists", "one", "nested"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "one", "nested", "x.md"), "X");
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "status", args: [] }, io.context), 0);
  assert(io.stderr.includes("not managed"));
  assert(io.stderr.includes("nested too deeply"));
});

Deno.test("status --remote reports remote drift", async () => {
  const { home } = await published();
  const io = memoryContext((cmd, args) => {
    if (cmd === "gh" && args[1] === "gists?per_page=100") {
      return Promise.resolve({ code: 0, stdout: "gid\tT2\ttrue\n", stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  }, home);
  assertEquals(await run({ name: "status", args: ["--remote"] }, io.context), 0);
  assert(io.stdout.includes("remote-drift"));
});

Deno.test("status --fix can unlink remote-deleted", async () => {
  const { home, repo } = await published();
  const io = memoryContext(
    (cmd, args) => {
      if (cmd === "gh" && args[1] === "gists?per_page=100") {
        return Promise.resolve({
          code: 0,
          stdout: "",
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    home,
    { confirmAnswer: true },
  );
  assertEquals(await run({ name: "status", args: ["--fix"] }, io.context), 0);
  assertEquals((await loadState(repo)).gists.one, undefined);
});

Deno.test("status --fix restores missing local dir from remote", async () => {
  const { home, repo } = await published();
  await Deno.remove(join(repo, "gists", "one"), { recursive: true });
  const io = memoryContext(
    (cmd, args) => {
      if (cmd === "gh" && args[1] === "gists?per_page=100") {
        return Promise.resolve({
          code: 0,
          stdout: `gid\t${AT}\ttrue\n`,
          stderr: "",
        });
      }
      if (cmd === "gh" && args[1] === "gists/gid") {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ files: { "a.md": { filename: "a.md", content: "A" } } }),
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    home,
    { confirmAnswer: true },
  );
  assertEquals(await run({ name: "status", args: ["--fix"] }, io.context), 0);
  assertEquals(await Deno.readTextFile(join(repo, "gists", "one", "a.md")), "A");
});

Deno.test("status --fix can delete orphan gist when restore declined", async () => {
  const { home, repo } = await published();
  await Deno.remove(join(repo, "gists", "one"), { recursive: true });
  const calls: string[] = [];
  const io = memoryContext(
    (cmd, args) => {
      calls.push(args.join(" "));
      if (cmd === "gh" && args[1] === "gists?per_page=100") {
        return Promise.resolve({
          code: 0,
          stdout: `gid\t${AT}\ttrue\n`,
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    home,
    { confirmAnswer: [false, true] },
  );
  assertEquals(await run({ name: "status", args: ["--fix"] }, io.context), 0);
  assert(calls.some((c) => c.includes("DELETE")));
  assertEquals((await loadState(repo)).gists.one, undefined);
});

Deno.test("status filter limits output to one dir", async () => {
  const { home, repo } = await published();
  await Deno.mkdir(join(repo, "gists", "two"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "two", "b.md"), "B");
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "status", args: ["one"] }, io.context), 0);
  assert(io.stdout.includes("one"));
  assertEquals(io.stdout.includes("two"), false);
});

// -- default hidden conditions / --all / dirname filter (TASK-260708) -------

Deno.test("status default hides a published gist (offline: remote-unknown), but the summary still prints", async () => {
  // published() has no --remote, so "one" reconciles to remote-unknown
  // (displayed as "published") rather than in-sync — still in the hidden set.
  const { home } = await published();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "status", args: [] }, io.context), 0);
  assertEquals(io.stdout.includes("one"), false);
  assert(io.stdout.includes("1 gist(s): 1 published"));
});

Deno.test("status default shows drift conditions alongside a hidden published majority", async () => {
  const { home, repo } = await published(); // "one" reconciles to remote-unknown/published
  await Deno.mkdir(join(repo, "gists", "two"), { recursive: true }); // unpublished: not hidden
  await Deno.writeTextFile(join(repo, "gists", "two", "b.md"), "B");
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "status", args: [] }, io.context), 0);
  assertEquals(io.stdout.includes("one"), false);
  assert(io.stdout.includes("two"));
  assert(io.stdout.includes("2 gist(s): 1 published, 1 unpublished"));
});

Deno.test("status --remote also hides a genuinely in-sync gist by default, --all shows it", async () => {
  const { home } = await published();
  const inSyncRunner = (cmd: string, args: readonly string[]) => {
    if (cmd === "gh" && args[1] === "gists?per_page=100") {
      return Promise.resolve({ code: 0, stdout: `gid\t${AT}\ttrue\n`, stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const hidden = memoryContext(inSyncRunner, home);
  assertEquals(await run({ name: "status", args: ["--remote"] }, hidden.context), 0);
  assertEquals(hidden.stdout.includes("one"), false);
  assert(hidden.stdout.includes("1 gist(s): 1 in-sync"));

  const shown = memoryContext(inSyncRunner, home);
  assertEquals(await run({ name: "status", args: ["--remote", "--all"] }, shown.context), 0);
  assert(shown.stdout.includes("one"));
});

Deno.test("status --all restores the full listing, including a hidden published gist", async () => {
  const { home } = await published();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "status", args: ["--all"] }, io.context), 0);
  assert(io.stdout.includes("one"));
});

Deno.test("a dirname filter always shows its item even when in-sync", async () => {
  const { home } = await published();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "status", args: ["one"] }, io.context), 0);
  assert(io.stdout.includes("one"));
});

Deno.test("a dirname filter that matches nothing is a lookup error, not an empty repo", async () => {
  const { home } = await published();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "status", args: ["nope"] }, io.context), 1);
  assert(io.stderr.includes("nope not found"));
  assert(!io.stdout.includes("no gists yet"));
});
