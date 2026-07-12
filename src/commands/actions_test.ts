import { assert, assertEquals } from "@std/assert";
import type { Runner, RunOptions } from "../core/proc.ts";
import { saveState } from "../core/state.ts";
import { saveStarCache } from "../core/stars.ts";
import { runCopyAction, runListRender, runOpenAction } from "./actions.ts";
import { AT, fixture, join, memoryContext } from "./test_helpers.ts";

// All three hidden actions resolve state via loadState(".") — cwd = the gist
// repo, matching how fzf spawns its execute()/reload binds — so every test
// here chdirs into a fixture repo and restores cwd in `finally` (deno test
// runs every file in one process).

interface Call {
  cmd: string;
  args: readonly string[];
  options?: RunOptions;
}

function capturingRunner(): { runner: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: Runner = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  return { runner, calls };
}

async function withRepoCwd<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const cwd = Deno.cwd();
  Deno.chdir(repo);
  try {
    return await fn();
  } finally {
    Deno.chdir(cwd);
  }
}

/** Published gist g1, unpublished-with-description _loc1, and a star s1. */
async function seedRepo(repo: string): Promise<void> {
  await saveState(repo, {
    version: 3,
    gists: {
      g1: {
        visibility: "public",
        description: "a published gist",
        remote_updated_at: AT,
        files: { "a.md": "sha256:x" },
      },
    },
    locals: {
      _loc1: { description: "an unpublished draft" },
    },
  });
  await saveStarCache(repo, {
    version: 1,
    stars: {
      s1: { owner: "octo", description: "a starred gist", updated_at: AT, fetched_at: AT },
    },
  });
}

const OPENER = Deno.build.os === "darwin" ? "open" : "xdg-open";

// -- runCopyAction (__copy {1}) ----------------------------------------------

Deno.test("__copy on a published gist path copies the gist URL", async () => {
  const { repo } = await fixture();
  await seedRepo(repo);
  await withRepoCwd(repo, async () => {
    const { runner, calls } = capturingRunner();
    const io = memoryContext(runner, "/nonexistent");
    assertEquals(await runCopyAction(["gists/g1/a.md"], io.context), 0);
    const clip = calls.at(-1);
    assert(clip !== undefined);
    assertEquals(clip.options?.stdin, "https://gist.github.com/g1");
  });
});

Deno.test("__copy on an unpublished local dir copies the bare local id", async () => {
  const { repo } = await fixture();
  await seedRepo(repo);
  await withRepoCwd(repo, async () => {
    const { runner, calls } = capturingRunner();
    const io = memoryContext(runner, "/nonexistent");
    assertEquals(await runCopyAction(["gists/_loc1/x.md"], io.context), 0);
    const clip = calls.at(-1);
    assert(clip !== undefined);
    assertEquals(clip.options?.stdin, "_loc1");
  });
});

Deno.test("__copy on a stars/ path copies the gist URL even though it is never in state.gists", async () => {
  const { repo } = await fixture();
  await seedRepo(repo);
  await withRepoCwd(repo, async () => {
    const { runner, calls } = capturingRunner();
    const io = memoryContext(runner, "/nonexistent");
    assertEquals(await runCopyAction(["stars/octo/s1/note.md"], io.context), 0);
    const clip = calls.at(-1);
    assert(clip !== undefined);
    assertEquals(clip.options?.stdin, "https://gist.github.com/s1");
  });
});

Deno.test("__copy with an unresolvable path (no id segment) is a silent no-op", async () => {
  const { repo } = await fixture();
  await withRepoCwd(repo, async () => {
    const { runner, calls } = capturingRunner();
    const io = memoryContext(runner, "/nonexistent");
    assertEquals(await runCopyAction([""], io.context), 0);
    assertEquals(calls.length, 0);
  });
});

