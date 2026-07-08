import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { loadState, saveState } from "./state.ts";
Deno.test("state v2 load/save round-trip with sorted keys", async () => {
  const repo = await Deno.makeTempDir();
  await saveState(repo, {
    version: 2,
    gists: {
      b: {
        id: "2",
        visibility: "secret",
        remote_updated_at: "t",
        synced_description_hash: null,
        files: { "z.ts": "h2", "a.ts": "h1" },
      },
      a: {
        id: "1",
        visibility: "public",
        remote_updated_at: "t",
        synced_description_hash: "dh",
        files: { "x.md": "h" },
      },
    },
  });
  assertEquals(await loadState(repo), {
    version: 2,
    gists: {
      a: {
        id: "1",
        visibility: "public",
        remote_updated_at: "t",
        synced_description_hash: "dh",
        files: { "x.md": "h" },
      },
      b: {
        id: "2",
        visibility: "secret",
        remote_updated_at: "t",
        synced_description_hash: null,
        files: { "a.ts": "h1", "z.ts": "h2" },
      },
    },
  });
});
Deno.test("state v1 is rejected with restructure guidance", async () => {
  const repo = await Deno.makeTempDir();
  await Deno.mkdir(join(repo, ".gistan"), { recursive: true });
  await Deno.writeTextFile(
    join(repo, ".gistan", "state.json"),
    JSON.stringify({ version: 1, snippets: {} }),
  );
  await assertRejects(() => loadState(repo), Error, "index schema v1 detected");
});
