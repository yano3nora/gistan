import { assert, assertEquals } from "@std/assert";
import { EXIT_COMMAND_NOT_FOUND, type Runner, type RunOptions } from "../core/proc.ts";
import { saveState } from "../core/state.ts";
import { exists } from "./shared.ts";
import { AT, fixture, join, memoryContext } from "./test_helpers.ts";
import { run } from "./grep.ts";

interface Call {
  cmd: string;
  args: readonly string[];
  options?: RunOptions;
}

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

// `gistan grep` is the former line-level `gistan search` (TASK-260708
// followup 2), so these are the old search tests under the new name.
// Displayed paths have the `gists/` prefix stripped for readability, so a
// real fzf selection line looks like "a/a.md:12:3:hit", not
// "gists/a/a.md:12:3:hit". These mocks reflect that; toRelPath is what
// restores the real repo-relative path before opening/printing it.

Deno.test("grep opens the picked snippet at its line in a vim-family editor", async () => {
  const { home } = await fixture();
  const { runner, calls } = grepRunner({ code: 0, stdout: "a/a.md:12:3:hit\n" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: ["react"] }, io.context), 0);

  // Skip the deps probe (`fzf --version`) — the real invocation has --disabled.
  const fzf = calls.find((call) => call.cmd === "fzf" && call.args.includes("--disabled"));
  assertEquals(fzf?.args.includes("react"), true); // initial --query
  const editor = calls.find((call) => call.cmd === "vim");
  assertEquals(editor?.args, ["+12", "gists/a/a.md"]);
  assertEquals(editor?.options?.interactive, true);
});

Deno.test("a file-list pick (no line part) opens without a line jump", async () => {
  const { home } = await fixture();
  const { runner, calls } = grepRunner({ code: 0, stdout: "a/a.md\n" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: [] }, io.context), 0);
  const editor = calls.find((call) => call.cmd === "vim");
  assertEquals(editor?.args, ["gists/a/a.md"]);
});

Deno.test("a filename/dirname hit (query matched the path, not the content) opens with no line jump", async () => {
  const { home } = await fixture();
  // Filename hits are concatenated ahead of content-grep hits and carry no
  // `:line:` suffix — same shape as a plain file-list pick.
  const { runner, calls } = grepRunner({ code: 0, stdout: "hello-notes/readme.md\n" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: ["hello"] }, io.context), 0);
  const editor = calls.find((call) => call.cmd === "vim");
  assertEquals(editor?.args, ["gists/hello-notes/readme.md"]);
});

Deno.test("grep opens stars matches read-only", async () => {
  const { home } = await fixture();
  const { runner, calls } = grepRunner({ code: 0, stdout: "stars/octo/g1/note.md:1:1:x\n" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: [] }, io.context), 0);
  const editor = calls.find((call) => call.cmd === "vim");
  assertEquals(editor?.args, ["-R", "+1", "stars/octo/g1/note.md"]);
});

Deno.test("grep passes only the file to a non-vim editor", async () => {
  const { home } = await fixture();
  const { runner, calls } = grepRunner({ code: 0, stdout: "a/a.md:12:3:hit\n" });
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

// -- --path / -p: print the resolved path instead of opening an editor -----

Deno.test("grep --path prints the resolved absolute path and opens no editor", async () => {
  const { home, repo } = await fixture();
  const { runner, calls } = grepRunner({ code: 0, stdout: "a/a.md:12:3:hit\n" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: ["--path"] }, io.context), 0);
  assertEquals(io.stdout, `${join(repo, "gists", "a", "a.md")}\n`);
  assertEquals(calls.some((call) => call.cmd === "vim"), false);
});

Deno.test("grep -p is an alias for --path", async () => {
  const { home, repo } = await fixture();
  const { runner } = grepRunner({ code: 0, stdout: "a/a.md:12:3:hit\n" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: ["-p"] }, io.context), 0);
  assertEquals(io.stdout, `${join(repo, "gists", "a", "a.md")}\n`);
});

Deno.test("grep --path on a stars/ pick keeps the stars/ prefix as-is", async () => {
  const { home, repo } = await fixture();
  const { runner } = grepRunner({ code: 0, stdout: "stars/octo/g1/note.md:1:1:x\n" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: ["-p"] }, io.context), 0);
  assertEquals(io.stdout, `${join(repo, "stars", "octo", "g1", "note.md")}\n`);
});

// -- reload / preview command shape (fzf args) -------------------------------

Deno.test("the reload command strips the gists/ prefix and concatenates filename hits before content hits", async () => {
  const { home } = await fixture();
  const { runner, calls } = grepRunner({ code: 0, stdout: "" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: [] }, io.context), 0);
  const fzf = calls.find((call) => call.cmd === "fzf" && call.args.includes("--disabled"));
  const bindIndex = fzf?.args.indexOf("--bind") ?? -1;
  const reload = fzf?.args[bindIndex + 1] ?? "";
  assert(reload.includes("sed 's|^gists/||'"));
  // Filename/dirname hits (rg --files piped through rg -i) come before the
  // content grep, so they are concatenated ahead of content hits.
  assert(reload.indexOf("rg --files") < reload.indexOf("--column --line-number"));
  assert(reload.includes("|| true"));
});

