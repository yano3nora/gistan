import { assert, assertEquals } from "@std/assert";
import { EXIT_COMMAND_NOT_FOUND, type Runner, type RunOptions } from "../core/proc.ts";
import { FIELD_DELIMITER } from "./shared.ts";
import { fixture, join, memoryContext } from "./test_helpers.ts";
import { run, selfRenderCommand } from "./grep.ts";

interface Call {
  cmd: string;
  args: readonly string[];
  options?: RunOptions;
}

// `gistan grep` is the line-level regex mode (TASK-260708 followup 2); the
// list itself is now rendered by the hidden `__grep-render` subcommand
// (grep_render.ts, covered by grep_render_test.ts) instead of an sh
// pipeline. What's left here is the fzf session wiring shared with search
// (runQueryUi, shared.ts) plus grep's own selfRenderCommand and preview tail.

function grepRunner(fzf: { code: number; stdout: string }): { runner: Runner; calls: Call[] } {
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

function fzfCall(calls: readonly Call[]): Call | undefined {
  return calls.find((call) => call.cmd === "fzf" && call.args.includes("--disabled"));
}

// -- selfRenderCommand: the fzf reload re-invokes gistan itself --------------

Deno.test("selfRenderCommand spells out deno run + entrypoint + permissions in dev", () => {
  const cmd = selfRenderCommand("/opt/deno/bin/deno", "file:///work/gistan/src/main.ts");
  assertEquals(
    cmd,
    '"/opt/deno/bin/deno" run --allow-read --allow-run --allow-env ' +
      '"/work/gistan/src/main.ts" __grep-render {q}',
  );
});

Deno.test("selfRenderCommand calls the compiled binary directly", () => {
  const cmd = selfRenderCommand("/usr/local/bin/gistan", "file:///usr/local/bin/gistan");
  assertEquals(cmd, '"/usr/local/bin/gistan" __grep-render {q}');
});

// -- run(): fzf wiring --------------------------------------------------------

Deno.test("grep runs fzf disabled+ansi with the grep-render reload bind", async () => {
  const { home } = await fixture();
  const { runner, calls } = grepRunner({ code: 130, stdout: "" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: ["react"] }, io.context), 0);
  const fzf = fzfCall(calls);
  assert(fzf !== undefined);
  assert(fzf.args.includes("--disabled"));
  assert(fzf.args.includes("--ansi"));
  assert(fzf.args.includes("react")); // initial --query
  const reloads = fzf.args.filter((arg) => arg.includes("reload:"));
  assertEquals(reloads.length, 2); // start + change
  for (const bind of reloads) {
    assert(bind.includes("__grep-render {q}"));
  }
  assertEquals(fzf.args[fzf.args.indexOf("--delimiter") + 1], "\t");
  assertEquals(fzf.args[fzf.args.indexOf("--with-nth") + 1], "3..");
  assert(fzf.args.some((arg) => arg.startsWith("ctrl-o:execute-silent(")));
  assert(fzf.args.some((arg) => arg.startsWith("ctrl-y:execute-silent(")));
});

Deno.test("shift-up / shift-down scroll the preview; ctrl-u clears the query; the pane wraps", async () => {
  const { home } = await fixture();
  const { runner, calls } = grepRunner({ code: 130, stdout: "" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: [] }, io.context), 0);
  const fzf = fzfCall(calls);
  assert(
    fzf?.args.includes(
      "shift-up:preview-half-page-up,shift-down:preview-half-page-down,ctrl-u:clear-query," +
        "ctrl-/:toggle-preview-wrap",
    ),
  );
  assertEquals(fzf?.args[fzf.args.indexOf("--preview-window") + 1], "wrap");
  assertEquals(fzf?.args[fzf.args.indexOf("--layout") + 1], "reverse");
});

function previewArg(calls: readonly Call[]): string {
  const fzf = fzfCall(calls);
  if (fzf === undefined) return "";
  return String(fzf.args[fzf.args.indexOf("--preview") + 1] ?? "");
}

Deno.test("the preview self-invokes __preview grep, passing {2} as the line anchor", async () => {
  const { home } = await fixture();
  const { runner, calls } = grepRunner({ code: 130, stdout: "" });
  const io = memoryContext(runner, home, { editor: "vim" });
  assertEquals(await run({ name: "grep", args: [] }, io.context), 0);
  assert(previewArg(calls).includes("__preview grep bat {q} {1} {2}"));

  const { home: home2 } = await fixture();
  const calls2: Call[] = [];
  const runner2: Runner = (cmd, args, options) => {
    calls2.push({ cmd, args, options });
    if (cmd === "bat") {
      return Promise.resolve({ code: EXIT_COMMAND_NOT_FOUND, stdout: "", stderr: "" });
    }
    if (cmd === "fzf" && args.includes("--disabled")) {
      return Promise.resolve({ code: 130, stdout: "", stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io2 = memoryContext(runner2, home2, { editor: "vim" });
  assertEquals(await run({ name: "grep", args: [] }, io2.context), 0);
  assert(previewArg(calls2).includes("__preview grep nobat {q} {1} {2}"));
});

Deno.test("ctrl-v hands the selection to config.viewer; unset viewer installs no bind", async () => {
  const { home } = await fixture({ viewer: "leaf" });
  const { runner, calls } = grepRunner({ code: 130, stdout: "" });
  const io = memoryContext(runner, home, { editor: "vim" });
  assertEquals(await run({ name: "grep", args: [] }, io.context), 0);
  const bind = fzfCall(calls)?.args.find((arg) => arg.startsWith("ctrl-v:execute("));
  assert(bind !== undefined);
  assertEquals(bind, "ctrl-v:execute(test -f {1} && leaf {1})");

  const { home: home2 } = await fixture();
  const { runner: runner2, calls: calls2 } = grepRunner({ code: 130, stdout: "" });
  const io2 = memoryContext(runner2, home2, { editor: "vim" });
  assertEquals(await run({ name: "grep", args: [] }, io2.context), 0);
  assertEquals(fzfCall(calls2)?.args.some((arg) => arg.startsWith("ctrl-v:")), false);
});

// -- selection handling ---------------------------------------------------

Deno.test("a picked row opens the editor at its line field", async () => {
  const { home } = await fixture();
  const row = `gists/a/a.md${FIELD_DELIMITER}12${FIELD_DELIMITER}a.md:12:3:hit`;
  const { runner, calls } = grepRunner({ code: 0, stdout: `${row}\n` });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: ["react"] }, io.context), 0);
  const editor = calls.find((call) => call.cmd === "vim");
  assertEquals(editor?.args, ["+12", "gists/a/a.md"]);
  assertEquals(editor?.options?.interactive, true);
});

Deno.test("a path-only pick (empty line field) opens without a line jump", async () => {
  const { home } = await fixture();
  const row = `gists/a/a.md${FIELD_DELIMITER}${FIELD_DELIMITER}a.md`;
  const { runner, calls } = grepRunner({ code: 0, stdout: `${row}\n` });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: [] }, io.context), 0);
  const editor = calls.find((call) => call.cmd === "vim");
  assertEquals(editor?.args, ["gists/a/a.md"]);
});

