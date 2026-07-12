import { assert, assertEquals } from "@std/assert";
import type { Runner } from "../core/proc.ts";
import { contentHash } from "../core/snippets.ts";
import { loadState, saveState } from "../core/state.ts";
import { AT, AT2, fixture, join, memoryContext } from "./test_helpers.ts";
import { run } from "./status.ts";

async function published(description = "") {
  const f = await fixture();
  await Deno.mkdir(join(f.repo, "gists", "one"), { recursive: true });
  await Deno.writeTextFile(join(f.repo, "gists", "one", "a.md"), "A");
  await saveState(f.repo, {
    version: 3,
    gists: {
      one: {
        visibility: "public",
        description,
        remote_updated_at: AT,
        files: { "a.md": await contentHash(new TextEncoder().encode("A")) },
      },
    },
    locals: {},
  });
  return f;
}

async function assertMissing(path: string) {
  try {
    await Deno.stat(path);
    throw new Error(`expected missing: ${path}`);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

Deno.test("status default does not call gh", async () => {
  const { home } = await published();
  const calls: string[] = [];
  const io = memoryContext((cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  }, home);
  assertEquals(await run({ name: "status", args: [] }, io.context), 0);
  assertEquals(calls.filter((c) => c.startsWith("gh ")), []);
});

Deno.test("status warns for bare and nested files", async () => {
  const { home, repo } = await fixture();
  await Deno.writeTextFile(join(repo, "gists", "bare.md"), "B");
  await Deno.mkdir(join(repo, "gists", "one", "nested"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "one", "nested", "x.md"), "X");
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "status", args: [] }, io.context), 0);
  assert(io.stderr.includes("not managed"));
  assert(io.stderr.includes("nested too deeply"));
});

Deno.test("status --remote reports remote drift", async () => {
  const { home } = await published();
  const io = memoryContext((cmd, args) => {
    if (cmd === "gh" && args[1] === "gists?per_page=100") {
      return Promise.resolve({ code: 0, stdout: `one\t${AT2}\ttrue\n`, stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  }, home);
  assertEquals(await run({ name: "status", args: ["--remote"] }, io.context), 0);
  assert(io.stdout.includes("remote-drift"));
});

Deno.test("status appends the description and gist url on formatted lines", async () => {
  const { home } = await published("My notes");
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "status", args: ["--all"] }, io.context), 0);
  assert(io.stdout.includes("— My notes"));
  assert(io.stdout.includes("https://gist.github.com/one"));
});

