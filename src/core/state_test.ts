import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { loadState, saveState } from "./state.ts";

Deno.test("state v3 load/save round-trip with sorted gists and locals keys", async () => {
  const repo = await Deno.makeTempDir();
  await saveState(repo, {
    version: 3,
    gists: {
      b: {
        visibility: "secret",
        description: "",
        remote_updated_at: "t",
        files: { "z.ts": "h2", "a.ts": "h1" },
      },
      a: {
        visibility: "public",
        description: "desc",
        remote_updated_at: "t",
        files: { "x.md": "h" },
      },
    },
    locals: {
      _b: { description: "later" },
      _a: { description: "" },
    },
  });
  assertEquals(await loadState(repo), {
    version: 3,
    gists: {
      a: {
        visibility: "public",
        description: "desc",
        remote_updated_at: "t",
        files: { "x.md": "h" },
      },
      b: {
        visibility: "secret",
        description: "",
        remote_updated_at: "t",
        files: { "a.ts": "h1", "z.ts": "h2" },
      },
    },
    locals: {
      _a: { description: "" },
      _b: { description: "later" },
    },
  });
});

Deno.test("missing index file loads as an empty v3 index", async () => {
  const repo = await Deno.makeTempDir();
  assertEquals(await loadState(repo), { version: 3, gists: {}, locals: {} });
});

Deno.test("state v1 is rejected with a re-import guidance message", async () => {
  const repo = await Deno.makeTempDir();
  await Deno.mkdir(join(repo, ".gistan"), { recursive: true });
  await Deno.writeTextFile(
    join(repo, ".gistan", "state.json"),
    JSON.stringify({ version: 1, snippets: {} }),
  );
  await assertRejects(() => loadState(repo), Error, "index schema v1 detected");
});

Deno.test("state v2 is rejected with a re-import guidance message pointing at ADR-0003", async () => {
  const repo = await Deno.makeTempDir();
  await Deno.mkdir(join(repo, ".gistan"), { recursive: true });
  await Deno.writeTextFile(
    join(repo, ".gistan", "state.json"),
    JSON.stringify({ version: 2, gists: {} }),
  );
  await assertRejects(() => loadState(repo), Error, "index schema v2 detected");
  await assertRejects(() => loadState(repo), Error, "gistan new");
});

Deno.test("an unparsable/invalid index throws a restore-from-git-history error", async () => {
  const repo = await Deno.makeTempDir();
  await Deno.mkdir(join(repo, ".gistan"), { recursive: true });
  await Deno.writeTextFile(
    join(repo, ".gistan", "state.json"),
    JSON.stringify({ version: 3, gists: null }),
  );
  await assertRejects(() => loadState(repo), Error, "restore it from git history");
});

Deno.test("a v3 index missing the locals section normalizes to an empty object", async () => {
  const repo = await Deno.makeTempDir();
  await Deno.mkdir(join(repo, ".gistan"), { recursive: true });
  await Deno.writeTextFile(
    join(repo, ".gistan", "state.json"),
    JSON.stringify({ version: 3, gists: {} }),
  );
  assertEquals(await loadState(repo), { version: 3, gists: {}, locals: {} });
});

Deno.test("saveState writes atomically and leaves no temp file behind", async () => {
  const repo = await Deno.makeTempDir();
  await saveState(repo, { version: 3, gists: {}, locals: {} });
  const names: string[] = [];
  for await (const entry of Deno.readDir(join(repo, ".gistan"))) names.push(entry.name);
  assertEquals(names, ["state.json"]);
});
