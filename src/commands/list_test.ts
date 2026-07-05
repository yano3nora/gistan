import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { saveConfig } from "../core/config.ts";
import { saveState } from "../core/state.ts";
import { memoryContext } from "../testing.ts";
import { run as runList } from "./list.ts";
import { run as runRoot } from "./root.ts";

const ok = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });

async function fixture() {
  const home = await Deno.makeTempDir();
  const repo = join(home, "repo");
  await Deno.mkdir(join(repo, "snippets"), { recursive: true });
  await Deno.mkdir(join(repo, ".gistan"), { recursive: true });
  await saveConfig(join(home, "config.toml"), { repo });
  await Deno.writeTextFile(join(repo, "snippets", "a.md"), "a");
  await Deno.writeTextFile(join(repo, "snippets", "b.md"), "b");
  await saveState(repo, {
    version: 1,
    snippets: {
      "snippets/a.md": {
        tags: ["react"],
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

Deno.test("list shows tags and publish state; filters work", async () => {
  const { home } = await fixture();

  const all = memoryContext(ok, home);
  assertEquals(await runList({ name: "list", args: [] }, all.context), 0);
  assertEquals(all.stdout.includes("[react]"), true);
  assertEquals(all.stdout.includes("https://gist.github.com/g1"), true);
  assertEquals(all.stdout.includes("2 snippet(s)"), true);

  const published = memoryContext(ok, home);
  assertEquals(await runList({ name: "list", args: ["--published"] }, published.context), 0);
  assertEquals(published.stdout.includes("a.md"), true);
  assertEquals(published.stdout.includes("b.md"), false);

  const tagged = memoryContext(ok, home);
  assertEquals(await runList({ name: "list", args: ["--tag", "nope"] }, tagged.context), 0);
  assertEquals(tagged.stdout.includes("0 snippet(s)"), true);
});

Deno.test("root prints the repo path", async () => {
  const { home, repo } = await fixture();
  const io = memoryContext(ok, home);

  assertEquals(await runRoot({ name: "root", args: [] }, io.context), 0);
  assertEquals(io.stdout, `${repo}\n`);
});