Deno.test("grep opens stars matches read-only", async () => {
  const { home } = await fixture();
  const row = `stars/octo/g1/note.md${FIELD_DELIMITER}1${FIELD_DELIMITER}stars/octo/note.md:1:1:x`;
  const { runner, calls } = grepRunner({ code: 0, stdout: `${row}\n` });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: [] }, io.context), 0);
  const editor = calls.find((call) => call.cmd === "vim");
  assertEquals(editor?.args, ["-R", "+1", "stars/octo/g1/note.md"]);
});

Deno.test("grep passes only the file to a non-vim editor", async () => {
  const { home } = await fixture();
  const row = `gists/a/a.md${FIELD_DELIMITER}12${FIELD_DELIMITER}a.md:12:3:hit`;
  const { runner, calls } = grepRunner({ code: 0, stdout: `${row}\n` });
  const io = memoryContext(runner, home, { editor: "code" });

  assertEquals(await run({ name: "grep", args: [] }, io.context), 0);
  const editor = calls.find((call) => call.cmd === "code");
  assertEquals(editor?.args, ["gists/a/a.md"]);
});

Deno.test("an aborted fzf session is not an error and opens nothing", async () => {
  const { home } = await fixture();
  const { runner, calls } = grepRunner({ code: 130, stdout: "" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: [] }, io.context), 0);
  assertEquals(calls.some((call) => call.cmd === "vim"), false);
});

Deno.test("grep requires rg and fzf", async () => {
  const { home } = await fixture();
  const runner: Runner = (cmd) =>
    Promise.resolve(
      cmd === "fzf"
        ? { code: EXIT_COMMAND_NOT_FOUND, stdout: "", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "grep", args: [] }, io.context), 1);
  assert(io.stderr.includes("fzf is required for grep"));
});

Deno.test("grep requires init to have run", async () => {
  const home = await Deno.makeTempDir();
  const { runner } = grepRunner({ code: 0, stdout: "" });
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "grep", args: [] }, io.context), 1);
  assert(io.stderr.includes("gistan root init"));
});

Deno.test("fzf no-match (1) and abort (130) are normal exits that open nothing", async () => {
  for (const code of [1, 130]) {
    const { home } = await fixture();
    const { runner, calls } = grepRunner({ code, stdout: "" });
    const io = memoryContext(runner, home, { editor: "vim" });

    assertEquals(await run({ name: "grep", args: [] }, io.context), 0);
    assertEquals(calls.some((call) => call.cmd === "vim"), false);
  }
});

// -- --path / -p: print the resolved path instead of opening an editor -----

Deno.test("grep --path prints the resolved absolute path and opens no editor", async () => {
  const { home, repo } = await fixture();
  const row = `gists/a/a.md${FIELD_DELIMITER}12${FIELD_DELIMITER}a.md:12:3:hit`;
  const { runner, calls } = grepRunner({ code: 0, stdout: `${row}\n` });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: ["--path"] }, io.context), 0);
  assertEquals(io.stdout, `${join(repo, "gists", "a", "a.md")}\n`);
  assertEquals(calls.some((call) => call.cmd === "vim"), false);
});

Deno.test("grep -p is an alias for --path", async () => {
  const { home, repo } = await fixture();
  const row = `gists/a/a.md${FIELD_DELIMITER}12${FIELD_DELIMITER}a.md:12:3:hit`;
  const { runner } = grepRunner({ code: 0, stdout: `${row}\n` });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: ["-p"] }, io.context), 0);
  assertEquals(io.stdout, `${join(repo, "gists", "a", "a.md")}\n`);
});

Deno.test("grep --path on a stars/ pick keeps the stars/ prefix as-is", async () => {
  const { home, repo } = await fixture();
  const row = `stars/octo/g1/note.md${FIELD_DELIMITER}1${FIELD_DELIMITER}stars/octo/note.md:1:1:x`;
  const { runner } = grepRunner({ code: 0, stdout: `${row}\n` });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: ["-p"] }, io.context), 0);
  assertEquals(io.stdout, `${join(repo, "stars", "octo", "g1", "note.md")}\n`);
});