Deno.test("status --fix unlinks a remote-deleted gist, renaming the dir to a fresh local id and keeping its description", async () => {
  const { home, repo } = await published("Keep me");
  const io = memoryContext(
    (cmd, args) => {
      if (cmd === "gh" && args[1] === "gists?per_page=100") {
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    home,
    { confirmAnswer: true },
  );
  assertEquals(await run({ name: "status", args: ["--fix"] }, io.context), 0);
  const state = await loadState(repo);
  assertEquals(state.gists.one, undefined);
  await assertMissing(join(repo, "gists", "one"));
  const newIds = Object.keys(state.locals);
  assertEquals(newIds.length, 1);
  assert(newIds[0].startsWith("_"));
  assertEquals(state.locals[newIds[0]].description, "Keep me");
  assert(io.stdout.includes(`moved: gists/one -> gists/${newIds[0]}`));
});

Deno.test("status --fix restores a missing local dir from remote", async () => {
  const { home, repo } = await published();
  await Deno.remove(join(repo, "gists", "one"), { recursive: true });
  const io = memoryContext(
    (cmd, args) => {
      if (cmd === "gh" && args[1] === "gists?per_page=100") {
        return Promise.resolve({ code: 0, stdout: `one\t${AT}\ttrue\n`, stderr: "" });
      }
      if (cmd === "gh" && args[1] === "gists/one") {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            description: "",
            updated_at: AT,
            files: { "a.md": { filename: "a.md", content: "A" } },
          }),
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    home,
    { confirmAnswer: true },
  );
  assertEquals(await run({ name: "status", args: ["--fix"] }, io.context), 0);
  assertEquals(await Deno.readTextFile(join(repo, "gists", "one", "a.md")), "A");
});

Deno.test("status --fix can delete an orphan gist when restore is declined", async () => {
  const { home, repo } = await published();
  await Deno.remove(join(repo, "gists", "one"), { recursive: true });
  const calls: string[] = [];
  const io = memoryContext(
    (cmd, args) => {
      calls.push(args.join(" "));
      if (cmd === "gh" && args[1] === "gists?per_page=100") {
        return Promise.resolve({ code: 0, stdout: `one\t${AT}\ttrue\n`, stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    home,
    { confirmAnswer: [false, true] },
  );
  assertEquals(await run({ name: "status", args: ["--fix"] }, io.context), 0);
  assert(calls.some((c) => c.includes("DELETE")));
  assertEquals((await loadState(repo)).gists.one, undefined);
});

Deno.test("status --fix resolves a conflict by showing per-file sides, then pulling on the first confirm", async () => {
  const { home, repo } = await published();
  await Deno.writeTextFile(join(repo, "gists", "one", "a.md"), "local-changed");
  const io = memoryContext(
    (cmd, args) => {
      if (cmd === "gh" && args[1] === "gists?per_page=100") {
        return Promise.resolve({ code: 0, stdout: `one\t${AT2}\ttrue\n`, stderr: "" });
      }
      if (cmd === "gh" && args[1] === "gists/one") {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            description: "",
            updated_at: AT2,
            files: { "a.md": { filename: "a.md", content: "remote-changed" } },
          }),
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    home,
    { confirmAnswer: true },
  );
  assertEquals(await run({ name: "status", args: ["--fix"] }, io.context), 0);
  assert(io.stdout.includes("both   a.md"));
  assertEquals(await Deno.readTextFile(join(repo, "gists", "one", "a.md")), "remote-changed");
});

Deno.test("status --fix conflict declines pull and pushes local on the second confirm", async () => {
  const { home, repo } = await published();
  await Deno.writeTextFile(join(repo, "gists", "one", "a.md"), "local-changed");
  let body = "";
  const io = memoryContext(
    (cmd, args, opt) => {
      if (cmd === "gh" && args[1] === "gists?per_page=100") {
        return Promise.resolve({ code: 0, stdout: `one\t${AT2}\ttrue\n`, stderr: "" });
      }
      if (cmd === "gh" && args[1] === "gists/one" && args.includes("PATCH")) {
        body = String(opt?.stdin);
        return Promise.resolve({ code: 0, stdout: AT2, stderr: "" });
      }
      if (cmd === "gh" && args[1] === "gists/one") {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            description: "",
            updated_at: AT2,
            files: { "a.md": { filename: "a.md", content: "remote-changed" } },
          }),
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    home,
    { confirmAnswer: [false, true] },
  );
  assertEquals(await run({ name: "status", args: ["--fix"] }, io.context), 0);
  assertEquals(await Deno.readTextFile(join(repo, "gists", "one", "a.md")), "local-changed");
  assert("a.md" in JSON.parse(body).files);
});

Deno.test("status --fix conflict declining both sides leaves the gist as-is", async () => {
  const { home, repo } = await published();
  await Deno.writeTextFile(join(repo, "gists", "one", "a.md"), "local-changed");
  const io = memoryContext(
    (cmd, args) => {
      if (cmd === "gh" && args[1] === "gists?per_page=100") {
        return Promise.resolve({ code: 0, stdout: `one\t${AT2}\ttrue\n`, stderr: "" });
      }
      if (cmd === "gh" && args[1] === "gists/one") {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            description: "",
            updated_at: AT2,
            files: { "a.md": { filename: "a.md", content: "remote-changed" } },
          }),
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    home,
    { confirmAnswer: [false, false] },
  );
  assertEquals(await run({ name: "status", args: ["--fix"] }, io.context), 0);
  assertEquals(await Deno.readTextFile(join(repo, "gists", "one", "a.md")), "local-changed");
  assertEquals((await loadState(repo)).gists.one.remote_updated_at, AT);
  assert(io.stdout.includes("1 left as-is"));
});

Deno.test("status --fix hints local-drift toward gistan push", async () => {
  const { home, repo } = await published();
  await Deno.writeTextFile(join(repo, "gists", "one", "a.md"), "changed");
  const io = memoryContext((cmd, args) => {
    if (cmd === "gh" && args[1] === "gists?per_page=100") {
      return Promise.resolve({ code: 0, stdout: `one\t${AT}\ttrue\n`, stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  }, home);
  assertEquals(await run({ name: "status", args: ["--fix"] }, io.context), 0);
  assert(io.stderr.includes("gistan push"));
});

Deno.test("status --fix hints remote-drift toward gistan pull", async () => {
  const { home } = await published();
  const io = memoryContext((cmd, args) => {
    if (cmd === "gh" && args[1] === "gists?per_page=100") {
      return Promise.resolve({ code: 0, stdout: `one\t${AT2}\ttrue\n`, stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  }, home);
  assertEquals(await run({ name: "status", args: ["--fix"] }, io.context), 0);
  assert(io.stderr.includes("gistan pull"));
});

Deno.test("status --fix returns an error when the remote listing fails", async () => {
  const { home } = await published();
  const io = memoryContext(() => Promise.resolve({ code: 1, stdout: "", stderr: "bad" }), home);
  assertEquals(await run({ name: "status", args: ["--fix"] }, io.context), 1);
});

Deno.test("status filter limits output to one dir", async () => {
  const { home, repo } = await published();
  await Deno.mkdir(join(repo, "gists", "two"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "two", "b.md"), "B");
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "status", args: ["one"] }, io.context), 0);
  assert(io.stdout.includes("one"));
  assertEquals(io.stdout.includes("two"), false);
});

// -- default hidden conditions / --all / dirname filter (TASK-260708) -------

Deno.test("status default hides a published gist (offline: remote-unknown), but the summary still prints", async () => {
  // published() has no --remote, so "one" reconciles to remote-unknown
  // (displayed as "published") rather than in-sync — still in the hidden set.
  const { home } = await published();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "status", args: [] }, io.context), 0);
  assertEquals(io.stdout.includes("one"), false);
  assert(io.stdout.includes("1 gist(s): 1 published"));
});

Deno.test("status default shows drift conditions alongside a hidden published majority", async () => {
  const { home, repo } = await published(); // "one" reconciles to remote-unknown/published
  await Deno.mkdir(join(repo, "gists", "two"), { recursive: true }); // unpublished: not hidden
  await Deno.writeTextFile(join(repo, "gists", "two", "b.md"), "B");
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "status", args: [] }, io.context), 0);
  assertEquals(io.stdout.includes("one"), false);
  assert(io.stdout.includes("two"));
  assert(io.stdout.includes("2 gist(s): 1 published, 1 unpublished"));
});

Deno.test("status --remote also hides a genuinely in-sync gist by default, --all shows it", async () => {
  const { home } = await published();
  const inSyncRunner = (cmd: string, args: readonly string[]) => {
    if (cmd === "gh" && args[1] === "gists?per_page=100") {
      return Promise.resolve({ code: 0, stdout: `one\t${AT}\ttrue\n`, stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const hidden = memoryContext(inSyncRunner, home);
  assertEquals(await run({ name: "status", args: ["--remote"] }, hidden.context), 0);
  assertEquals(hidden.stdout.includes("one"), false);
  assert(hidden.stdout.includes("1 gist(s): 1 in-sync"));

  const shown = memoryContext(inSyncRunner, home);
  assertEquals(await run({ name: "status", args: ["--remote", "--all"] }, shown.context), 0);
  assert(shown.stdout.includes("one"));
});

Deno.test("status --all restores the full listing, including a hidden published gist", async () => {
  const { home } = await published();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "status", args: ["--all"] }, io.context), 0);
  assert(io.stdout.includes("one"));
});

Deno.test("a dirname filter always shows its item even when in-sync", async () => {
  const { home } = await published();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "status", args: ["one"] }, io.context), 0);
  assert(io.stdout.includes("one"));
});

Deno.test("a dirname filter that matches nothing is a lookup error, not an empty repo", async () => {
  const { home } = await published();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "status", args: ["nope"] }, io.context), 1);
  assert(io.stderr.includes("nope not found"));
  assert(!io.stdout.includes("no gists yet"));
});

Deno.test("status --fix forgets a dir-missing entry when the gist is gone upstream, without a delete call", async () => {
  const { home, repo } = await fixture();
  await saveState(repo, {
    version: 3,
    gists: {
      gone: { visibility: "secret", description: "", remote_updated_at: AT, files: {} },
    },
    locals: {},
  });
  const deletes: string[] = [];
  const r: Runner = (cmd, args) => {
    if (cmd === "gh" && args.includes("DELETE")) deletes.push(String(args[1]));
    // Empty gh list: the gist no longer exists upstream.
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(r, home, { confirmAnswer: true });
  assertEquals(await run({ name: "status", args: ["--fix"] }, io.context), 0);
  assert(io.confirms.some((m) => m.includes("Forget index entry?")));
  assertEquals(deletes, []);
  assertEquals((await loadState(repo)).gists.gone, undefined);
  assert(io.stdout.includes("1 fixed"));
});
