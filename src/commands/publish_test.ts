import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { saveConfig } from "../core/config.ts";
import type { Runner } from "../core/proc.ts";
import { contentHash } from "../core/snippets.ts";
import type { SnippetEntry } from "../core/state.ts";
import { loadState, saveState } from "../core/state.ts";
import { memoryContext } from "../testing.ts";
import { run } from "./publish.ts";

interface Call {
  cmd: string;
  args: readonly string[];
  stdin?: string;
}

function ghRunner(): { runner: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: Runner = (cmd, args, options) => {
    calls.push({ cmd, args, stdin: options?.stdin });
    if (cmd === "gh" && args[1] === "gists" && args.includes("POST")) {
      return Promise.resolve({ code: 0, stdout: "newid\t2026-03-01T00:00:00Z\n", stderr: "" });
    }
    if (cmd === "gh" && (args[1] ?? "").startsWith("gists/") && args.includes("PATCH")) {
      return Promise.resolve({ code: 0, stdout: "2026-03-02T00:00:00Z\n", stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  return { runner, calls };
}

async function fixture(entry?: SnippetEntry) {
  const home = await Deno.makeTempDir();
  const repo = join(home, "repo");
  await Deno.mkdir(join(repo, "snippets"), { recursive: true });
  await Deno.mkdir(join(repo, ".gistan"), { recursive: true });
  await saveConfig(join(home, "config.toml"), { repo });
  await Deno.writeTextFile(join(repo, "snippets", "note.md"), "hello");
  if (entry !== undefined) {
    await saveState(repo, { version: 1, snippets: { "snippets/note.md": entry } });
  }
  return { home, repo };
}

const HELLO_HASH = await contentHash(new TextEncoder().encode("hello"));

Deno.test("publish creates a public gist with the tag-based description", async () => {
  const { home, repo } = await fixture({ tags: ["react", "example"], gist: null });
  const { runner, calls } = ghRunner();
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "publish", args: ["note.md"] }, io.context), 0);
  assertEquals(io.stdout.includes("https://gist.github.com/newid"), true);

  const post = calls.find((call) => call.cmd === "gh" && call.args.includes("POST"));
  const body = JSON.parse(post?.stdin ?? "{}");
  assertEquals(body.description, "[react][example]: note.md");
  assertEquals(body.public, true);
  assertEquals(body.files["note.md"].content, "hello");

  const state = await loadState(repo);
  assertEquals(state.snippets["snippets/note.md"].gist, {
    id: "newid",
    visibility: "public",
    synced_hash: HELLO_HASH,
    remote_updated_at: "2026-03-01T00:00:00Z",
  });

  const clipboard = calls.find((call) => call.cmd === "pbcopy");
  assertEquals(clipboard?.stdin, "https://gist.github.com/newid");
});

Deno.test("publish is idempotent: unchanged content makes no API call", async () => {
  const { home } = await fixture({
    tags: [],
    gist: {
      id: "g1",
      visibility: "public",
      synced_hash: HELLO_HASH,
      remote_updated_at: "2026-01-01T00:00:00Z",
    },
  });
  const { runner, calls } = ghRunner();
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "publish", args: ["note.md"] }, io.context), 0);
  assertEquals(io.stdout.includes("already up to date"), true);
  assertEquals(calls.filter((call) => call.cmd === "gh").length, 0);
});

Deno.test("publish updates the gist when the content changed", async () => {
  const { home, repo } = await fixture({
    tags: [],
    gist: {
      id: "g1",
      visibility: "public",
      synced_hash: "sha256:before-edit",
      remote_updated_at: "2026-01-01T00:00:00Z",
    },
  });
  const { runner, calls } = ghRunner();
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "publish", args: ["note.md"] }, io.context), 0);
  const patch = calls.find((call) => call.cmd === "gh" && call.args.includes("PATCH"));
  assertEquals(patch?.args[1], "gists/g1");

  const state = await loadState(repo);
  assertEquals(state.snippets["snippets/note.md"].gist?.synced_hash, HELLO_HASH);
  assertEquals(
    state.snippets["snippets/note.md"].gist?.remote_updated_at,
    "2026-03-02T00:00:00Z",
  );
});

Deno.test("publish refuses a visibility change when the user declines", async () => {
  const { home, repo } = await fixture({
    tags: [],
    gist: {
      id: "g1",
      visibility: "public",
      synced_hash: HELLO_HASH,
      remote_updated_at: "2026-01-01T00:00:00Z",
    },
  });
  const { runner, calls } = ghRunner();
  const io = memoryContext(runner, home, { confirmAnswer: false });

  assertEquals(await run({ name: "publish", args: ["note.md", "--secret"] }, io.context), 1);
  assertEquals(io.confirms.length, 1);
  assertEquals(calls.filter((call) => call.cmd === "gh").length, 0);
  const state = await loadState(repo);
  assertEquals(state.snippets["snippets/note.md"].gist?.id, "g1"); // untouched
});

Deno.test("publish recreates the gist on an accepted visibility change", async () => {
  const { home, repo } = await fixture({
    tags: [],
    gist: {
      id: "g1",
      visibility: "public",
      synced_hash: HELLO_HASH,
      remote_updated_at: "2026-01-01T00:00:00Z",
    },
  });
  const { runner, calls } = ghRunner();
  const io = memoryContext(runner, home, { confirmAnswer: true });

  assertEquals(await run({ name: "publish", args: ["note.md", "--secret"] }, io.context), 0);
  assertEquals(io.stdout.includes("the URL has changed"), true);

  const apiCalls = calls.filter((call) => call.cmd === "gh").map((call) => call.args);
  assertEquals(apiCalls[0].includes("DELETE"), true);
  assertEquals(apiCalls[0][1], "gists/g1");
  assertEquals(apiCalls[1].includes("POST"), true);

  const state = await loadState(repo);
  assertEquals(state.snippets["snippets/note.md"].gist?.id, "newid");
  assertEquals(state.snippets["snippets/note.md"].gist?.visibility, "secret");
});

Deno.test("publish reports a missing snippet file", async () => {
  const { home } = await fixture();
  const { runner } = ghRunner();
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "publish", args: ["nope.md"] }, io.context), 1);
  assertEquals(io.stderr.includes("not found"), true);
});
