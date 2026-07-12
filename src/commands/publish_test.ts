import { assert, assertEquals } from "@std/assert";
import type { Runner } from "../core/proc.ts";
import { contentHash } from "../core/snippets.ts";
import { loadState, saveState } from "../core/state.ts";
import { AT, AT2, fixture, join, memoryContext } from "./test_helpers.ts";
import { run } from "./publish.ts";

async function oneFile(content = "A") {
  const f = await fixture();
  await Deno.mkdir(join(f.repo, "gists", "one"), { recursive: true });
  await Deno.writeTextFile(join(f.repo, "gists", "one", "a.md"), content);
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

Deno.test("publish without a target returns usage", async () => {
  const { home } = await fixture();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "publish", args: [] }, io.context), 2);
  assert(io.stderr.includes("usage: gistan publish"));
});

Deno.test("publish create previews filenames, an excerpt, description and visibility before confirming", async () => {
  const { home, repo } = await oneFile("Hello world");
  await saveState(repo, { version: 3, gists: {}, locals: { one: { description: "My gist" } } });
  const runner: Runner = (cmd, args) => {
    if (cmd === "gh" && args.includes("POST")) {
      return Promise.resolve({ code: 0, stdout: `newid\t${AT}`, stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: true });
  assertEquals(await run({ name: "publish", args: ["one"] }, io.context), 0);
  assert(io.stdout.includes("gists/one (1 file(s), secret):"));
  assert(io.stdout.includes("a.md"));
  assert(io.stdout.includes("Hello world"));
  assert(io.stdout.includes("description: My gist"));
});

Deno.test("publish create renames the dir to the gist id and moves the locals entry into gists", async () => {
  const { home, repo } = await oneFile();
  await saveState(repo, { version: 3, gists: {}, locals: { one: { description: "Desc" } } });
  let body = "";
  const runner: Runner = (cmd, args, opt) => {
    if (cmd === "gh" && args.includes("POST")) {
      body = String(opt?.stdin);
      return Promise.resolve({ code: 0, stdout: `newid\t${AT}`, stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: true });
  assertEquals(await run({ name: "publish", args: ["one"] }, io.context), 0);
  assert(io.stdout.includes("moved: gists/one -> gists/newid"));
  await assertMissing(join(repo, "gists", "one"));
  assertEquals(await Deno.readTextFile(join(repo, "gists", "newid", "a.md")), "A");
  const state = await loadState(repo);
  assertEquals(Object.keys(state.gists), ["newid"]);
  assertEquals(state.locals.one, undefined);
  assertEquals(JSON.parse(body).description, "Desc");
  // Creating public must be an explicit opt-in (--public); default is secret.
  assertEquals(JSON.parse(body).public, false);
});

Deno.test("publish create --public creates a public gist", async () => {
  const { home } = await oneFile();
  let body = "";
  const runner: Runner = (cmd, args, opt) => {
    if (cmd === "gh" && args.includes("POST")) {
      body = String(opt?.stdin);
      return Promise.resolve({ code: 0, stdout: `newid\t${AT}`, stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: true });
  assertEquals(await run({ name: "publish", args: ["one", "--public"] }, io.context), 0);
  assertEquals(JSON.parse(body).public, true);
});

Deno.test("publish create decline aborts without creating a gist", async () => {
  const { home, repo } = await oneFile();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home, {
    confirmAnswer: false,
  });
  assertEquals(await run({ name: "publish", args: ["one"] }, io.context), 1);
  assert(io.stderr.includes("aborted"));
  assertEquals((await loadState(repo)).gists.one, undefined);
});

Deno.test("publish update sends only changed files and deleted files as null", async () => {
  const { home, repo } = await oneFile("A2");
  await Deno.writeTextFile(join(repo, "gists", "one", "c.md"), "C");
  await saveState(repo, {
    version: 3,
    gists: {
      one: {
        visibility: "public",
        description: "",
        remote_updated_at: AT,
        files: { "a.md": "old-hash", "b.md": "old-hash-b" },
      },
    },
    locals: {},
  });
  let body = "";
  const runner: Runner = (cmd, args, opt) => {
    if (cmd === "gh" && args.includes("PATCH")) {
      body = String(opt?.stdin);
      return Promise.resolve({ code: 0, stdout: AT2, stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: true });
  assertEquals(await run({ name: "publish", args: ["one"] }, io.context), 0);
  const payload = JSON.parse(body).files;
  assert("a.md" in payload); // content changed
  assert("c.md" in payload); // newly added
  assertEquals(payload["b.md"], null); // removed locally
  assertEquals((await loadState(repo)).gists.one.remote_updated_at, AT2);
});

Deno.test("publish update omits description from the payload when -d matches the indexed value", async () => {
  const { home, repo } = await oneFile();
  await saveState(repo, {
    version: 3,
    gists: {
      one: {
        visibility: "public",
        description: "Same",
        remote_updated_at: AT,
        files: { "a.md": await contentHash(new TextEncoder().encode("A")) },
      },
    },
    locals: {},
  });
  let patched = false;
  const runner: Runner = (cmd, args) => {
    if (cmd === "gh" && args.includes("PATCH")) patched = true;
    return Promise.resolve({ code: 0, stdout: AT2, stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: true });
  assertEquals(await run({ name: "publish", args: ["one", "-d", "Same"] }, io.context), 0);
  // File content unchanged and -d matches the index: no reason to PATCH at all.
  assertEquals(patched, false);
  assert(io.stdout.includes("already up to date"));
});

Deno.test("publish update sends description when -d differs from the indexed value", async () => {
  const { home, repo } = await oneFile();
  await saveState(repo, {
    version: 3,
    gists: {
      one: {
        visibility: "public",
        description: "Old",
        remote_updated_at: AT,
        files: { "a.md": await contentHash(new TextEncoder().encode("A")) },
      },
    },
    locals: {},
  });
  let body = "";
  const runner: Runner = (cmd, args, opt) => {
    if (cmd === "gh" && args.includes("PATCH")) {
      body = String(opt?.stdin);
      return Promise.resolve({ code: 0, stdout: AT2, stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: true });
  assertEquals(await run({ name: "publish", args: ["one", "-d", "New"] }, io.context), 0);
  assertEquals(JSON.parse(body).description, "New");
  assertEquals(JSON.parse(body).files, {});
  assertEquals((await loadState(repo)).gists.one.description, "New");
});

Deno.test("publish visibility change deletes, recreates, and renames the dir to the new id", async () => {
  const { home, repo } = await oneFile();
  await saveState(repo, {
    version: 3,
    gists: {
      one: {
        visibility: "public",
        description: "",
        remote_updated_at: AT,
        files: { "a.md": await contentHash(new TextEncoder().encode("A")) },
      },
    },
    locals: {},
  });
  const calls: string[] = [];
  const runner: Runner = (cmd, args) => {
    calls.push(args.join(" "));
    if (cmd === "gh" && args.includes("POST")) {
      return Promise.resolve({ code: 0, stdout: `newid\t${AT2}`, stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: true });
  assertEquals(await run({ name: "publish", args: ["one", "--secret"] }, io.context), 0);
  assert(calls.some((c) => c.includes("DELETE")));
  await assertMissing(join(repo, "gists", "one"));
  assertEquals(await Deno.readTextFile(join(repo, "gists", "newid", "a.md")), "A");
  const state = await loadState(repo);
  assertEquals(Object.keys(state.gists), ["newid"]);
  assertEquals(state.gists.newid.visibility, "secret");
});

Deno.test("publish refuses nested files", async () => {
  const { home, repo } = await oneFile();
  await Deno.mkdir(join(repo, "gists", "one", "nested"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "one", "nested", "b.md"), "B");
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "publish", args: ["one"] }, io.context), 1);
  assert(io.stderr.includes("nested files"));
});

Deno.test("publish refuses a directory with no files", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, "gists", "empty"), { recursive: true });
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "publish", args: ["empty"] }, io.context), 1);
  assert(io.stderr.includes("has no files"));
});

Deno.test("publish reports dir-missing despite an index entry", async () => {
  const { home, repo } = await fixture();
  await saveState(repo, {
    version: 3,
    gists: {
      one: {
        visibility: "public",
        description: "",
        remote_updated_at: AT,
        files: { "a.md": "h" },
      },
    },
    locals: {},
  });
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "publish", args: ["one"] }, io.context), 1);
  assert(io.stderr.includes("status --fix"));
});

