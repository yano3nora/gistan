import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { saveConfig } from "../core/config.ts";
import type { Runner, RunOptions } from "../core/proc.ts";
import { EXIT_COMMAND_NOT_FOUND } from "../core/proc.ts";
import { memoryContext } from "../testing.ts";
import { run } from "./search.ts";

interface Call {
  cmd: string;
  args: readonly string[];
  options?: RunOptions;
}

function searchRunner(fzf: { code: number; stdout: string }): { runner: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: Runner = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (cmd === "fzf" && args.includes("--disabled")) {
      return Promise.resolve({ code: fzf.code, stdout: fzf.stdout, stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  return { runner, calls };
}

async function fixture() {
  const home = await Deno.makeTempDir();
  const repo = join(home, "repo");
  await Deno.mkdir(repo, { recursive: true });
  await saveConfig(join(home, "config.toml"), { repo });
  return home;
}

Deno.test("search opens the picked snippet at its line in a vim-family editor", async () => {
  const home = await fixture();
  const { runner, calls } = searchRunner({ code: 0, stdout: "snippets/a.md:12:3:hit\n" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "search", args: ["react"] }, io.context), 0);

  // Skip the deps probe (`fzf --version`) — the real invocation has --disabled.
  const fzf = calls.find((call) => call.cmd === "fzf" && call.args.includes("--disabled"));
  assertEquals(fzf?.args.includes("react"), true); // initial --query
  const editor = calls.find((call) => call.cmd === "vim");
  assertEquals(editor?.args, ["+12", "snippets/a.md"]);
  assertEquals(editor?.options?.interactive, true);
});

Deno.test("search opens stars matches read-only", async () => {
  const home = await fixture();
  const { runner, calls } = searchRunner({ code: 0, stdout: "stars/octo/g1/note.md:1:1:x\n" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "search", args: [] }, io.context), 0);
  const editor = calls.find((call) => call.cmd === "vim");
  assertEquals(editor?.args, ["-R", "+1", "stars/octo/g1/note.md"]);
});

Deno.test("search passes only the file to a non-vim editor", async () => {
  const home = await fixture();
  const { runner, calls } = searchRunner({ code: 0, stdout: "snippets/a.md:12:3:hit\n" });
  const io = memoryContext(runner, home, { editor: "code" });

  assertEquals(await run({ name: "search", args: [] }, io.context), 0);
  const editor = calls.find((call) => call.cmd === "code");
  assertEquals(editor?.args, ["snippets/a.md"]);
});

Deno.test("an aborted fzf session is not an error and opens nothing", async () => {
  const home = await fixture();
  const { runner, calls } = searchRunner({ code: 130, stdout: "" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "search", args: [] }, io.context), 0);
  assertEquals(calls.some((call) => call.cmd === "vim"), false);
});

Deno.test("search requires rg and fzf", async () => {
  const home = await fixture();
  const runner: Runner = (cmd) =>
    Promise.resolve(
      cmd === "fzf"
        ? { code: EXIT_COMMAND_NOT_FOUND, stdout: "", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "search", args: [] }, io.context), 1);
  assertEquals(io.stderr.includes("fzf is required for search"), true);
});

Deno.test("search requires init to have run", async () => {
  const home = await Deno.makeTempDir();
  const { runner } = searchRunner({ code: 0, stdout: "" });
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "search", args: [] }, io.context), 1);
  assertEquals(io.stderr.includes("gistan init"), true);
});
