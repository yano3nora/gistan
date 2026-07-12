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
    version: 2,
    gists: {
      one: {
        id: "gid",
        visibility: "public",
        remote_updated_at: AT,
        synced_description_hash: null,
        files: { "a.md": "ha", "b.md": "hb" },
      },
    },
  });
  return f;
}

Deno.test("rm updates index after deleting a published gist file remotely", async () => {
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

Deno.test("rm description file is local-only and does not PATCH or count as last gist file", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, "gists", "one"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "one", "a.md"), "A");
  await Deno.writeTextFile(join(repo, "gists", "one", ".description.txt"), "D");
  await saveState(repo, {
    version: 2,
    gists: {
      one: {
        id: "gid",
        visibility: "public",
        remote_updated_at: AT,
        synced_description_hash: "dh",
        files: { "a.md": "ha" },
      },
    },
  });
  const calls: string[] = [];
  const runner: Runner = (_c, args) => {
    calls.push(args.join(" "));
    return Promise.resolve({ code: 0, stdout: AT2, stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: true });
  assertEquals(await run({ name: "rm", args: ["one/.description.txt"] }, io.context), 0);
  assertEquals(calls.some((c) => c.includes("PATCH") || c.includes("DELETE")), false);
  assertEquals(io.confirms.some((c) => c.includes("last gist file")), false);
  assertEquals((await loadState(repo)).gists.one.synced_description_hash, "dh");
});

Deno.test("rm asks gist deletion for the last publishable file", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, "gists", "one"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "one", "a.md"), "A");
  await saveState(repo, {
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
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home, {
    confirmAnswer: [true, false],
  });
  assertEquals(await run({ name: "rm", args: ["one/a.md"] }, io.context), 0);
  assert(io.confirms.some((c) => c.includes("last gist file")));
});

Deno.test("rm removes index when last file deletion also deletes gist", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, "gists", "one"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "one", "a.md"), "A");
  await saveState(repo, {
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
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home, {
    confirmAnswer: true,
  });
  assertEquals(await run({ name: "rm", args: ["one/a.md"] }, io.context), 0);
  assertEquals((await loadState(repo)).gists.one, undefined);
});

Deno.test("rm refuses stars mirror", async () => {
  const { home } = await fixture();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "rm", args: ["stars/x.md"] }, io.context), 1);
  assert(io.stderr.includes("read-only"));
});

Deno.test("rm abort keeps file", async () => {
  const { home, repo } = await publishedTwo();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home, {
    confirmAnswer: false,
  });
  assertEquals(await run({ name: "rm", args: ["one/a.md"] }, io.context), 1);
  assertEquals(await Deno.readTextFile(join(repo, "gists", "one", "a.md")), "A");
});

Deno.test("rm errors for missing file", async () => {
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
