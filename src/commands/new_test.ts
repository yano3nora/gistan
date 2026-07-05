import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { saveConfig } from "../core/config.ts";
import { loadState } from "../core/state.ts";
import { memoryContext } from "../testing.ts";
import { run } from "./new.ts";

async function fixture() {
  const home = await Deno.makeTempDir();
  const repo = join(home, "repo");
  await Deno.mkdir(join(repo, "snippets"), { recursive: true });
  await Deno.mkdir(join(repo, ".gistan"), { recursive: true });
  await saveConfig(join(home, "config.toml"), { repo });
  return { home, repo };
}

const ok = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });

Deno.test("new creates an md from the template, registers tags, opens the editor", async () => {
  const { home, repo } = await fixture();
  const io = memoryContext(ok, home, { editor: "vim" });

  assertEquals(
    await run({ name: "new", args: ["--tags", "react,example", "note.md"] }, io.context),
    0,
  );
  // No custom template in the fixture — the fallback applies with {{title}} replaced.
  assertEquals(await Deno.readTextFile(join(repo, "snippets", "note.md")), "# note\n");
  const state = await loadState(repo);
  assertEquals(state.snippets["snippets/note.md"], { tags: ["react", "example"], gist: null });
});

Deno.test("new refuses duplicates and directory paths", async () => {
  const { home, repo } = await fixture();
  await Deno.writeTextFile(join(repo, "snippets", "dup.md"), "x");
  const io = memoryContext(ok, home);

  assertEquals(await run({ name: "new", args: ["dup.md"] }, io.context), 1);
  assertEquals(io.stderr.includes("already exists"), true);

  const io2 = memoryContext(ok, home);
  assertEquals(await run({ name: "new", args: ["sub/dir.md"] }, io2.context), 2);
  assertEquals(io2.stderr.includes("flat"), true);
});
