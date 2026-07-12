import { assert, assertEquals } from "@std/assert";
import type { Runner } from "../core/proc.ts";
import { loadState, saveState } from "../core/state.ts";
import { AT, fixture, join, memoryContext } from "./test_helpers.ts";
import { run } from "./import.ts";

function importRunner(items: unknown[], details: Record<string, unknown>): Runner {
  let listed = false;
  return (cmd, args) => {
    if (cmd === "gh" && args[1]?.startsWith("gists?")) {
      if (listed) return Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
      listed = true;
      return Promise.resolve({ code: 0, stdout: JSON.stringify(items), stderr: "" });
    }
    if (cmd === "gh" && args[1]?.startsWith("gists/")) {
      const id = args[1].split("/")[1];
      return Promise.resolve({ code: 0, stdout: JSON.stringify(details[id]), stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
}

async function assertMissing(path: string) {
  try {
    await Deno.stat(path);
    throw new Error(`expected missing: ${path}`);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

Deno.test("import creates gists/<gist-id>/ directly and stores description in the index", async () => {
  const { home, repo } = await fixture();
  const items = [{ id: "g1", description: "My Gist", public: true, updated_at: AT }];
  const details = {
    g1: {
      files: {
        "a.md": { filename: "a.md", content: "A" },
        "b.ts": { filename: "b.ts", content: "B" },
      },
    },
  };
  const io = memoryContext(importRunner(items, details), home);
  assertEquals(await run({ name: "import", args: [] }, io.context), 0);
  assertEquals(await Deno.readTextFile(join(repo, "gists", "g1", "a.md")), "A");
  assertEquals(await Deno.readTextFile(join(repo, "gists", "g1", "b.ts")), "B");
  const state = await loadState(repo);
  assertEquals(state.gists.g1.description, "My Gist");
  assertEquals(state.gists.g1.visibility, "public");
  // No reserved description file — description lives only in the index (ADR-0003).
  await assertMissing(join(repo, "gists", "g1", ".description.txt"));
});

Deno.test("import skips an already indexed gist id on re-import", async () => {
  const { home, repo } = await fixture();
  await saveState(repo, {
    version: 3,
    gists: {
      g1: { visibility: "public", description: "", remote_updated_at: AT, files: {} },
    },
    locals: {},
  });
  const io = memoryContext(
    importRunner([{ id: "g1", description: "Again", public: true, updated_at: AT }], {}),
    home,
  );
  assertEquals(await run({ name: "import", args: [] }, io.context), 0);
  assert(io.stdout.includes("0 imported, 1 skipped"));
});

Deno.test("import confirms override when an unindexed dir has the same gist id", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, "gists", "g1"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "g1", "old.md"), "old");
  const io = memoryContext(
    importRunner([{ id: "g1", description: "Same", public: true, updated_at: AT }], {
      g1: { files: { "a.md": { filename: "a.md", content: "A" } } },
    }),
    home,
    { confirmAnswer: true },
  );
  assertEquals(await run({ name: "import", args: [] }, io.context), 0);
  assert(io.confirms.some((c) => c.includes("Override")));
  await assertMissing(join(repo, "gists", "g1", "old.md"));
  assertEquals(await Deno.readTextFile(join(repo, "gists", "g1", "a.md")), "A");
});

Deno.test("import decline override skips the gist and leaves the dir untouched", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, "gists", "g1"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "g1", "old.md"), "old");
  const io = memoryContext(
    importRunner([{ id: "g1", description: "Same", public: true, updated_at: AT }], {
      g1: { files: { "a.md": { filename: "a.md", content: "A" } } },
    }),
    home,
    { confirmAnswer: false },
  );
  assertEquals(await run({ name: "import", args: [] }, io.context), 0);
  assertEquals((await loadState(repo)).gists.g1, undefined);
  assertEquals(await Deno.readTextFile(join(repo, "gists", "g1", "old.md")), "old");
});

Deno.test("import fails a gist with no files", async () => {
  const { home } = await fixture();
  const io = memoryContext(
    importRunner([{ id: "g1", description: "Empty", public: true, updated_at: AT }], {
      g1: { files: {} },
    }),
    home,
  );
  assertEquals(await run({ name: "import", args: [] }, io.context), 1);
  assert(io.stderr.includes("gist has no files"));
});

Deno.test("import reports a truncated file as a per-item failure", async () => {
  const { home } = await fixture();
  const io = memoryContext(
    importRunner([{ id: "g1", description: "Bad", public: true, updated_at: AT }], {
      g1: { files: { "big.md": { filename: "big.md", truncated: true } } },
    }),
    home,
  );
  assertEquals(await run({ name: "import", args: [] }, io.context), 1);
  assert(io.stderr.includes("truncated"));
  assert(io.stdout.includes("0 imported, 0 skipped, 1 failed"));
});

Deno.test("import returns error for an invalid --limit", async () => {
  const { home } = await fixture();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "import", args: ["--limit", "0"] }, io.context), 2);
});
