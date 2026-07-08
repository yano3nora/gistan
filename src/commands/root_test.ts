import { assert, assertEquals } from "@std/assert";
import { join as pathJoin } from "@std/path";
import { loadConfig } from "../core/config.ts";
import { EXIT_COMMAND_NOT_FOUND, type Runner, type RunOptions } from "../core/proc.ts";
import { fixture, memoryContext, okRunner } from "./test_helpers.ts";
import { run } from "./root.ts";

const ok = { code: 0, stdout: "", stderr: "" };

interface Call {
  cmd: string;
  args: readonly string[];
  options?: RunOptions;
}

function recordingRunner(handler: Runner): { runner: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: Runner = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return handler(cmd, args, options);
  };
  return { runner, calls };
}

// -- root (no subcommand) / unknown subcommand -----------------------------

Deno.test("root with no subcommand prints usage", async () => {
  const home = await Deno.makeTempDir();
  const io = memoryContext(okRunner(), home);
  assertEquals(await run({ name: "root", args: [] }, io.context), 0);
  assert(io.stdout.includes("gistan root init"));
  assert(io.stdout.includes("gistan root commit"));
});

Deno.test("root rejects an unknown subcommand", async () => {
  const home = await Deno.makeTempDir();
  const io = memoryContext(okRunner(), home);
  assertEquals(await run({ name: "root", args: ["bogus"] }, io.context), 2);
  assert(io.stderr.includes("unknown"));
});

// -- root init (moved from the old top-level `gistan init`) ----------------

Deno.test("root init creates a local repo, scaffolds it, and is idempotent", async () => {
  const home = await Deno.makeTempDir();
  const repoDir = pathJoin(home, "gistan");
  const runner: Runner = async (cmd, args, options) => {
    if (cmd === "git" && args[0] === "init") {
      // Simulate git: a .git directory appears in the cwd.
      await Deno.mkdir(pathJoin(options?.cwd ?? ".", ".git"), { recursive: true });
      return ok;
    }
    return ok;
  };

  const first = memoryContext(runner, home);
  assertEquals(await run({ name: "root", args: ["init"] }, first.context), 0);
  assert(first.stdout.includes("initialized a local git repo"));
  assertEquals(
    JSON.parse(await Deno.readTextFile(pathJoin(repoDir, ".gistan", "state.json"))),
    { version: 2, gists: {} },
  );
  const gitignore = await Deno.readTextFile(pathJoin(repoDir, ".gitignore"));
  assert(gitignore.includes("stars/"));
  assert(gitignore.includes(".gistan/cache/"));
  assertEquals(await loadConfig(pathJoin(home, "config.toml")), { repo: repoDir });

  const second = memoryContext(runner, home);
  assertEquals(await run({ name: "root", args: ["init"] }, second.context), 0);
  assert(second.stdout.includes("using existing repo"));
});

Deno.test("root init fails fast when a required dependency is missing", async () => {
  const home = await Deno.makeTempDir();
  const runner: Runner = (cmd) =>
    Promise.resolve(
      cmd === "gh" ? { code: EXIT_COMMAND_NOT_FOUND, stdout: "", stderr: "" } : ok,
    );

  const io = memoryContext(runner, home);
  assertEquals(await run({ name: "root", args: ["init"] }, io.context), 1);
  assert(io.stderr.includes("gh not found"));
});

Deno.test("root init guides the user when gh is not authenticated", async () => {
  const home = await Deno.makeTempDir();
  const runner: Runner = (cmd, args) =>
    Promise.resolve(
      cmd === "gh" && args[0] === "auth" ? { code: 1, stdout: "", stderr: "" } : ok,
    );

  const io = memoryContext(runner, home);
  assertEquals(await run({ name: "root", args: ["init"] }, io.context), 1);
  assert(io.stderr.includes("gh auth login"));
});

Deno.test("root init refuses a non-empty directory that is not a git repo", async () => {
  const home = await Deno.makeTempDir();
  const dir = pathJoin(home, "occupied");
  await Deno.mkdir(dir);
  await Deno.writeTextFile(pathJoin(dir, "something.txt"), "hi");

  const io = memoryContext(okRunner(), home);
  assertEquals(await run({ name: "root", args: ["init", dir] }, io.context), 1);
  assert(io.stderr.includes("not a git repo"));
});

// -- root path ---------------------------------------------------------------

