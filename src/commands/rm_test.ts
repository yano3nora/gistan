import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { saveConfig } from "../core/config.ts";
import type { Runner } from "../core/proc.ts";
import { loadState, saveState } from "../core/state.ts";
import { memoryContext } from "../testing.ts";
import { run } from "./rm.ts";

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
        tags: [],
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

function recording() {
  const calls: string[] = [];
  const runner: Runner = (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  return { runner, calls };
}

Deno.test("rm deletes the file, the gist (on confirm), and the entry", async () => {
  const { home, repo } = await fixture();
  const { runner, calls } = recording();
  const io = memoryContext(runner, home, { confirmAnswer: [true, true] });

  assertEquals(await run({ name: "rm", args: ["note.md"] }, io.context), 0);
  assertEquals(io.confirms.length, 2);
  assertEquals(calls.some((call) => call.includes("gists/g1") && call.includes("DELETE")), true);
  assertEquals((await loadState(repo)).snippets["snippets/note.md"], undefined);
  let gone = false;
  try {
    await Deno.stat(join(repo, "snippets", "note.md"));
  } catch {
    gone = true;
  }
  assertEquals(gone, true);
});

Deno.test("rm keeps the gist when the second confirm is declined", async () => {
  const { home, repo } = await fixture();
  const { runner, calls } = recording();
  const io = memoryContext(runner, home, { confirmAnswer: [true, false] });

  assertEquals(await run({ name: "rm", args: ["note.md"] }, io.context), 0);
  assertEquals(calls.some((call) => call.includes("DELETE")), false);
  assertEquals(io.stdout.includes("unmanaged"), true);
  assertEquals((await loadState(repo)).snippets["snippets/note.md"], undefined);
});

Deno.test("rm aborts entirely when the first confirm is declined", async () => {
  const { home, repo } = await fixture();
  const { runner, calls } = recording();
  const io = memoryContext(runner, home, { confirmAnswer: [false] });

  assertEquals(await run({ name: "rm", args: ["note.md"] }, io.context), 1);
  assertEquals(calls.some((call) => call.includes("DELETE")), false);
  assertEquals(await Deno.readTextFile(join(repo, "snippets", "note.md")), "hello");
});

Deno.test("rm refuses stars paths", async () => {
  const { home } = await fixture();
  const { runner } = recording();
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "rm", args: ["stars/octo/g1/x.md"] }, io.context), 1);
  assertEquals(io.stderr.includes("read-only mirror"), true);
});
