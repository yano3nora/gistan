import { assert, assertEquals } from "@std/assert";
import { loadState, saveState } from "../core/state.ts";
import { AT, fixture, join, memoryContext } from "./test_helpers.ts";
import { run } from "./unpublish.ts";

async function pub(description = "") {
  const f = await fixture();
  await Deno.mkdir(join(f.repo, "gists", "one"), { recursive: true });
  await Deno.writeTextFile(join(f.repo, "gists", "one", "a.md"), "A");
  await saveState(f.repo, {
    version: 3,
    gists: {
      one: { visibility: "public", description, remote_updated_at: AT, files: { "a.md": "h" } },
    },
    locals: {},
  });
  return f;
}

async function assertMissing(path: string) {
  try {
    await Deno.stat(path);
    throw new Error(`expected missing: ${path}`);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

Deno.test("unpublish without a target returns usage", async () => {
  const { home } = await fixture();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "unpublish", args: [] }, io.context), 2);
  assert(io.stderr.includes("usage: gistan unpublish"));
});

Deno.test("unpublish deletes the remote gist and renames the dir to a fresh local id", async () => {
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
  const state = await loadState(repo);
  assertEquals(state.gists.one, undefined);
  await assertMissing(join(repo, "gists", "one"));
  const newDirs: string[] = [];
  for await (const e of Deno.readDir(join(repo, "gists"))) newDirs.push(e.name);
  assertEquals(newDirs.length, 1);
  const newId = newDirs[0];
  assert(newId.startsWith("_"));
  assertEquals(await Deno.readTextFile(join(repo, "gists", newId, "a.md")), "A");
  assert(io.stdout.includes(`gists/${newId}`));
});

Deno.test("unpublish carries a non-empty description into locals", async () => {
  const { home, repo } = await pub("Keep me");
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home, {
    confirmAnswer: true,
  });
  assertEquals(await run({ name: "unpublish", args: ["one"] }, io.context), 0);
  const state = await loadState(repo);
  const newIds = Object.keys(state.locals);
  assertEquals(newIds.length, 1);
  assertEquals(state.locals[newIds[0]].description, "Keep me");
});

Deno.test("unpublish with an empty description does not add a locals entry", async () => {
  const { home, repo } = await pub("");
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home, {
    confirmAnswer: true,
  });
  assertEquals(await run({ name: "unpublish", args: ["one"] }, io.context), 0);
  assertEquals(Object.keys((await loadState(repo)).locals).length, 0);
});

Deno.test("unpublish abort leaves the index untouched", async () => {
  const { home, repo } = await pub();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home, {
    confirmAnswer: false,
  });
  assertEquals(await run({ name: "unpublish", args: ["one"] }, io.context), 1);
  assertEquals((await loadState(repo)).gists.one.visibility, "public");
});

Deno.test("unpublish errors for an id that is not published", async () => {
  const { home } = await fixture();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "unpublish", args: ["one"] }, io.context), 1);
  assert(io.stderr.includes("not a published gist"));
});

Deno.test("unpublish reports a delete failure", async () => {
  const { home } = await pub();
  const io = memoryContext(() => Promise.resolve({ code: 1, stdout: "", stderr: "bad" }), home, {
    confirmAnswer: true,
  });
  assertEquals(await run({ name: "unpublish", args: ["one"] }, io.context), 1);
  assert(io.stderr.includes("gist delete failed"));
});

Deno.test("unpublish accepts a gist URL target", async () => {
  const { home, repo } = await pub();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home, {
    confirmAnswer: true,
  });
  assertEquals(
    await run({ name: "unpublish", args: ["https://gist.github.com/owner/one"] }, io.context),
    0,
  );
  assertEquals((await loadState(repo)).gists.one, undefined);
});

Deno.test("unpublish with no local dir on disk reports no local dir", async () => {
  const { home, repo } = await pub();
  await Deno.remove(join(repo, "gists", "one"), { recursive: true });
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home, {
    confirmAnswer: true,
  });
  assertEquals(await run({ name: "unpublish", args: ["one"] }, io.context), 0);
  assert(io.stdout.includes("no local dir"));
});
