import { assert, assertEquals } from "@std/assert";
import type { Runner } from "../core/proc.ts";
import { contentHash } from "../core/snippets.ts";
import { loadState, saveState } from "../core/state.ts";
import { AT, AT2, fixture, join, memoryContext } from "./test_helpers.ts";
import { changeSummary, run } from "./push.ts";

async function published(local = "A", synced = "A") {
  const f = await fixture();
  await Deno.mkdir(join(f.repo, "gists", "one"), { recursive: true });
  await Deno.writeTextFile(join(f.repo, "gists", "one", "a.md"), local);
  await saveState(f.repo, {
    version: 3,
    gists: {
      one: {
        visibility: "public",
        description: "",
        remote_updated_at: AT,
        files: { "a.md": await contentHash(new TextEncoder().encode(synced)) },
      },
    },
    locals: {},
  });
  return f;
}

function listRunner(entries: Record<string, string>): Runner {
  return (cmd, args) => {
    if (cmd === "gh" && args[1] === "gists?per_page=100") {
      const lines = Object.entries(entries).map(([id, at]) => `${id}\t${at}\ttrue`);
      return Promise.resolve({ code: 0, stdout: lines.join("\n") + "\n", stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
}

Deno.test("changeSummary formats added/changed/removed counts", () => {
  assertEquals(changeSummary({ "a.md": "h1" }, { "a.md": "h1", "b.md": "h2" }), "+1");
  assertEquals(changeSummary({ "a.md": "h1" }, { "a.md": "h2" }), "~1");
  assertEquals(changeSummary({ "a.md": "h1", "b.md": "h2" }, { "a.md": "h1" }), "-1");
  assertEquals(
    changeSummary(
      { "a.md": "h1", "b.md": "h2", "c.md": "h3" },
      { "a.md": "h1", "b.md": "changed", "d.md": "h4" },
    ),
    "+1 ~1 -1",
  );
});

Deno.test("push with no local drift prints no local drift", async () => {
  const { home } = await published();
  const io = memoryContext(listRunner({ one: AT }), home);
  assertEquals(await run({ name: "push", args: [] }, io.context), 0);
  assert(io.stdout.includes("no local drift"));
});

Deno.test("push lists local drift with a change summary and description, then updates on confirm", async () => {
  const { home, repo } = await published("A2");
  const state = await loadState(repo);
  await saveState(repo, {
    version: 3,
    gists: { one: { ...state.gists.one, description: "Notes" } },
    locals: {},
  });
  let body = "";
  const r: Runner = (cmd, args, opt) => {
    if (cmd === "gh" && args[1] === "gists?per_page=100") {
      return Promise.resolve({ code: 0, stdout: `one\t${AT}\ttrue\n`, stderr: "" });
    }
    if (cmd === "gh" && args[1] === "gists/one" && args.includes("PATCH")) {
      body = String(opt?.stdin);
      return Promise.resolve({ code: 0, stdout: AT2, stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(r, home, { confirmAnswer: true });
  assertEquals(await run({ name: "push", args: [] }, io.context), 0);
  assert(io.stdout.includes("local drift:"));
  assert(io.stdout.includes("one  ~1  — Notes"));
  assert("a.md" in JSON.parse(body).files);
  assertEquals((await loadState(repo)).gists.one.remote_updated_at, AT2);
});

Deno.test("push decline aborts without calling PATCH", async () => {
  const { home, repo } = await published("A2");
  const calls: string[] = [];
  const r: Runner = (cmd, args) => {
    calls.push(args.join(" "));
    if (cmd === "gh" && args[1] === "gists?per_page=100") {
      return Promise.resolve({ code: 0, stdout: `one\t${AT}\ttrue\n`, stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(r, home, { confirmAnswer: false });
  assertEquals(await run({ name: "push", args: [] }, io.context), 1);
  assert(io.stderr.includes("aborted"));
  assertEquals(calls.some((c) => c.includes("PATCH")), false);
  assertEquals((await loadState(repo)).gists.one.remote_updated_at, AT);
});

Deno.test("push skips a conflict item and points to status --fix", async () => {
  const { home } = await published("A2", "A"); // local changed since sync
  const io = memoryContext(listRunner({ one: AT2 }), home, { confirmAnswer: true }); // remote also changed
  assertEquals(await run({ name: "push", args: [] }, io.context), 0);
  assert(io.stderr.includes("status --fix"));
  assert(io.stdout.includes("no local drift"));
});

Deno.test("push reports a per-item failure and exits 1 while continuing other gists", async () => {
  const { home, repo } = await published("A2");
  await Deno.mkdir(join(repo, "gists", "two"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "two", "b.md"), "B2");
  const state = await loadState(repo);
  await saveState(repo, {
    version: 3,
    gists: {
      ...state.gists,
      two: {
        visibility: "public",
        description: "",
        remote_updated_at: AT,
        files: { "b.md": await contentHash(new TextEncoder().encode("B")) },
      },
    },
    locals: {},
  });
  const r: Runner = (cmd, args) => {
    if (cmd === "gh" && args[1] === "gists?per_page=100") {
      return Promise.resolve({
        code: 0,
        stdout: `one\t${AT}\ttrue\ntwo\t${AT}\ttrue\n`,
        stderr: "",
      });
    }
    if (cmd === "gh" && args[1] === "gists/one" && args.includes("PATCH")) {
      return Promise.resolve({ code: 0, stdout: AT2, stderr: "" });
    }
    if (cmd === "gh" && args[1] === "gists/two" && args.includes("PATCH")) {
      return Promise.resolve({ code: 1, stdout: "", stderr: "boom" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(r, home, { confirmAnswer: true });
  assertEquals(await run({ name: "push", args: [] }, io.context), 1);
  assertEquals((await loadState(repo)).gists.one.remote_updated_at, AT2);
  assert(io.stderr.includes("failed to push two"));
});

Deno.test("push returns the gh list failure", async () => {
  const { home } = await published();
  const io = memoryContext(() => Promise.resolve({ code: 1, stdout: "", stderr: "bad" }), home);
  assertEquals(await run({ name: "push", args: [] }, io.context), 1);
  assert(io.stderr.includes("gh api gists failed"));
});
