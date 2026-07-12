import { assert, assertEquals } from "@std/assert";
import type { Runner } from "../core/proc.ts";
import { loadState, saveState } from "../core/state.ts";
import { AT, fixture, join, memoryContext } from "./test_helpers.ts";
import { run } from "./new.ts";

/** Extracts the dir id gistan new prints in "ok: created gists/<dir>/<file> (id: <dir>)". */
function createdId(stdout: string): string {
  const match = stdout.match(/\(id: ([^)]+)\)/);
  if (!match) throw new Error(`no id found in stdout: ${stdout}`);
  return match[1];
}

// Editor + gh/clipboard calls all succeed by default; individual tests override.
function baseRunner(): Runner {
  return () => Promise.resolve({ code: 0, stdout: "", stderr: "" });
}

async function assertMissing(path: string) {
  try {
    await Deno.stat(path);
    throw new Error(`expected missing: ${path}`);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

Deno.test("new filename creates a local-id dir and renders the markdown template", async () => {
  const { home, repo } = await fixture();
  const io = memoryContext(baseRunner(), home);
  assertEquals(await run({ name: "new", args: ["note.md"] }, io.context), 0);
  const id = createdId(io.stdout);
  assert(id.startsWith("_"));
  assertEquals(await Deno.readTextFile(join(repo, "gists", id, "note.md")), "# note\n");
});

Deno.test("new refuses a filename containing a slash", async () => {
  const { home, repo } = await fixture();
  const io = memoryContext(baseRunner(), home);
  assertEquals(await run({ name: "new", args: ["dir/note.md"] }, io.context), 2);
  assert(io.stderr.includes("bare filename"));
  // Nothing was created for the rejected path.
  const entries: string[] = [];
  for await (const e of Deno.readDir(join(repo, "gists"))) entries.push(e.name);
  assertEquals(entries, []);
});

Deno.test("new --public without --publish is rejected", async () => {
  const { home } = await fixture();
  const io = memoryContext(baseRunner(), home);
  assertEquals(await run({ name: "new", args: ["--public", "note.md"] }, io.context), 2);
  assert(io.stderr.includes("--public only makes sense with --publish"));
});

Deno.test("new without arg returns usage", async () => {
  const { home } = await fixture();
  const io = memoryContext(baseRunner(), home);
  assertEquals(await run({ name: "new", args: [] }, io.context), 2);
});

Deno.test("new -d stores the description in state.locals, not a file", async () => {
  const { home, repo } = await fixture();
  const io = memoryContext(baseRunner(), home);
  assertEquals(await run({ name: "new", args: ["-d", "Desc", "note.md"] }, io.context), 0);
  const id = createdId(io.stdout);
  assertEquals((await loadState(repo)).locals[id]?.description, "Desc");
  assertEquals(await Deno.readTextFile(join(repo, "gists", id, "note.md")), "# note\n");
  await assertMissing(join(repo, "gists", id, ".description.txt"));
});

Deno.test("new refuses an existing file", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, "gists", "existing"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "existing", "note.md"), "old");
  const io = memoryContext(baseRunner(), home);
  assertEquals(
    await run({ name: "new", args: ["--id", "existing", "note.md"] }, io.context),
    1,
  );
  assert(io.stderr.includes("already exists"));
});

Deno.test("new uses a custom default template", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, ".gistan", "templates"), { recursive: true });
  await Deno.writeTextFile(join(repo, ".gistan", "templates", "default.md"), "Title {{title}}");
  const io = memoryContext(baseRunner(), home);
  assertEquals(await run({ name: "new", args: ["abc.md"] }, io.context), 0);
  const id = createdId(io.stdout);
  assertEquals(await Deno.readTextFile(join(repo, "gists", id, "abc.md")), "Title abc");
});

Deno.test("new --id adds a file to an existing unpublished dir", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, "gists", "_existing"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "_existing", "a.md"), "A");
  const io = memoryContext(baseRunner(), home);
  assertEquals(
    await run({ name: "new", args: ["--id", "_existing", "b.md"] }, io.context),
    0,
  );
  // b.md renders the (fallback) markdown template, same as a top-level `new b.md`.
  assertEquals(await Deno.readTextFile(join(repo, "gists", "_existing", "b.md")), "# b\n");
  assert(io.stdout.includes("(id: _existing)"));
});

Deno.test("new --id rejects an unknown id", async () => {
  const { home } = await fixture();
  const io = memoryContext(baseRunner(), home);
  assertEquals(
    await run({ name: "new", args: ["--id", "nope", "b.md"] }, io.context),
    1,
  );
  assert(io.stderr.includes("no gist dir for id nope"));
});

Deno.test("new --id -d on a published gist without --publish points at gistan publish -d instead", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, "gists", "gid1"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "gid1", "a.md"), "A");
  await saveState(repo, {
    version: 3,
    gists: {
      gid1: {
        visibility: "secret",
        description: "",
        remote_updated_at: AT,
        files: { "a.md": "h" },
      },
    },
    locals: {},
  });
  const io = memoryContext(baseRunner(), home);
  assertEquals(
    await run({ name: "new", args: ["--id", "gid1", "-d", "New desc", "b.md"] }, io.context),
    1,
  );
  assert(io.stderr.includes("gistan publish gid1 -d"));
});

Deno.test("new --publish creates and publishes in one step, renaming the dir to the gist id", async () => {
  const { home, repo } = await fixture();
  const runner: Runner = (cmd, args) => {
    if (cmd === "gh" && args.includes("POST")) {
      return Promise.resolve({ code: 0, stdout: `newid\t${AT}`, stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: true });
  assertEquals(await run({ name: "new", args: ["--publish", "note.md"] }, io.context), 0);
  assertEquals(await Deno.readTextFile(join(repo, "gists", "newid", "note.md")), "# note\n");
  assertEquals(Object.keys((await loadState(repo)).gists), ["newid"]);
});

Deno.test("new --publish --public creates a public gist", async () => {
  const { home } = await fixture();
  let body = "";
  const runner: Runner = (cmd, args, opt) => {
    if (cmd === "gh" && args.includes("POST")) {
      body = String(opt?.stdin);
      return Promise.resolve({ code: 0, stdout: `newid\t${AT}`, stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: true });
  assertEquals(
    await run({ name: "new", args: ["--publish", "--public", "note.md"] }, io.context),
    0,
  );
  assertEquals(JSON.parse(body).public, true);
});

Deno.test("new opens $EDITOR after creating the file", async () => {
  const { home } = await fixture();
  const calls: string[] = [];
  const runner: Runner = (cmd) => {
    calls.push(cmd);
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { editor: "vi" });
  assertEquals(await run({ name: "new", args: ["note.md"] }, io.context), 0);
  assert(calls.includes("vi"));
});
