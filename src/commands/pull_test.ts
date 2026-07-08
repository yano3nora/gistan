import { assert, assertEquals } from "@std/assert";
import type { Runner } from "../core/proc.ts";
import { contentHash, textHash } from "../core/snippets.ts";
import { loadState, saveState } from "../core/state.ts";
import { AT, AT2, fixture, join, memoryContext } from "./test_helpers.ts";
import { run } from "./pull.ts";

async function published(local = "A", synced = "A") {
  const f = await fixture();
  await Deno.mkdir(join(f.repo, "gists", "one"), { recursive: true });
  await Deno.writeTextFile(join(f.repo, "gists", "one", "a.md"), local);
  await saveState(f.repo, {
    version: 2,
    gists: {
      one: {
        id: "gid",
        visibility: "public",
        remote_updated_at: AT,
        synced_description_hash: null,
        files: { "a.md": await contentHash(new TextEncoder().encode(synced)) },
      },
    },
  });
  return f;
}

function runner(remoteContent: string, description = "", fzf = "one\n"): Runner {
  return (cmd, args) => {
    if (cmd === "fzf") return Promise.resolve({ code: 0, stdout: fzf, stderr: "" });
    if (cmd === "gh" && args[1] === "gists?per_page=100") {
      return Promise.resolve({ code: 0, stdout: `gid\t${AT2}\ttrue\n`, stderr: "" });
    }
    if (cmd === "gh" && args[1] === "gists/gid") {
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          description,
          updated_at: AT2,
          files: { "a.md": { filename: "a.md", content: remoteContent } },
        }),
        stderr: "",
      });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
}

Deno.test("pull without arg fuzzy-picks one remote drift instead of bulk pulling", async () => {
  const { home, repo } = await published();
  await Deno.mkdir(join(repo, "gists", "two"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "two", "b.md"), "B");
  await saveState(repo, {
    version: 2,
    gists: {
      ...(await loadState(repo)).gists,
      two: {
        id: "g2",
        visibility: "public",
        remote_updated_at: AT,
        synced_description_hash: null,
        files: { "b.md": await contentHash(new TextEncoder().encode("B")) },
      },
    },
  });
  const calls: string[] = [];
  const r: Runner = (cmd, args, opt) => {
    calls.push(`${cmd} ${args.join(" ")} ${opt?.stdin ?? ""}`);
    if (cmd === "fzf") return Promise.resolve({ code: 0, stdout: "one\n", stderr: "" });
    if (cmd === "gh" && args[1] === "gists?per_page=100") {
      return Promise.resolve({
        code: 0,
        stdout: `gid\t${AT2}\ttrue\ng2\t${AT2}\ttrue\n`,
        stderr: "",
      });
    }
    if (cmd === "gh" && args[1] === "gists/gid") {
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          description: "",
          updated_at: AT2,
          files: { "a.md": { filename: "a.md", content: "R" } },
        }),
        stderr: "",
      });
    }
    if (cmd === "gh" && args[1] === "gists/g2") throw new Error("bulk pull happened");
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(r, home);
  assertEquals(await run({ name: "pull", args: [] }, io.context), 0);
  assert(calls.some((c) => c.startsWith("fzf") && c.includes("one") && c.includes("two")));
  assertEquals(await Deno.readTextFile(join(repo, "gists", "one", "a.md")), "R");
  assertEquals(await Deno.readTextFile(join(repo, "gists", "two", "b.md")), "B");
});

Deno.test("pull without candidates prints no remote drift", async () => {
  const { home } = await published();
  const r: Runner = (cmd, args) => {
    if (cmd === "gh" && args[1] === "gists?per_page=100") {
      return Promise.resolve({ code: 0, stdout: `gid\t${AT}\ttrue\n`, stderr: "" });
    }
    throw new Error("fzf should not run");
  };
  const io = memoryContext(r, home);
  assertEquals(await run({ name: "pull", args: [] }, io.context), 0);
  assert(io.stdout.includes("no remote drift"));
});

Deno.test("pull removes local files missing from remote", async () => {
  const { home, repo } = await published();
  await Deno.writeTextFile(join(repo, "gists", "one", "stale.md"), "stale");
  const io = memoryContext(runner("R"), home);
  assertEquals(await run({ name: "pull", args: ["one"] }, io.context), 0);
  await assertRejectsNotFound(join(repo, "gists", "one", "stale.md"));
  assertEquals((await loadState(repo)).gists.one.files, {
    "a.md": await contentHash(new TextEncoder().encode("R")),
  });
});

Deno.test("pull writes remote description and synced description hash", async () => {
  const { home, repo } = await published();
  const io = memoryContext(runner("R", "Remote desc"), home);
  assertEquals(await run({ name: "pull", args: ["one"] }, io.context), 0);
  assertEquals(
    await Deno.readTextFile(join(repo, "gists", "one", ".description.txt")),
    "Remote desc",
  );
  assertEquals(
    (await loadState(repo)).gists.one.synced_description_hash,
    await textHash("Remote desc"),
  );
});

Deno.test("pull deletes local description when remote description is empty", async () => {
  const { home, repo } = await published();
  await Deno.writeTextFile(join(repo, "gists", "one", ".description.txt"), "Local");
  const io = memoryContext(runner("R", ""), home);
  assertEquals(await run({ name: "pull", args: ["one"] }, io.context), 0);
  await assertRejectsNotFound(join(repo, "gists", "one", ".description.txt"));
  assertEquals((await loadState(repo)).gists.one.synced_description_hash, null);
});

Deno.test("pull conflict decline keeps local files", async () => {
  const { home, repo } = await published("local", "synced");
  const io = memoryContext(runner("remote"), home, { confirmAnswer: false });
  assertEquals(await run({ name: "pull", args: ["one"] }, io.context), 0);
  assertEquals(await Deno.readTextFile(join(repo, "gists", "one", "a.md")), "local");
});

Deno.test("pull returns gh list failure", async () => {
  const { home } = await published();
  const io = memoryContext(() => Promise.resolve({ code: 1, stdout: "", stderr: "bad" }), home);
  assertEquals(await run({ name: "pull", args: [] }, io.context), 1);
  assert(io.stderr.includes("gh api gists failed"));
});

async function assertRejectsNotFound(path: string) {
  try {
    await Deno.stat(path);
    throw new Error("expected missing file");
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}