Deno.test("both reload branches sort by path so directories cluster", async () => {
  const { home } = await fixture();
  const { runner, calls } = grepRunner({ code: 0, stdout: "" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: [] }, io.context), 0);
  const fzf = calls.find((call) => call.cmd === "fzf" && call.args.includes("--disabled"));
  const bindIndex = fzf?.args.indexOf("--bind") ?? -1;
  const reload = fzf?.args[bindIndex + 1] ?? "";
  // Query branch: sort on the uncolored stream, BEFORE the final highlight
  // pass (ANSI codes would break the sort keys). Key 2 is numeric so a
  // filename hit (empty line field = 0) precedes its own content hits.
  const sortIndex = reload.indexOf("sort -t: -k1,1 -k2,2n");
  assert(sortIndex > 0);
  assert(sortIndex < reload.indexOf("rg -i --color=always"));
  // Empty-query branch: plain sort after the prefix strip.
  assert(reload.includes("sed 's|^gists/||' | sort; fi"));
});

Deno.test("shift-up / shift-down scroll the preview; ctrl-u clears the query", async () => {
  const { home } = await fixture();
  const { runner, calls } = grepRunner({ code: 0, stdout: "" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: [] }, io.context), 0);
  const fzf = calls.find((call) => call.cmd === "fzf" && call.args.includes("--disabled"));
  assert(
    fzf?.args.includes(
      "shift-up:preview-half-page-up,shift-down:preview-half-page-down,ctrl-u:clear-query",
    ),
  );
});

Deno.test("the preview command highlights matches over the whole file and tolerates a missing line field", async () => {
  const { home } = await fixture();
  const { runner, calls } = grepRunner({ code: 0, stdout: "" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: [] }, io.context), 0);
  const fzf = calls.find((call) => call.cmd === "fzf" && call.args.includes("--disabled"));
  const previewIndex = fzf?.args.indexOf("--preview") ?? -1;
  const preview = fzf?.args[previewIndex + 1] ?? "";
  assert(preview.includes("rg --color=always --passthru"));
  // Resolves the stripped path back against gists/ when it doesn't exist as-is,
  // then requires a regular file: an empty {1} (empty result list) would
  // otherwise resolve to the gists/ directory and --passthru would dump it all.
  assert(preview.includes('[ -f "$f" ] || f="gists/$f"'));
  assert(preview.includes('[ -f "$f" ] || exit 0'));
  // Guards the empty-{2} (filename-hit) case instead of feeding it into arithmetic.
  assert(preview.includes('[ -n "$ln" ]'));
});

// -- ctrl-o: open the selected item's gist in the browser --------------------

function ctrlOBind(calls: readonly Call[]): string | undefined {
  const fzf = calls.find((call) => call.cmd === "fzf" && call.args.includes("--disabled"));
  return fzf?.args.find((arg) => arg.startsWith("ctrl-o:execute-silent("));
}

/** The dirname->id map file path is embedded in the bind, right after the awk program. */
function mapFileFromBind(bind: string): string | undefined {
  return bind.match(/\{print \$2\}' "([^"]+)"/)?.[1];
}

Deno.test("ctrl-o is bound to a silent gist-URL opener fed by the dirname->id map file", async () => {
  const { home } = await fixture();
  const { runner, calls } = grepRunner({ code: 0, stdout: "" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: [] }, io.context), 0);
  const bind = ctrlOBind(calls);
  assert(bind !== undefined);
  const mapFile = mapFileFromBind(bind);
  assert(mapFile !== undefined && mapFile !== "");
  // Same URL shape as gistUrl(), opener picked per OS, stars/ short-circuited.
  const opener = Deno.build.os === "darwin" ? "open" : "xdg-open";
  assert(bind.includes(`${opener} "https://gist.github.com/$id"`));
  assert(bind.includes('test "$d" = stars && exit 0'));
  assert(bind.includes("awk -F'\\t'"));
});

Deno.test("the map file holds one dirname\\tid line per index entry and is removed after fzf exits", async () => {
  const { home, repo } = await fixture();
  await saveState(repo, {
    version: 2,
    gists: {
      alpha: {
        id: "id-alpha",
        visibility: "public",
        remote_updated_at: AT,
        synced_description_hash: null,
        files: {},
      },
      beta: {
        id: "id-beta",
        visibility: "secret",
        remote_updated_at: AT,
        synced_description_hash: null,
        files: {},
      },
    },
  });
  // Capture the map file's contents while fzf is "running" — run() deletes
  // it right after the runner call returns.
  let mapFile: string | undefined;
  let contents: string | undefined;
  const runner: Runner = (cmd, args) => {
    if (cmd === "fzf" && args.includes("--disabled")) {
      mapFile = mapFileFromBind(args.find((a) => a.startsWith("ctrl-o:")) ?? "");
      if (mapFile !== undefined) contents = Deno.readTextFileSync(mapFile);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: [] }, io.context), 0);
  assertEquals(contents, "alpha\tid-alpha\nbeta\tid-beta\n");
  assert(mapFile !== undefined);
  assertEquals(await exists(mapFile), false);
});

Deno.test("the map file is removed even when fzf fails", async () => {
  const { home } = await fixture();
  let mapFile: string | undefined;
  const runner: Runner = (cmd, args) => {
    if (cmd === "fzf" && args.includes("--disabled")) {
      mapFile = mapFileFromBind(args.find((a) => a.startsWith("ctrl-o:")) ?? "");
      return Promise.resolve({ code: 2, stdout: "", stderr: "boom" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "grep", args: [] }, io.context), 1);
  assert(mapFile !== undefined);
  assertEquals(await exists(mapFile), false);
});
