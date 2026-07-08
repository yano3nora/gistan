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
