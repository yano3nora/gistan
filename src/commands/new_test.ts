import { assert, assertEquals, assertRejects } from "@std/assert";
import { fixture, join, memoryContext } from "./test_helpers.ts";
import { run } from "./new.ts";

Deno.test("new filename creates stem directory and markdown template", async () => {
  const { home, repo } = await fixture();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "new", args: ["note.md"] }, io.context), 0);
  assertEquals(await Deno.readTextFile(join(repo, "gists", "note", "note.md")), "# note\n");
});

Deno.test("new dirname/file creates file inside explicit dir", async () => {
  const { home, repo } = await fixture();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "new", args: ["memo/a.txt"] }, io.context), 0);
  assertEquals(await Deno.readTextFile(join(repo, "gists", "memo", "a.txt")), "");
});

Deno.test("new -d writes reserved description metadata", async () => {
  const { home, repo } = await fixture();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "new", args: ["-d", "Desc", "note.md"] }, io.context), 0);
  assertEquals(await Deno.readTextFile(join(repo, "gists", "note", ".description.txt")), "Desc");
});

Deno.test("new warns when creating reserved filename", async () => {
  const { home } = await fixture();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "new", args: ["one/.description.txt"] }, io.context), 0);
  assert(io.stderr.includes("reserved"));
});

Deno.test("new refuses existing file", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, "gists", "note"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "note", "note.md"), "old");
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "new", args: ["note.md"] }, io.context), 1);
});

Deno.test("new uses custom default template", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, ".gistan", "templates"), { recursive: true });
  await Deno.writeTextFile(join(repo, ".gistan", "templates", "default.md"), "Title {{title}}");
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "new", args: ["abc.md"] }, io.context), 0);
  assertEquals(await Deno.readTextFile(join(repo, "gists", "abc", "abc.md")), "Title abc");
});

Deno.test("new without arg returns usage", async () => {
  const { home } = await fixture();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "new", args: [] }, io.context), 2);
});

Deno.test("new strips a habitual gists/ prefix", async () => {
  const { home, repo } = await fixture();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "new", args: ["gists/memo/a.txt"] }, io.context), 0);
  assertEquals(await Deno.readTextFile(join(repo, "gists", "memo", "a.txt")), "");
});

Deno.test("new refuses nesting deeper than gists/<dirname>/<filename>", async () => {
  const { home, repo } = await fixture();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "new", args: ["a/b/c.md"] }, io.context), 2);
  assert(io.stderr.includes("deepest layout"));
  // Nothing was created for the rejected path.
  await assertRejects(() => Deno.stat(join(repo, "gists", "a")), Deno.errors.NotFound);
});
