import { assert, assertEquals } from "@std/assert";
import type { Runner } from "../core/proc.ts";
import { loadState, saveState } from "../core/state.ts";
import { AT, fixture, join, memoryContext } from "./test_helpers.ts";
import { run } from "./import.ts";

function importRunner(items: unknown[], details: Record<string, unknown>): Runner {
  let listed = false;
  return (cmd, args) => {
    if (cmd === "gitleaks") return Promise.resolve({ code: 0, stdout: "", stderr: "" });
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

Deno.test("import multi-file gist creates dir, files, description and index", async () => {
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
  assertEquals(await Deno.readTextFile(join(repo, "gists", "my-gist", "a.md")), "A");
  assertEquals(
    await Deno.readTextFile(join(repo, "gists", "my-gist", ".description.txt")),
    "My Gist",
  );
  assertEquals((await loadState(repo)).gists["my-gist"].id, "g1");
});

Deno.test("import skips already indexed gist id on re-import", async () => {
  const { home, repo } = await fixture();
  await saveState(repo, {
    version: 2,
    gists: {
      existing: {
        id: "g1",
        visibility: "public",
        remote_updated_at: AT,
        synced_description_hash: null,
        files: {},
      },
    },
  });
  const io = memoryContext(
    importRunner([{ id: "g1", description: "Again", public: true, updated_at: AT }], {}),
    home,
  );
  assertEquals(await run({ name: "import", args: [] }, io.context), 0);
  assert(io.stdout.includes("0 imported, 1 skipped"));
});

Deno.test("import uses id suffix when slug collides with indexed dir", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, "gists", "same"), { recursive: true });
  await saveState(repo, {
    version: 2,
    gists: {
      same: {
        id: "old",
        visibility: "public",
        remote_updated_at: AT,
        synced_description_hash: null,
        files: {},
      },
    },
  });
  const id = "abcdef123456";
  const io = memoryContext(
    importRunner([{ id, description: "Same", public: false, updated_at: AT }], {
      [id]: { files: { "a.md": { filename: "a.md", content: "A" } } },
    }),
    home,
  );
  assertEquals(await run({ name: "import", args: [] }, io.context), 0);
  assertEquals(await Deno.readTextFile(join(repo, "gists", "same--abcdef12", "a.md")), "A");
});

Deno.test("import confirms override when unindexed dir has same generated name", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, "gists", "same"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "same", "old.md"), "old");
  const io = memoryContext(
    importRunner([{ id: "g1", description: "Same", public: true, updated_at: AT }], {
      g1: { files: { "a.md": { filename: "a.md", content: "A" } } },
    }),
    home,
    { confirmAnswer: true },
  );
  assertEquals(await run({ name: "import", args: [] }, io.context), 0);
  assert(io.confirms.some((c) => c.includes("Override")));
  await assertMissing(join(repo, "gists", "same", "old.md"));
});

Deno.test("import decline override skips gist", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, "gists", "same"), { recursive: true });
  const io = memoryContext(
    importRunner([{ id: "g1", description: "Same", public: true, updated_at: AT }], {
      g1: { files: { "a.md": { filename: "a.md", content: "A" } } },
    }),
    home,
    { confirmAnswer: false },
  );
  assertEquals(await run({ name: "import", args: [] }, io.context), 0);
  assertEquals((await loadState(repo)).gists.same, undefined);
});

Deno.test("import warns and skips gist containing reserved description filename", async () => {
  const { home } = await fixture();
  const io = memoryContext(
    importRunner([{ id: "g1", description: "Bad", public: true, updated_at: AT }], {
      g1: { files: { ".description.txt": { filename: ".description.txt", content: "x" } } },
    }),
    home,
  );
  assertEquals(await run({ name: "import", args: [] }, io.context), 0);
  assert(io.stderr.includes("reserved .description.txt"));
  assert(io.stdout.includes("0 imported, 1 skipped"));
});

Deno.test("import fails if gitleaks is missing", async () => {
  const { home } = await fixture();
  const io = memoryContext(
    (cmd) => Promise.resolve({ code: cmd === "gitleaks" ? 127 : 0, stdout: "", stderr: "" }),
    home,
  );
  assertEquals(await run({ name: "import", args: [] }, io.context), 1);
  assert(io.stderr.includes("gitleaks is required"));
});

Deno.test("import returns error for invalid limit", async () => {
  const { home } = await fixture();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "import", args: ["--limit", "0"] }, io.context), 2);
});

async function assertMissing(path: string) {
  try {
    await Deno.stat(path);
    throw new Error("expected missing");
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}
