import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { saveConfig } from "../core/config.ts";
import type { Runner } from "../core/proc.ts";
import { memoryContext } from "../testing.ts";
import { run } from "./sync.ts";

async function fixture() {
  const home = await Deno.makeTempDir();
  const repo = join(home, "repo");
  await Deno.mkdir(repo, { recursive: true });
  await saveConfig(join(home, "config.toml"), { repo });
  return home;
}

function gitRunner(options: { staged: boolean; remote: string }) {
  const calls: string[] = [];
  const runner: Runner = (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "git" && args[0] === "diff") {
      return Promise.resolve({ code: options.staged ? 1 : 0, stdout: "", stderr: "" });
    }
    if (cmd === "git" && args[0] === "remote") {
      return Promise.resolve({ code: 0, stdout: options.remote, stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  return { runner, calls };
}

Deno.test("sync commits, pulls, and pushes when there are changes and a remote", async () => {
  const home = await fixture();
  const { runner, calls } = gitRunner({ staged: true, remote: "origin\n" });
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "sync", args: [] }, io.context), 0);
  assertEquals(calls.some((call) => call.startsWith("git commit")), true);
  assertEquals(calls.some((call) => call.startsWith("git pull --rebase")), true);
  assertEquals(calls.some((call) => call.startsWith("git push")), true);
  assertEquals(io.stdout.includes("synced with remote"), true);
});

Deno.test("sync stops after the local commit without a remote", async () => {
  const home = await fixture();
  const { runner, calls } = gitRunner({ staged: true, remote: "" });
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "sync", args: [] }, io.context), 0);
  assertEquals(calls.some((call) => call.startsWith("git push")), false);
  assertEquals(io.stdout.includes("local commit only"), true);
});

Deno.test("sync skips the commit when nothing changed", async () => {
  const home = await fixture();
  const { runner, calls } = gitRunner({ staged: false, remote: "" });
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "sync", args: [] }, io.context), 0);
  assertEquals(calls.some((call) => call.startsWith("git commit")), false);
  assertEquals(io.stdout.includes("nothing to commit"), true);
});