Deno.test("root path prints the configured repo's absolute path", async () => {
  const { home, repo } = await fixture();
  const io = memoryContext(okRunner(), home);
  assertEquals(await run({ name: "root", args: ["path"] }, io.context), 0);
  assertEquals(io.stdout, `${repo}\n`);
});

Deno.test("root path requires init to have run", async () => {
  const home = await Deno.makeTempDir();
  const io = memoryContext(okRunner(), home);
  assertEquals(await run({ name: "root", args: ["path"] }, io.context), 1);
  assert(io.stderr.includes("gistan root init"));
});

// -- root commit ---------------------------------------------------------------

function commitRunner(stagedCode: number): { runner: Runner; calls: Call[] } {
  return recordingRunner((cmd, args) => {
    if (cmd === "git" && args[0] === "diff") {
      return Promise.resolve({ code: stagedCode, stdout: "", stderr: "" });
    }
    return Promise.resolve(ok);
  });
}

Deno.test("root commit adds and commits with the default auto message", async () => {
  const { home, repo } = await fixture();
  const { runner, calls } = commitRunner(1); // 1 = something staged
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "root", args: ["commit"] }, io.context), 0);
  const add = calls.find((c) => c.args[0] === "add");
  assertEquals(add?.args, ["add", "-A"]);
  assertEquals(add?.options?.cwd, repo);
  const commit = calls.find((c) => c.args[0] === "commit");
  assertEquals(commit?.args, ["commit", "-m", "docs: auto commit (gistan)"]);
  assert(io.stdout.includes("committed"));
});

Deno.test("root commit -m uses the given message", async () => {
  const { home } = await fixture();
  const { runner, calls } = commitRunner(1);
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "root", args: ["commit", "-m", "wip: notes"] }, io.context), 0);
  const commit = calls.find((c) => c.args[0] === "commit");
  assertEquals(commit?.args, ["commit", "-m", "wip: notes"]);
});

Deno.test("root commit with nothing staged exits 0 without committing", async () => {
  const { home } = await fixture();
  const { runner, calls } = commitRunner(0); // 0 = nothing staged
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "root", args: ["commit"] }, io.context), 0);
  assert(io.stdout.includes("nothing to commit"));
  assertEquals(calls.some((c) => c.args[0] === "commit"), false);
});

Deno.test("root commit propagates a git commit failure verbatim", async () => {
  const { home } = await fixture();
  const { runner } = recordingRunner((cmd, args) => {
    if (cmd === "git" && args[0] === "diff") {
      return Promise.resolve({ code: 1, stdout: "", stderr: "" });
    }
    if (cmd === "git" && args[0] === "commit") {
      return Promise.resolve({ code: 1, stdout: "", stderr: "fatal: bad hook\n" });
    }
    return Promise.resolve(ok);
  });
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "root", args: ["commit"] }, io.context), 1);
  assertEquals(io.stderr, "fatal: bad hook\n");
});

// -- root push / root pull ------------------------------------------------

Deno.test("root push runs git push in the repo and returns its exit code", async () => {
  const { home, repo } = await fixture();
  const { runner, calls } = recordingRunner(() => Promise.resolve(ok));
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "root", args: ["push"] }, io.context), 0);
  const push = calls.find((c) => c.cmd === "git");
  assertEquals(push?.args, ["push"]);
  assertEquals(push?.options?.cwd, repo);
});

Deno.test("root push propagates a git failure (e.g. no remote configured)", async () => {
  const { home } = await fixture();
  const { runner } = recordingRunner(() =>
    Promise.resolve({ code: 1, stdout: "", stderr: "fatal: No configured push destination.\n" })
  );
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "root", args: ["push"] }, io.context), 1);
  assertEquals(io.stderr, "fatal: No configured push destination.\n");
});

Deno.test("root pull runs git pull --rebase in the repo and returns its exit code", async () => {
  const { home, repo } = await fixture();
  const { runner, calls } = recordingRunner(() => Promise.resolve(ok));
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "root", args: ["pull"] }, io.context), 0);
  const pull = calls.find((c) => c.cmd === "git");
  assertEquals(pull?.args, ["pull", "--rebase"]);
  assertEquals(pull?.options?.cwd, repo);
});

Deno.test("root pull propagates a git failure verbatim", async () => {
  const { home } = await fixture();
  const { runner } = recordingRunner(() =>
    Promise.resolve({ code: 1, stdout: "", stderr: "fatal: couldn't find remote ref\n" })
  );
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "root", args: ["pull"] }, io.context), 1);
  assertEquals(io.stderr, "fatal: couldn't find remote ref\n");
});
