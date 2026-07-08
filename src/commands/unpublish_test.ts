import { assert, assertEquals } from "@std/assert";
import { loadState, saveState } from "../core/state.ts";
import { AT, fixture, join, memoryContext } from "./test_helpers.ts";
import { run } from "./unpublish.ts";

async function pub() {
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
        files: { "a.md": "h" },
      },
    },
  });
  return f;
}

Deno.test("unpublish deletes remote and removes index but keeps local files", async () => {
  const { home, repo } = await pub();
  const calls: string[] = [];
  const io = memoryContext(
    (_c, args) => {
      calls.push(args.join(" "));
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    home,
    { confirmAnswer: true },
  );
  assertEquals(await run({ name: "unpublish", args: ["one"] }, io.context), 0);
  assert(calls.some((c) => c.includes("DELETE")));
  assertEquals((await loadState(repo)).gists.one, undefined);
  assertEquals(await Deno.readTextFile(join(repo, "gists", "one", "a.md")), "A");
});

Deno.test("unpublish abort leaves index", async () => {
  const { home, repo } = await pub();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home, {
    confirmAnswer: false,
  });
  assertEquals(await run({ name: "unpublish", args: ["one"] }, io.context), 1);
  assertEquals((await loadState(repo)).gists.one.id, "gid");
});

Deno.test("unpublish errors for unpublished dir", async () => {
  const { home } = await fixture();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "unpublish", args: ["one"] }, io.context), 1);
  assert(io.stderr.includes("not published"));
});

Deno.test("unpublish reports delete failure", async () => {
  const { home } = await pub();
  const io = memoryContext(() => Promise.resolve({ code: 1, stdout: "", stderr: "bad" }), home, {
    confirmAnswer: true,
  });
  assertEquals(await run({ name: "unpublish", args: ["one"] }, io.context), 1);
  assert(io.stderr.includes("gist delete failed"));
});

Deno.test("unpublish accepts gists/dir/file target", async () => {
  const { home, repo } = await pub();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home, {
    confirmAnswer: true,
  });
  assertEquals(await run({ name: "unpublish", args: ["gists/one/a.md"] }, io.context), 0);
  assertEquals((await loadState(repo)).gists.one, undefined);
});

Deno.test("unpublish with no pick and fzf abort is no-op", async () => {
  const { home } = await pub();
  const io = memoryContext(
    (cmd) => Promise.resolve({ code: cmd === "fzf" ? 130 : 0, stdout: "", stderr: "" }),
    home,
  );
  assertEquals(await run({ name: "unpublish", args: [] }, io.context), 0);
});
