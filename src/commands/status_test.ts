import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { saveConfig } from "../core/config.ts";
import type { Runner } from "../core/proc.ts";
import { contentHash } from "../core/snippets.ts";
import { saveState } from "../core/state.ts";
import { memoryContext } from "../testing.ts";
import { run } from "./status.ts";

const SYNCED_AT = "2026-01-01T00:00:00Z";

/**
 * Fixture: a.md published & in-sync (g1), b.md published & locally edited (g2),
 * c.md untracked, d.md gone from disk but still in the index (g3).
 */
async function makeFixture() {
  const home = await Deno.makeTempDir();
  const repo = join(home, "repo");
  await Deno.mkdir(join(repo, "snippets"), { recursive: true });
  await Deno.mkdir(join(repo, ".gistan"), { recursive: true });
  await saveConfig(join(home, "config.toml"), { repo });

  await Deno.writeTextFile(join(repo, "snippets", "a.md"), "content a");
  await Deno.writeTextFile(join(repo, "snippets", "b.md"), "content b (edited)");
  await Deno.writeTextFile(join(repo, "snippets", "c.md"), "content c");

  const hashA = await contentHash(new TextEncoder().encode("content a"));
  await saveState(repo, {
    version: 1,
    snippets: {
      "snippets/a.md": {
        tags: [],
        gist: {
          id: "g1",
          visibility: "public",
          synced_hash: hashA,
          remote_updated_at: SYNCED_AT,
        },
      },
      "snippets/b.md": {
        tags: [],
        gist: {
          id: "g2",
          visibility: "secret",
          synced_hash: "sha256:before-edit",
          remote_updated_at: SYNCED_AT,
        },
      },
      "snippets/d.md": {
        tags: [],
        gist: {
          id: "g3",
          visibility: "public",
          synced_hash: "sha256:whatever",
          remote_updated_at: SYNCED_AT,
        },
      },
    },
  });
  return home;
}

const remoteOk: Runner = (cmd, args) => {
  if (cmd === "gh" && args[0] === "api") {
    return Promise.resolve({
      code: 0,
      stdout: `g1\t${SYNCED_AT}\ttrue\ng2\t${SYNCED_AT}\tfalse\ng3\t${SYNCED_AT}\ttrue\n`,
      stderr: "",
    });
  }
  return Promise.resolve({ code: 0, stdout: "", stderr: "" });
};

Deno.test("status --remote classifies snippets and prints a summary", async () => {
  const home = await makeFixture();
  const io = memoryContext(remoteOk, home);

  assertEquals(await run({ name: "status", args: ["--remote"] }, io.context), 0);
  assertEquals(io.stdout.includes("in-sync (public)"), true);
  assertEquals(io.stdout.includes("https://gist.github.com/g1"), true);
  assertEquals(io.stdout.includes("local-drift"), true);
  assertEquals(io.stdout.includes("unpublished"), true);
  assertEquals(io.stdout.includes("file-missing"), true);
  assertEquals(io.stdout.includes("4 snippet(s):"), true);
  assertEquals(io.stdout.includes("snippets/"), false); // structural prefix hidden
});

Deno.test("status is local-only by default: fast, no API call", async () => {
  const home = await makeFixture();
  const ghCalls: string[] = [];
  const recording: Runner = (cmd, args, options) => {
    if (cmd === "gh") {
      ghCalls.push(args.join(" "));
    }
    return remoteOk(cmd, args, options);
  };
  const io = memoryContext(recording, home);

  assertEquals(await run({ name: "status", args: [] }, io.context), 0);
  assertEquals(ghCalls, []); // never touches the network without --remote
  assertEquals(io.stdout.includes("published (public)"), true); // a.md, unchanged
  assertEquals(io.stdout.includes("local-drift"), true); // b.md, judged locally
  assertEquals(io.stdout.includes("add --remote"), true); // hint
});

Deno.test("status filters by bare filename", async () => {
  const home = await makeFixture();
  const io = memoryContext(remoteOk, home);

  assertEquals(await run({ name: "status", args: ["c.md"] }, io.context), 0);
  assertEquals(io.stdout.includes("c.md"), true);
  assertEquals(io.stdout.includes("a.md"), false);
});

Deno.test("status --remote degrades to local judgement when gh fails", async () => {
  const home = await makeFixture();
  const failing: Runner = () => Promise.resolve({ code: 1, stdout: "", stderr: "boom" });
  const io = memoryContext(failing, home);

  assertEquals(await run({ name: "status", args: ["--remote"] }, io.context), 0);
  assertEquals(io.stderr.includes("remote check skipped"), true);
  assertEquals(io.stdout.includes("published (public)"), true); // a.md: no local change
  assertEquals(io.stdout.includes("local-drift"), true); // b.md: judged without remote
});

Deno.test("status requires init to have run", async () => {
  const home = await Deno.makeTempDir();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);

  assertEquals(await run({ name: "status", args: [] }, io.context), 1);
  assertEquals(io.stderr.includes("gistan init"), true);
});
