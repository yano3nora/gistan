import { assert, assertEquals } from "@std/assert";
import { saveState } from "../core/state.ts";
import { AT, fixture, join, memoryContext } from "./test_helpers.ts";
import { run } from "./list.ts";

async function sample() {
  const f = await fixture();
  await Deno.mkdir(join(f.repo, "gists", "local"), { recursive: true });
  await Deno.writeTextFile(join(f.repo, "gists", "local", "a.md"), "A");
  await Deno.mkdir(join(f.repo, "gists", "pub"), { recursive: true });
  await Deno.writeTextFile(join(f.repo, "gists", "pub", "b.md"), "B");
  await saveState(f.repo, {
    version: 2,
    gists: {
      pub: {
        id: "gid",
        visibility: "secret",
        remote_updated_at: AT,
        synced_description_hash: null,
        files: { "b.md": "h" },
      },
    },
  });
  return f;
}

Deno.test("list shows local and published dirs", async () => {
  const { home } = await sample();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "list", args: [] }, io.context), 0);
  assert(io.stdout.includes("local"));
  assert(io.stdout.includes("pub"));
});

Deno.test("list --published filters unpublished dirs", async () => {
  const { home } = await sample();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "list", args: ["--published"] }, io.context), 0);
  assert(io.stdout.includes("pub"));
  assertEquals(io.stdout.includes("local"), false);
});

Deno.test("list --local filters published dirs", async () => {
  const { home } = await sample();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "list", args: ["--local"] }, io.context), 0);
  assert(io.stdout.includes("local"));
  assertEquals(io.stdout.includes("pub"), false);
});

Deno.test("list --stars prints files under stars", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, "stars", "someone"), { recursive: true });
  await Deno.writeTextFile(join(repo, "stars", "someone", "x.md"), "X");
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "list", args: ["--stars"] }, io.context), 0);
  assert(io.stdout.includes("stars/someone/x.md"));
});

Deno.test("list includes index-only dir count", async () => {
  const { home, repo } = await fixture();
  await saveState(repo, {
    version: 2,
    gists: {
      gone: {
        id: "gid",
        visibility: "public",
        remote_updated_at: AT,
        synced_description_hash: null,
        files: { "a.md": "h" },
      },
    },
  });
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "list", args: [] }, io.context), 0);
  assert(io.stdout.includes("gone"));
});

Deno.test("list empty repo prints zero gists", async () => {
  const { home } = await fixture();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "list", args: [] }, io.context), 0);
  assert(io.stdout.includes("0 gist"));
});
