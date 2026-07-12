import { assert, assertEquals } from "@std/assert";
import type { Runner, RunOptions } from "../core/proc.ts";
import {
  copyBind,
  DISPLAY_FIELDS,
  editorArgs,
  FIELD_DELIMITER,
  openBind,
  pickFile,
  requireConfig,
  selfCommand,
  viewerBind,
} from "./shared.ts";
import { memoryContext, okRunner } from "./test_helpers.ts";

interface Call {
  cmd: string;
  args: readonly string[];
  options?: RunOptions;
}

// -- selfCommand: dev (deno run) vs compiled binary shapes -------------------

Deno.test("selfCommand spells out deno run + entrypoint + permissions in dev", () => {
  assertEquals(
    selfCommand("/opt/deno/bin/deno", "file:///work/gistan/src/main.ts", "__list"),
    '"/opt/deno/bin/deno" run --allow-read --allow-run --allow-env "/work/gistan/src/main.ts" __list',
  );
});

Deno.test("selfCommand calls the compiled binary directly", () => {
  assertEquals(
    selfCommand("/usr/local/bin/gistan", "file:///usr/local/bin/gistan", "__list"),
    '"/usr/local/bin/gistan" __list',
  );
});

// -- openBind / copyBind / viewerBind ----------------------------------------

Deno.test("openBind wraps the self __open invocation in a silent ctrl-o execute", () => {
  assertEquals(openBind("gistan __open {1}"), "ctrl-o:execute-silent(gistan __open {1})");
});

Deno.test("copyBind wraps the self __copy invocation in a silent ctrl-y execute", () => {
  assertEquals(copyBind("gistan __copy {1}"), "ctrl-y:execute-silent(gistan __copy {1})");
});

Deno.test("viewerBind guards on file existence before handing off to the viewer", () => {
  assertEquals(viewerBind("leaf"), "ctrl-v:execute(test -f {1} && leaf {1})");
});

// -- editorArgs: vim-family line jump + stars/ read-only -------------------

Deno.test("editorArgs gives vim-family editors a +line jump; others get the plain path", () => {
  assertEquals(editorArgs("vim", "gists/a/x.md", "12"), ["+12", "gists/a/x.md"]);
  assertEquals(editorArgs("nvim", "gists/a/x.md", "12"), ["+12", "gists/a/x.md"]);
  assertEquals(editorArgs("vim", "gists/a/x.md"), ["gists/a/x.md"]);
  assertEquals(editorArgs("code", "gists/a/x.md", "12"), ["gists/a/x.md"]);
});

Deno.test("editorArgs adds -R for stars/ paths in vim-family editors only", () => {
  assertEquals(editorArgs("vim", "stars/o/g/x.md", "3"), ["-R", "+3", "stars/o/g/x.md"]);
  assertEquals(editorArgs("nvim", "stars/o/g/x.md"), ["-R", "stars/o/g/x.md"]);
  assertEquals(editorArgs("code", "stars/o/g/x.md"), ["stars/o/g/x.md"]);
});

// -- requireConfig ------------------------------------------------------------

Deno.test("requireConfig explains how to init when config is missing", async () => {
  const home = await Deno.makeTempDir();
  const io = memoryContext(okRunner(), home);
  const config = await requireConfig(io.context);
  assertEquals(config, undefined);
  assert(io.stderr.includes("gistan root init"));
});

// -- pickFile: fuzzy pick behind edit / rm -----------------------------------

Deno.test("pickFile reloads from __list with the row protocol and previews head -40 {1}", async () => {
  const calls: Call[] = [];
  const runner: Runner = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return Promise.resolve({
      code: 0,
      stdout: `gists/a/x.md${FIELD_DELIMITER}${FIELD_DELIMITER}x.md\n`,
      stderr: "",
    });
  };
  const io = memoryContext(runner, "/nonexistent");
  const result = await pickFile(io.context, "/repo", "query");
  assertEquals(result, { path: "gists/a/x.md", failed: false });

  const fzf = calls.find((call) => call.cmd === "fzf");
  assert(fzf !== undefined);
  assertEquals(fzf.args[fzf.args.indexOf("--query") + 1], "query");
  assertEquals(fzf.args[fzf.args.indexOf("--delimiter") + 1], FIELD_DELIMITER);
  assertEquals(fzf.args[fzf.args.indexOf("--with-nth") + 1], DISPLAY_FIELDS);
  const bind = fzf.args[fzf.args.indexOf("--bind") + 1];
  assert(bind.includes("__list"));
  assertEquals(fzf.args[fzf.args.indexOf("--preview") + 1], "head -40 {1}");
  assertEquals(fzf.options?.cwd, "/repo");
});

Deno.test("pickFile treats fzf no-match/abort as an empty (not failed) pick", async () => {
  for (const code of [1, 130]) {
    const runner: Runner = () => Promise.resolve({ code, stdout: "", stderr: "" });
    const io = memoryContext(runner, "/nonexistent");
    assertEquals(await pickFile(io.context, "/repo", ""), { failed: false });
  }
});

Deno.test("pickFile reports a hard fzf failure and leaves path undefined", async () => {
  const runner: Runner = () => Promise.resolve({ code: 2, stdout: "", stderr: "boom" });
  const io = memoryContext(runner, "/nonexistent");
  const result = await pickFile(io.context, "/repo", "");
  assertEquals(result.failed, true);
  assertEquals(result.path, undefined);
  assert(io.stderr.includes("fzf failed"));
});

Deno.test("pickFile parses only the first tab field of the selection (the real path)", async () => {
  const runner: Runner = () =>
    Promise.resolve({
      code: 0,
      stdout: `gists/a/x.md${FIELD_DELIMITER}${FIELD_DELIMITER}x.md  — a description\n`,
      stderr: "",
    });
  const io = memoryContext(runner, "/nonexistent");
  const result = await pickFile(io.context, "/repo", "");
  assertEquals(result.path, "gists/a/x.md");
});