Deno.test("__copy degrades to treating the item as unpublished when the index is unreadable", async () => {
  const { repo } = await fixture();
  await Deno.writeTextFile(
    join(repo, ".gistan", "state.json"),
    JSON.stringify({ version: 2, gists: {} }),
  );
  await withRepoCwd(repo, async () => {
    const { runner, calls } = capturingRunner();
    const io = memoryContext(runner, "/nonexistent");
    assertEquals(await runCopyAction(["gists/g1/a.md"], io.context), 0);
    const clip = calls.at(-1);
    assert(clip !== undefined);
    assertEquals(clip.options?.stdin, "g1");
  });
});

// -- runOpenAction (__open {1}) ----------------------------------------------

Deno.test("__open on a published gist path opens the gist URL via the OS opener", async () => {
  const { repo } = await fixture();
  await seedRepo(repo);
  await withRepoCwd(repo, async () => {
    const { runner, calls } = capturingRunner();
    const io = memoryContext(runner, "/nonexistent");
    assertEquals(await runOpenAction(["gists/g1/a.md"], io.context), 0);
    assertEquals(calls, [{
      cmd: OPENER,
      args: ["https://gist.github.com/g1"],
      options: undefined,
    }]);
  });
});

Deno.test("__open on an unpublished local dir is a silent no-op", async () => {
  const { repo } = await fixture();
  await seedRepo(repo);
  await withRepoCwd(repo, async () => {
    const { runner, calls } = capturingRunner();
    const io = memoryContext(runner, "/nonexistent");
    assertEquals(await runOpenAction(["gists/_loc1/x.md"], io.context), 0);
    assertEquals(calls.length, 0);
  });
});

Deno.test("__open on a stars/ path opens the gist URL regardless of index membership", async () => {
  const { repo } = await fixture();
  await seedRepo(repo);
  await withRepoCwd(repo, async () => {
    const { runner, calls } = capturingRunner();
    const io = memoryContext(runner, "/nonexistent");
    assertEquals(await runOpenAction(["stars/octo/s1/note.md"], io.context), 0);
    assertEquals(calls, [{
      cmd: OPENER,
      args: ["https://gist.github.com/s1"],
      options: undefined,
    }]);
  });
});

Deno.test("__open with an unresolvable path (no id segment) is a silent no-op", async () => {
  const { repo } = await fixture();
  await withRepoCwd(repo, async () => {
    const { runner, calls } = capturingRunner();
    const io = memoryContext(runner, "/nonexistent");
    assertEquals(await runOpenAction([""], io.context), 0);
    assertEquals(calls.length, 0);
  });
});

// -- runListRender (__list) --------------------------------------------------

Deno.test("__list renders every file, display-sorted, with plain-text desc suffixes", async () => {
  const { repo } = await fixture();
  await seedRepo(repo);
  await withRepoCwd(repo, async () => {
    const files = [
      "gists/g1/a.md", // published, has a description
      "gists/_loc1/x.md", // unpublished, has a description
      "gists/_loc2/y.md", // unpublished, no description (filesystem-only dir)
      "stars/octo/s1/note.md", // star, has a description
    ];
    const runner: Runner = (cmd, args) => {
      if (cmd === "rg" && args[0] === "--files") {
        return Promise.resolve({
          code: 0,
          stdout: files.map((f) => `${f}\n`).join(""),
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const io = memoryContext(runner, "/nonexistent");
    assertEquals(await runListRender(io.context), 0);
    assertEquals(
      io.stdout,
      "gists/g1/a.md\t\ta.md  — a published gist\n" +
        "stars/octo/s1/note.md\t\tstars/octo/note.md  — a starred gist\n" +
        "gists/_loc1/x.md\t\tx.md  — an unpublished draft\n" +
        "gists/_loc2/y.md\t\ty.md\n",
    );
  });
});

Deno.test("__list with no files prints nothing and exits 0", async () => {
  const { repo } = await fixture();
  await withRepoCwd(repo, async () => {
    const runner: Runner = () => Promise.resolve({ code: 1, stdout: "", stderr: "" });
    const io = memoryContext(runner, "/nonexistent");
    assertEquals(await runListRender(io.context), 0);
    assertEquals(io.stdout, "");
  });
});
