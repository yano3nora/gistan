import { assert, assertEquals } from "@std/assert";
import type { Runner } from "../core/proc.ts";
import { loadState, saveState } from "../core/state.ts";
import { AT, AT2, fixture, join, memoryContext } from "./test_helpers.ts";
import { run } from "./rm.ts";

async function publishedTwo() {
  const f = await fixture();
  await Deno.mkdir(join(f.repo, "gists", "one"), { recursive: true });
  await Deno.writeTextFile(join(f.repo, "gists", "one", "a.md"), "A");
  await Deno.writeTextFile(join(f.repo, "gists", "one", "b.md"), "B");
  await saveState(f.repo, {
    version: 3,
    gists: {
      one: {
        visibility: "public",
        description: "",
        remote_updated_at: AT,
        files: { "a.md": "ha", "b.md": "hb" },
      },
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

Deno.test("rm updates the index after deleting a published gist file remotely", async () => {
  const { home, repo } = await publishedTwo();
  let body = "";
  const runner: Runner = (_c, args, opt) => {
    if (args.includes("PATCH")) {
      body = String(opt?.stdin);
      return Promise.resolve({ code: 0, stdout: AT2, stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: true });
  assertEquals(await run({ name: "rm", args: ["one/a.md"] }, io.context), 0);
  assertEquals(JSON.parse(body).files["a.md"], null);
  assertEquals((await loadState(repo)).gists.one.files, { "b.md": "hb" });
  assertEquals((await loadState(repo)).gists.one.remote_updated_at, AT2);
});

Deno.test("rm asks for gist deletion when removing the last publishable file", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, "gists", "one"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "one", "a.md"), "A");
  await saveState(repo, {
    version: 3,
    gists: {
      one: { visibility: "public", description: "", remote_updated_at: AT, files: { "a.md": "h" } },
    },
    locals: {},
  });
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home, {
    confirmAnswer: [true, false],
  });
  assertEquals(await run({ name: "rm", args: ["one/a.md"] }, io.context), 0);
  assert(io.confirms.some((c) => c.includes("last gist file")));
});

Deno.test("rm removes the index entry when last-file deletion also deletes the gist", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, "gists", "one"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "one", "a.md"), "A");
  await saveState(repo, {
    version: 3,
    gists: {
      one: { visibility: "public", description: "", remote_updated_at: AT, files: { "a.md": "h" } },
    },
    locals: {},
  });
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home, {
    confirmAnswer: true,
  });
  assertEquals(await run({ name: "rm", args: ["one/a.md"] }, io.context), 0);
  assertEquals((await loadState(repo)).gists.one, undefined);
});

Deno.test("rm cleans up a dangling locals entry when the now-empty unpublished dir is removed", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, "gists", "_local1"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "_local1", "a.md"), "A");
  await saveState(repo, {
    version: 3,
    gists: {},
    locals: { _local1: { description: "Draft" } },
  });
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home, {
    confirmAnswer: true,
  });
  assertEquals(await run({ name: "rm", args: ["_local1/a.md"] }, io.context), 0);
  assertEquals((await loadState(repo)).locals._local1, undefined);
  await assertMissing(join(repo, "gists", "_local1"));
});

Deno.test("rm refuses the stars mirror", async () => {
  const { home } = await fixture();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "rm", args: ["stars/x.md"] }, io.context), 1);
  assert(io.stderr.includes("read-only"));
});

Deno.test("rm abort keeps the file", async () => {
  const { home, repo } = await publishedTwo();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home, {
    confirmAnswer: false,
  });
  assertEquals(await run({ name: "rm", args: ["one/a.md"] }, io.context), 1);
  assertEquals(await Deno.readTextFile(join(repo, "gists", "one", "a.md")), "A");
});

Deno.test("rm errors for a missing file", async () => {
  const { home } = await fixture();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "rm", args: ["one/a.md"] }, io.context), 1);
  assert(io.stderr.includes("not found"));
});

Deno.test("rm rejects a nested pick instead of crashing on the directory", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, "gists", "one", "sub"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "one", "sub", "x.md"), "X");
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home, {
    confirmAnswer: true,
  });
  assertEquals(await run({ name: "rm", args: ["one/sub/x.md"] }, io.context), 1);
  assert(io.stderr.includes("choose a file under gists/"));
  assertEquals(await Deno.readTextFile(join(repo, "gists", "one", "sub", "x.md")), "X");
});
