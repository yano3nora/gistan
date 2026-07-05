import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { saveConfig } from "../core/config.ts";
import type { Runner } from "../core/proc.ts";
import { EXIT_COMMAND_NOT_FOUND } from "../core/proc.ts";
import { loadState } from "../core/state.ts";
import { memoryContext } from "../testing.ts";
import { run } from "./import.ts";

const PAGE1 = JSON.stringify([
  {
    id: "g1aaaaaaaa",
    description: "[react][example]: memo stuff",
    public: true,
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "g2bbbbbbbb",
    description: "[multi]: My Cool Notes",
    public: false,
    updated_at: "2026-01-02T00:00:00Z",
  },
  { id: "g3cccccccc", description: "", public: true, updated_at: "2026-01-03T00:00:00Z" },
]);

const DETAILS: Record<string, unknown> = {
  g1aaaaaaaa: { files: { "memo.md": { filename: "memo.md", content: "g1 content" } } },
  g2bbbbbbbb: {
    files: {
      "a.md": { filename: "a.md", content: "multi a" },
      "b.sh": { filename: "b.sh", content: "multi b" },
    },
  },
  g3cccccccc: { files: { "memo.md": { filename: "memo.md", content: "g3 content" } } },
};

function importRunner(options: { gitleaksCode?: number } = {}) {
  const calls: string[] = [];
  const runner: Runner = (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "gitleaks" && args[0] === "dir") {
      return Promise.resolve({
        code: options.gitleaksCode ?? 0,
        stdout: options.gitleaksCode === 1 ? "Finding: AWS key in snippets/memo.md" : "",
        stderr: "",
      });
    }
    if (cmd === "gh" && args[1]?.startsWith("gists?")) {
      const page = args[1].includes("page=1") ? PAGE1 : "[]";
      return Promise.resolve({ code: 0, stdout: page, stderr: "" });
    }
    if (cmd === "gh" && args[1]?.startsWith("gists/")) {
      const id = args[1].slice("gists/".length);
      return Promise.resolve({ code: 0, stdout: JSON.stringify(DETAILS[id]), stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  return { runner, calls };
}

async function fixture() {
  const home = await Deno.makeTempDir();
  const repo = join(home, "repo");
  await Deno.mkdir(join(repo, "snippets"), { recursive: true });
  await Deno.mkdir(join(repo, ".gistan"), { recursive: true });
  await saveConfig(join(home, "config.toml"), { repo });
  return { home, repo };
}

Deno.test("import places single/multi/colliding gists and records the index", async () => {
  const { home, repo } = await fixture();
  const { runner } = importRunner();
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "import", args: [] }, io.context), 0);
  assertEquals(io.stdout.includes("3 imported, 0 skipped, 0 failed"), true);

  // g1 gets the plain filename; g3 collides and gets the id suffix.
  assertEquals(await Deno.readTextFile(join(repo, "snippets", "memo.md")), "g1 content");
  assertEquals(
    await Deno.readTextFile(join(repo, "snippets", "memo--g3cccccc.md")),
    "g3 content",
  );
  // multi-file gist becomes a self-identifying directory without index entries
  assertEquals(
    await Deno.readTextFile(join(repo, "snippets", "my-cool-notes--g2bbbbbb", "a.md")),
    "multi a",
  );

  const state = await loadState(repo);
  assertEquals(state.snippets["snippets/memo.md"].tags, ["react", "example"]);
  assertEquals(state.snippets["snippets/memo.md"].gist?.visibility, "public");
  assertEquals(state.snippets["snippets/memo--g3cccccc.md"].gist?.id, "g3cccccccc");
  assertEquals(Object.keys(state.snippets).length, 2);
});

Deno.test("import is idempotent: linked gists are skipped on rerun", async () => {
  const { home } = await fixture();
  const { runner } = importRunner();

  await run({ name: "import", args: [] }, memoryContext(runner, home).context);
  const second = memoryContext(runner, home);
  assertEquals(await run({ name: "import", args: [] }, second.context), 0);
  // g2 (multi-file, no index entry) is re-written deterministically; g1/g3 skip
  assertEquals(second.stdout.includes("1 imported, 2 skipped, 0 failed"), true);
});

Deno.test("import blocks on gitleaks findings", async () => {
  const { home } = await fixture();
  const { runner } = importRunner({ gitleaksCode: 1 });
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "import", args: [] }, io.context), 1);
  assertEquals(io.stderr.includes("do NOT commit"), true);
  assertEquals(io.stderr.includes("AWS key"), true);
});

Deno.test("import refuses to start without gitleaks", async () => {
  const { home } = await fixture();
  const calls: string[] = [];
  const runner: Runner = (cmd) => {
    calls.push(cmd);
    if (cmd === "gitleaks") {
      return Promise.resolve({ code: EXIT_COMMAND_NOT_FOUND, stdout: "", stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
  };
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "import", args: [] }, io.context), 1);
  assertEquals(io.stderr.includes("gitleaks is required"), true);
  assertEquals(calls.includes("gh"), false); // no wasted API work
});

Deno.test("import --limit restricts the batch", async () => {
  const { home, repo } = await fixture();
  const { runner } = importRunner();
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "import", args: ["--limit", "1"] }, io.context), 0);
  assertEquals(io.stdout.includes("importing 1 of 3 gists"), true);
  const state = await loadState(repo);
  assertEquals(Object.keys(state.snippets), ["snippets/memo.md"]);
});
