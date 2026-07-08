import { assert, assertEquals } from "@std/assert";
import type { Runner } from "../core/proc.ts";
import { loadState, saveState } from "../core/state.ts";
import { AT, AT2, fixture, join, memoryContext } from "./test_helpers.ts";
import { run } from "./publish.ts";

async function oneFile() {
  const f = await fixture();
  await Deno.mkdir(join(f.repo, "gists", "one"), { recursive: true });
  await Deno.writeTextFile(join(f.repo, "gists", "one", "a.md"), "A");
  return f;
}

Deno.test("publish create excludes .description.txt from gist files", async () => {
  const { home, repo } = await oneFile();
  await Deno.writeTextFile(join(repo, "gists", "one", ".description.txt"), "Desc\n");
  let body = "";
  const runner: Runner = (_c, args, opt) => {
    if (args.includes("POST")) {
      body = String(opt?.stdin);
      return Promise.resolve({ code: 0, stdout: `gid\t${AT}`, stderr: "" });
    }
    return Promise.resolve({ code: 127, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: true });
  assertEquals(await run({ name: "publish", args: ["one"] }, io.context), 0);
  const payload = JSON.parse(body);
  assertEquals(payload.description, "Desc");
  assertEquals(Object.keys(payload.files), ["a.md"]);
  assert(!(".description.txt" in payload.files));
  // Creating public must be an explicit opt-in (--public); default is secret.
  assertEquals(payload.public, false);
});

Deno.test("publish update sends changed files and deleted files as null", async () => {
  const { home, repo } = await oneFile();
  await Deno.writeTextFile(join(repo, "gists", "one", "a.md"), "A2");
  await saveState(repo, {
    version: 2,
    gists: {
      one: {
        id: "gid",
        visibility: "public",
        remote_updated_at: AT,
        synced_description_hash: null,
        files: { "a.md": "old", "b.md": "old" },
      },
    },
  });
  let body = "";
  const runner: Runner = (_c, args, opt) => {
    if (args.includes("PATCH")) {
      body = String(opt?.stdin);
      return Promise.resolve({ code: 0, stdout: AT2, stderr: "" });
    }
    return Promise.resolve({ code: 127, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: true });
  assertEquals(await run({ name: "publish", args: ["one"] }, io.context), 0);
  const payload = JSON.parse(body);
  assertEquals(payload.files["b.md"], null);
  assert("a.md" in payload.files);
  assertEquals((await loadState(repo)).gists.one.remote_updated_at, AT2);
});

Deno.test("publish clears remote description when description file is removed", async () => {
  const { home, repo } = await oneFile();
  await saveState(repo, {
    version: 2,
    gists: {
      one: {
        id: "gid",
        visibility: "public",
        remote_updated_at: AT,
        synced_description_hash: "sha256:old",
        files: { "a.md": "old" },
      },
    },
  });
  let body = "";
  const runner: Runner = (_c, args, opt) => {
    if (args.includes("PATCH")) {
      body = String(opt?.stdin);
      return Promise.resolve({ code: 0, stdout: AT2, stderr: "" });
    }
    return Promise.resolve({ code: 127, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: true });
  assertEquals(await run({ name: "publish", args: ["one"] }, io.context), 0);
  assertEquals(JSON.parse(body).description, "");
  assertEquals((await loadState(repo)).gists.one.synced_description_hash, null);
});

Deno.test("publish refuses directory with only reserved description", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, "gists", "one"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "one", ".description.txt"), "Desc");
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "publish", args: ["one"] }, io.context), 1);
  assert(io.stderr.includes("no publishable files"));
});

Deno.test("publish refuses nested files", async () => {
  const { home, repo } = await oneFile();
  await Deno.mkdir(join(repo, "gists", "one", "nested"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "one", "nested", "b.md"), "B");
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "publish", args: ["one"] }, io.context), 1);
  assert(io.stderr.includes("nested files"));
});

Deno.test("publish visibility change recreates gist after extra confirmation", async () => {
  const { home, repo } = await oneFile();
  await saveState(repo, {
    version: 2,
    gists: {
      one: {
        id: "old",
        visibility: "public",
        remote_updated_at: AT,
        synced_description_hash: null,
        files: { "a.md": "old" },
      },
    },
  });
  const calls: string[] = [];
  const runner: Runner = (_c, args) => {
    calls.push(args.join(" "));
    if (args.includes("POST")) {
      return Promise.resolve({ code: 0, stdout: `new\t${AT2}`, stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: true });
  assertEquals(await run({ name: "publish", args: ["one", "--secret"] }, io.context), 0);
  assert(calls.some((c) => c.includes("DELETE")));
  assertEquals((await loadState(repo)).gists.one.id, "new");
});

Deno.test("import then publish updates existing gist instead of creating a duplicate", async () => {
  const { home, repo } = await oneFile();
  await saveState(repo, {
    version: 2,
    gists: {
      one: {
        id: "gid",
        visibility: "public",
        remote_updated_at: AT,
        synced_description_hash: null,
        files: { "a.md": "old" },
      },
    },
  });
  const calls: string[] = [];
  const runner: Runner = (_c, args) => {
    calls.push(args.join(" "));
    if (args.includes("PATCH")) return Promise.resolve({ code: 0, stdout: AT2, stderr: "" });
    return Promise.resolve({ code: 127, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: true });
  assertEquals(await run({ name: "publish", args: ["one"] }, io.context), 0);
  assertEquals(calls.some((c) => c.includes("POST")), false);
  assert(calls.some((c) => c.includes("PATCH")));
});
