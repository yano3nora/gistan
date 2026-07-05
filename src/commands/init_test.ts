import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { loadConfig } from "../core/config.ts";
import { EXIT_COMMAND_NOT_FOUND, type Runner } from "../core/proc.ts";
import { memoryContext } from "../testing.ts";
import { run } from "./init.ts";

const ok = { code: 0, stdout: "", stderr: "" };

Deno.test("init creates a local repo, scaffolds it, and is idempotent", async () => {
  const home = await Deno.makeTempDir();
  const repoDir = join(home, "gistan");
  const runner: Runner = async (cmd, args, options) => {
    if (cmd === "git" && args[0] === "init") {
      // Simulate git: a .git directory appears in the cwd.
      await Deno.mkdir(join(options?.cwd ?? ".", ".git"), { recursive: true });
      return ok;
    }
    return ok;
  };

  const first = memoryContext(runner, home);
  assertEquals(await run({ name: "init", args: [] }, first.context), 0);
  assertEquals(first.stdout.includes("initialized a local git repo"), true);
  assertEquals(
    JSON.parse(await Deno.readTextFile(join(repoDir, ".gistan", "state.json"))),
    { version: 1, snippets: {} },
  );
  const gitignore = await Deno.readTextFile(join(repoDir, ".gitignore"));
  assertEquals(gitignore.includes("stars/"), true);
  assertEquals(gitignore.includes(".gistan/cache/"), true);
  assertEquals(await loadConfig(join(home, "config.toml")), { repo: repoDir });

  const second = memoryContext(runner, home);
  assertEquals(await run({ name: "init", args: [] }, second.context), 0);
  assertEquals(second.stdout.includes("using existing repo"), true);
});

Deno.test("init fails fast when a required dependency is missing", async () => {
  const home = await Deno.makeTempDir();
  const runner: Runner = (cmd) =>
    Promise.resolve(
      cmd === "gh" ? { code: EXIT_COMMAND_NOT_FOUND, stdout: "", stderr: "" } : ok,
    );

  const io = memoryContext(runner, home);
  assertEquals(await run({ name: "init", args: [] }, io.context), 1);
  assertEquals(io.stderr.includes("gh not found"), true);
});

Deno.test("init guides the user when gh is not authenticated", async () => {
  const home = await Deno.makeTempDir();
  const runner: Runner = (cmd, args) =>
    Promise.resolve(
      cmd === "gh" && args[0] === "auth" ? { code: 1, stdout: "", stderr: "" } : ok,
    );

  const io = memoryContext(runner, home);
  assertEquals(await run({ name: "init", args: [] }, io.context), 1);
  assertEquals(io.stderr.includes("gh auth login"), true);
});

Deno.test("init refuses a non-empty directory that is not a git repo", async () => {
  const home = await Deno.makeTempDir();
  const dir = join(home, "occupied");
  await Deno.mkdir(dir);
  await Deno.writeTextFile(join(dir, "something.txt"), "hi");

  const io = memoryContext(() => Promise.resolve(ok), home);
  assertEquals(await run({ name: "init", args: [dir] }, io.context), 1);
  assertEquals(io.stderr.includes("not a git repo"), true);
});
