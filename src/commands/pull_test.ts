import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { saveConfig } from "../core/config.ts";
import type { Runner } from "../core/proc.ts";
import { contentHash } from "../core/snippets.ts";
import { loadState, saveState } from "../core/state.ts";
import { memoryContext } from "../testing.ts";
import { run } from "./pull.ts";

const OLD_AT = "2026-01-01T00:00:00Z";
const NEW_AT = "2026-02-01T00:00:00Z";

/** One published snippet; remote has newer content ("remote edit"). */
async function fixture(localContent: string, syncedContent: string) {
  const home = await Deno.makeTempDir();
  const repo = join(home, "repo");
  await Deno.mkdir(join(repo, "snippets"), { recursive: true });
  await Deno.mkdir(join(repo, ".gistan"), { recursive: true });
  await saveConfig(join(home, "config.toml"), { repo });
  await Deno.writeTextFile(join(repo, "snippets", "note.md"), localContent);
  await saveState(repo, {
    version: 1,
    snippets: {
      "snippets/note.md": {
        tags: [],
        gist: {
          id: "g1",
          visibility: "public",
          synced_hash: await contentHash(new TextEncoder().encode(syncedContent)),
          remote_updated_at: OLD_AT,
        },
      },
    },
  });
  return { home, repo };
}

function remoteRunner(remoteContent: string): Runner {
  return (cmd, args) => {
    if (cmd === "gh" && args[1] === "gists?per_page=100") {
      return Promise.resolve({ code: 0, stdout: `g1\t${NEW_AT}\ttrue\n`, stderr: "" });
    }
    if (cmd === "gh" && args[1] === "gists/g1") {
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          files: { "note.md": { filename: "note.md", content: remoteContent } },
        }),
        stderr: "",
      });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" }); // git diff etc.
  };
}

Deno.test("pull applies remote drift automatically", async () => {
  // local == last-synced, remote moved on → clean fast-forward.
  const { home, repo } = await fixture("synced", "synced");
  const io = memoryContext(remoteRunner("remote edit"), home);

  assertEquals(await run({ name: "pull", args: [] }, io.context), 0);
  assertEquals(io.stdout.includes("pulled: note.md"), true);
  assertEquals(await Deno.readTextFile(join(repo, "snippets", "note.md")), "remote edit");

  const gist = (await loadState(repo)).snippets["snippets/note.md"].gist;
  assertEquals(gist?.remote_updated_at, NEW_AT);
  assertEquals(gist?.synced_hash, await contentHash(new TextEncoder().encode("remote edit")));
  assertEquals(io.confirms.length, 0); // no conflict, no prompt
});

Deno.test("pull conflict: declining keeps the local version", async () => {
  const { home, repo } = await fixture("local edit", "synced");
  const io = memoryContext(remoteRunner("remote edit"), home, { confirmAnswer: false });

  assertEquals(await run({ name: "pull", args: [] }, io.context), 0);
  assertEquals(io.confirms.length, 1);
  assertEquals(await Deno.readTextFile(join(repo, "snippets", "note.md")), "local edit");
  assertEquals(io.stdout.includes("local kept"), true);
});

Deno.test("pull conflict: accepting takes the remote version", async () => {
  const { home, repo } = await fixture("local edit", "synced");
  const io = memoryContext(remoteRunner("remote edit"), home, { confirmAnswer: true });

  assertEquals(await run({ name: "pull", args: [] }, io.context), 0);
  assertEquals(await Deno.readTextFile(join(repo, "snippets", "note.md")), "remote edit");
  assertEquals(io.stdout.includes("conflict resolved as remote"), true);
});

Deno.test("pull warns about gists deleted upstream", async () => {
  const { home } = await fixture("synced", "synced");
  const runner: Runner = (cmd, args) => {
    if (cmd === "gh" && args[1] === "gists?per_page=100") {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" }); // g1 gone
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "pull", args: [] }, io.context), 0);
  assertEquals(io.stderr.includes("deleted upstream"), true);
});
