import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { EMPTY_STATE, loadState, saveState, statePath } from "./state.ts";

async function makeRepo(): Promise<string> {
  const repo = await Deno.makeTempDir();
  await Deno.mkdir(join(repo, ".gistan"));
  return repo;
}

Deno.test("save and load round-trips the index", async () => {
  const repo = await makeRepo();
  const state = {
    version: 1 as const,
    snippets: {
      "snippets/a.md": { tags: ["x"], gist: null },
    },
  };
  await saveState(repo, state);
  assertEquals(await loadState(repo), state);
});

Deno.test("save writes snippet keys sorted for stable diffs", async () => {
  const repo = await makeRepo();
  await saveState(repo, {
    version: 1,
    snippets: {
      "snippets/b.md": { tags: [], gist: null },
      "snippets/a.md": { tags: [], gist: null },
    },
  });
  const raw = await Deno.readTextFile(statePath(repo));
  assertEquals(raw.indexOf("snippets/a.md") < raw.indexOf("snippets/b.md"), true);
});

Deno.test("load returns the empty index when the file does not exist", async () => {
  const repo = await Deno.makeTempDir();
  assertEquals(await loadState(repo), EMPTY_STATE);
});

Deno.test("load rejects an index with an unknown version", async () => {
  const repo = await makeRepo();
  await Deno.writeTextFile(statePath(repo), '{ "version": 2, "snippets": {} }');
  await assertRejects(() => loadState(repo), Error, "invalid index");
});
