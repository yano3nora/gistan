import { assert, assertEquals } from "@std/assert";
import { saveState } from "../core/state.ts";
import { AT, fixture, join, memoryContext } from "./test_helpers.ts";
import { run } from "./list.ts";

async function sample() {
  const f = await fixture();
  await Deno.mkdir(join(f.repo, "gists", "_local1"), { recursive: true });
  await Deno.writeTextFile(join(f.repo, "gists", "_local1", "a.md"), "A");
  await Deno.mkdir(join(f.repo, "gists", "pub"), { recursive: true });
  await Deno.writeTextFile(join(f.repo, "gists", "pub", "b.md"), "B");
  await saveState(f.repo, {
    version: 3,
    gists: {
      pub: { visibility: "secret", description: "", remote_updated_at: AT, files: { "b.md": "h" } },
    },
    locals: {},
  });
  return f;
}

Deno.test("list shows one line per file with the gist url or local id", async () => {
  const { home } = await sample();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "list", args: [] }, io.context), 0);
  assert(io.stdout.includes("a.md"));
  assert(io.stdout.includes("(id: _local1)"));
  assert(io.stdout.includes("b.md"));
  assert(io.stdout.includes("https://gist.github.com/pub (secret)"));
  // Dirnames/ids are hidden from the display path itself (ADR-0003).
  assertEquals(io.stdout.includes("gists/"), false);
});

Deno.test("list appends the description when the gist has one", async () => {
  const { home, repo } = await sample();
  await saveState(repo, {
    version: 3,
    gists: {
      pub: {
        visibility: "secret",
        description: "My notes",
        remote_updated_at: AT,
        files: { "b.md": "h" },
      },
    },
    locals: { _local1: { description: "Draft" } },
  });
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "list", args: [] }, io.context), 0);
  assert(
    io.stdout.includes(
      `${"b.md".padEnd(32)} https://gist.github.com/pub (secret)  — My notes`,
    ),
  );
  assert(io.stdout.includes(`${"a.md".padEnd(32)} (id: _local1)  — Draft`));
});

Deno.test("list sorts lines by filename across gists", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, "gists", "_x"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "_x", "z.md"), "Z");
  await Deno.writeTextFile(join(repo, "gists", "_x", "a.md"), "A");
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "list", args: [] }, io.context), 0);
  assert(io.stdout.indexOf("a.md") < io.stdout.indexOf("z.md"));
});

Deno.test("list --published filters unpublished files", async () => {
  const { home } = await sample();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "list", args: ["--published"] }, io.context), 0);
  assert(io.stdout.includes("b.md"));
  assertEquals(io.stdout.includes("a.md"), false);
});

Deno.test("list --local filters published files", async () => {
  const { home } = await sample();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "list", args: ["--local"] }, io.context), 0);
  assert(io.stdout.includes("a.md"));
  assertEquals(io.stdout.includes("b.md"), false);
});

Deno.test("list --stars shows display paths with the id segment removed and cache descriptions", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, "stars", "someone", "abc123"), { recursive: true });
  await Deno.writeTextFile(join(repo, "stars", "someone", "abc123", "x.md"), "X");
  await Deno.mkdir(join(repo, ".gistan", "cache"), { recursive: true });
  await Deno.writeTextFile(
    join(repo, ".gistan", "cache", "stars.json"),
    JSON.stringify({
      version: 1,
      stars: {
        abc123: { owner: "someone", description: "Starred notes", updated_at: AT, fetched_at: AT },
      },
    }),
  );
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "list", args: ["--stars"] }, io.context), 0);
  assert(io.stdout.includes("stars/someone/x.md"));
  assertEquals(io.stdout.includes("abc123"), false);
  assert(io.stdout.includes("— Starred notes"));
  assert(io.stdout.includes("1 starred file(s)"));
});

Deno.test("list includes an index-only gist (missing local dir) in the gist count", async () => {
  const { home, repo } = await fixture();
  await saveState(repo, {
    version: 3,
    gists: {
      gone: {
        visibility: "public",
        description: "",
        remote_updated_at: AT,
        files: { "a.md": "h" },
      },
    },
    locals: {},
  });
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "list", args: [] }, io.context), 0);
  assert(io.stdout.includes("a.md"));
  assert(io.stdout.includes("1 gist(s), 1 file(s)"));
});

Deno.test("list empty repo prints zero gists", async () => {
  const { home } = await fixture();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "list", args: [] }, io.context), 0);
  assert(io.stdout.includes("0 gist(s), 0 file(s)"));
});
