import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { saveConfig } from "../core/config.ts";
import type { Runner } from "../core/proc.ts";
import { loadState, saveState } from "../core/state.ts";
import { memoryContext } from "../testing.ts";
import { run } from "./unpublish.ts";

async function fixture() {
  const home = await Deno.makeTempDir();
  const repo = join(home, "repo");
  await Deno.mkdir(join(repo, "snippets"), { recursive: true });
  await Deno.mkdir(join(repo, ".gistan"), { recursive: true });
  await saveConfig(join(home, "config.toml"), { repo });
  await Deno.writeTextFile(join(repo, "snippets", "note.md"), "hello");
  await saveState(repo, {
    version: 1,
    snippets: {
      "snippets/note.md": {
        tags: ["keep"],
        gist: {
          id: "g1",
          visibility: "public",
          synced_hash: "sha256:x",
          remote_updated_at: "2026-01-01T00:00:00Z",
        },
      },
    },
  });
  return { home, repo };
}

Deno.test("unpublish deletes the gist but keeps the file and tags", async () => {
  const { home, repo } = await fixture();
  const calls: string[] = [];
  const runner: Runner = (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: true });

  assertEquals(await run({ name: "unpublish", args: ["note.md"] }, io.context), 0);
  assertEquals(calls.some((call) => call.includes("gists/g1") && call.includes("DELETE")), true);
  const state = await loadState(repo);
  assertEquals(state.snippets["snippets/note.md"], { tags: ["keep"], gist: null });
  assertEquals(await Deno.readTextFile(join(repo, "snippets", "note.md")), "hello");
});

Deno.test("unpublish rejects an unpublished snippet", async () => {
  const { home, repo } = await fixture();
  await Deno.writeTextFile(join(repo, "snippets", "local.md"), "x");
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);

  assertEquals(await run({ name: "unpublish", args: ["local.md"] }, io.context), 1);
  assertEquals(io.stderr.includes("not published"), true);
});