Deno.test("publish errors when neither a gist nor a dir exists for the id", async () => {
  const { home } = await fixture();
  const io = memoryContext(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }), home);
  assertEquals(await run({ name: "publish", args: ["nope"] }, io.context), 1);
  assert(io.stderr.includes("no gist nope and no dir gists/nope"));
});

Deno.test("publish accepts a gist URL target", async () => {
  const { home, repo } = await fixture();
  await Deno.mkdir(join(repo, "gists", "abc123"), { recursive: true });
  await Deno.writeTextFile(join(repo, "gists", "abc123", "a.md"), "A");
  const runner: Runner = (cmd, args) => {
    if (cmd === "gh" && args.includes("POST")) {
      return Promise.resolve({ code: 0, stdout: `abc123\t${AT}`, stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: true });
  assertEquals(
    await run({ name: "publish", args: ["https://gist.github.com/owner/abc123"] }, io.context),
    0,
  );
});

Deno.test("publish warns when a clipboard tool exists but fails", async () => {
  const { home } = await oneFile();
  // Exit 1 (not 127) for every non-gh call: whatever clipboard candidates the
  // host OS tries, all are "present but failing", so the test is OS-independent.
  const runner: Runner = (_c, args) => {
    if (args.includes("POST")) {
      return Promise.resolve({ code: 0, stdout: `gid\t${AT}`, stderr: "" });
    }
    return Promise.resolve({ code: 1, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: true });
  assertEquals(await run({ name: "publish", args: ["one"] }, io.context), 0);
  assert(io.stderr.includes("warn: clipboard copy failed"));
});

Deno.test("publish stays silent when no clipboard tool is installed", async () => {
  const { home } = await oneFile();
  const runner: Runner = (_c, args) => {
    if (args.includes("POST")) {
      return Promise.resolve({ code: 0, stdout: `gid\t${AT}`, stderr: "" });
    }
    return Promise.resolve({ code: 127, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: true });
  assertEquals(await run({ name: "publish", args: ["one"] }, io.context), 0);
  assertEquals(io.stderr, "");
});

async function publishedSecret(repo: string) {
  await saveState(repo, {
    version: 3,
    gists: {
      one: {
        visibility: "secret",
        description: "",
        remote_updated_at: AT,
        files: { "a.md": await contentHash(new TextEncoder().encode("A")) },
      },
    },
    locals: {},
  });
}

Deno.test("publish visibility change creates the new gist before deleting the old one", async () => {
  const { home, repo } = await oneFile();
  await publishedSecret(repo);
  const calls: string[] = [];
  const runner: Runner = (cmd, args) => {
    if (cmd === "gh" && args.includes("POST")) {
      calls.push("create");
      return Promise.resolve({ code: 0, stdout: `newid\t${AT2}`, stderr: "" });
    }
    if (cmd === "gh" && args.includes("DELETE")) {
      calls.push("delete");
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: true });
  assertEquals(await run({ name: "publish", args: ["one", "--public"] }, io.context), 0);
  // Create-first, delete-last: a mid-flight failure must leave a recoverable
  // duplicate, never a deleted-only state.
  assertEquals(calls, ["create", "delete"]);
  assert(io.stdout.includes("(dead)"));
});

Deno.test("publish visibility change survives a failed old-gist delete, warning about the leftover", async () => {
  const { home, repo } = await oneFile();
  await publishedSecret(repo);
  const runner: Runner = (cmd, args) => {
    if (cmd === "gh" && args.includes("POST")) {
      return Promise.resolve({ code: 0, stdout: `newid\t${AT2}`, stderr: "" });
    }
    if (cmd === "gh" && args.includes("DELETE")) {
      return Promise.resolve({ code: 1, stdout: "", stderr: "boom" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: true });
  assertEquals(await run({ name: "publish", args: ["one", "--public"] }, io.context), 0);
  // The new gist is live and local state already switched over — the stale
  // remote is a visible duplicate to clean up manually, not a failure.
  assert(io.stderr.includes("delete it manually"));
  assert(io.stdout.includes("(still exists)"));
  const state = await loadState(repo);
  assertEquals(Object.keys(state.gists), ["newid"]);
  assertEquals(await Deno.readTextFile(join(repo, "gists", "newid", "a.md")), "A");
});
