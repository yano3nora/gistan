import { assert, assertEquals } from "@std/assert";
import { EXIT_COMMAND_NOT_FOUND, type Runner, type RunOptions } from "../core/proc.ts";
import { saveState } from "../core/state.ts";
import { exists } from "./shared.ts";
import { AT, fixture, join, memoryContext } from "./test_helpers.ts";
import { run, selfRenderCommand } from "./search.ts";
import { runSearchRender } from "./search_render.ts";

interface Call {
  cmd: string;
  args: readonly string[];
  options?: RunOptions;
}

function stripAnsi(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// -- selfRenderCommand: the fzf reload re-invokes gistan itself --------------

Deno.test("selfRenderCommand spells out deno run + entrypoint + permissions in dev", () => {
  const cmd = selfRenderCommand("/opt/deno/bin/deno", "file:///work/gistan/src/main.ts");
  assertEquals(
    cmd,
    '"/opt/deno/bin/deno" run --allow-read --allow-run --allow-env ' +
      '"/work/gistan/src/main.ts" __search-render {q}',
  );
});

Deno.test("selfRenderCommand calls the compiled binary directly", () => {
  const cmd = selfRenderCommand("/usr/local/bin/gistan", "file:///usr/local/bin/gistan");
  assertEquals(cmd, '"/usr/local/bin/gistan" __search-render {q}');
});

// -- __search-render: the TypeScript list renderer ----------------------------

/**
 * Answers the renderer's three rg call shapes: --files (enumeration),
 * -li (per-term file sets, keyed by the term after --), and -i -n -H
 * (first-hit lines, returned verbatim).
 */
function renderRunner(opts: {
  files: readonly string[];
  liByTerm?: Readonly<Record<string, readonly string[]>>;
  hits?: readonly string[];
}): { runner: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: Runner = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (cmd === "rg" && args[0] === "--files") {
      return Promise.resolve({
        code: 0,
        stdout: opts.files.map((f) => `${f}\n`).join(""),
        stderr: "",
      });
    }
    if (cmd === "rg" && args[0] === "-li") {
      const term = args[args.indexOf("--") + 1];
      const matched = opts.liByTerm?.[term] ?? [];
      // rg exits 1 on no match — the renderer must treat that as an empty set.
      return Promise.resolve({
        code: matched.length === 0 ? 1 : 0,
        stdout: matched.map((f) => `${f}\n`).join(""),
        stderr: "",
      });
    }
    if (cmd === "rg" && args[0] === "-i" && args.includes("-n")) {
      return Promise.resolve({
        code: 0,
        stdout: (opts.hits ?? []).map((h) => `${h}\n`).join(""),
        stderr: "",
      });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  return { runner, calls };
}

const FILES = ["gists/aa/one.md", "gists/bb/two.md", "gists/cc/three.md", "stars/o/g/note.md"];

Deno.test("render: space-separated terms are a file-level AND", async () => {
  const { runner } = renderRunner({
    files: FILES,
    liByTerm: {
      foo: ["gists/aa/one.md", "gists/bb/two.md"],
      bar: ["gists/bb/two.md", "stars/o/g/note.md"],
    },
    hits: ["gists/bb/two.md:4:some foo and bar text"],
  });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runSearchRender(["foo", "bar"], io.context), 0);
  assertEquals(stripAnsi(io.stdout), "bb/two.md:4: some foo and bar text\n");
});

Deno.test("render: !term excludes files containing it", async () => {
  const { runner } = renderRunner({
    files: FILES,
    liByTerm: {
      foo: ["gists/aa/one.md", "gists/bb/two.md"],
      bar: ["gists/bb/two.md"],
    },
    hits: ["gists/aa/one.md:2:only foo lives here"],
  });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runSearchRender(["foo", "!bar"], io.context), 0);
  assertEquals(stripAnsi(io.stdout), "aa/one.md:2: only foo lives here\n");
});

Deno.test("render: a path-only hit joins the set and renders without :line:", async () => {
  // "three" matches no content, but cc/three.md contains it in the path.
  const { runner } = renderRunner({ files: FILES, liByTerm: {}, hits: [] });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runSearchRender(["three"], io.context), 0);
  assertEquals(stripAnsi(io.stdout), "cc/three.md\n");
});

Deno.test("render: rows sort by display path (stars/ kept, gists/ stripped)", async () => {
  const { runner } = renderRunner({
    files: FILES,
    liByTerm: { note: ["stars/o/g/note.md", "gists/cc/three.md", "gists/aa/one.md"] },
    hits: [
      "stars/o/g/note.md:1:note text",
      "gists/cc/three.md:9:a note too",
      "gists/aa/one.md:5:note here",
    ],
  });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runSearchRender(["note"], io.context), 0);
  assertEquals(
    stripAnsi(io.stdout),
    "aa/one.md:5: note here\ncc/three.md:9: a note too\nstars/o/g/note.md:1: note text\n",
  );
});

Deno.test("render: the excerpt windows ~60 chars around the hit with … at trimmed edges", async () => {
  const text = "x".repeat(80) + "NEEDLE" + "y".repeat(80);
  const { runner } = renderRunner({
    files: FILES,
    liByTerm: { needle: ["gists/aa/one.md"] },
    hits: [`gists/aa/one.md:7:${text}`],
  });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runSearchRender(["needle"], io.context), 0);
  assertEquals(
    stripAnsi(io.stdout),
    `aa/one.md:7: …${"x".repeat(60)}NEEDLE${"y".repeat(60)}…\n`,
  );
});

Deno.test("render: excerpt slicing is character-safe for CJK and surrogate pairs", async () => {
  // 𠮷 is a surrogate pair; a byte- or code-unit-based slice would tear it.
  const text = "𠮷".repeat(70) + "日本語" + "𠮷".repeat(70);
  const { runner } = renderRunner({
    files: FILES,
    liByTerm: { 日本語: ["gists/aa/one.md"] },
    hits: [`gists/aa/one.md:3:${text}`],
  });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runSearchRender(["日本語"], io.context), 0);
  const excerptPart = stripAnsi(io.stdout).slice("aa/one.md:3: ".length).trimEnd();
  assertEquals(excerptPart, `…${"𠮷".repeat(60)}日本語${"𠮷".repeat(60)}…`);
  assertEquals(excerptPart.includes("�"), false);
});

Deno.test("render: paths stay default-colored, line/excerpt are dim, terms highlighted", async () => {
  const { runner } = renderRunner({
    files: FILES,
    liByTerm: { foo: ["gists/aa/one.md"] },
    hits: ["gists/aa/one.md:2:before foo after"],
  });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runSearchRender(["foo"], io.context), 0);
  assert(io.stdout.includes("\x1b[1;31mfoo\x1b[0m")); // term highlight
  assert(io.stdout.includes("\x1b[2m")); // dim for :line: and excerpt
});

Deno.test("render: empty query lists every file, display-path-sorted, without rg -li calls", async () => {
  const { runner, calls } = renderRunner({ files: FILES });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runSearchRender([], io.context), 0);
  assertEquals(
    stripAnsi(io.stdout),
    "aa/one.md\nbb/two.md\ncc/three.md\nstars/o/g/note.md\n",
  );
  assertEquals(calls.some((call) => call.args[0] === "-li"), false);
});

Deno.test("render: a query with only negative terms behaves like an empty query", async () => {
  const { runner, calls } = renderRunner({ files: FILES });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runSearchRender(["!wip"], io.context), 0);
  assertEquals(stripAnsi(io.stdout).split("\n").filter((l) => l !== "").length, FILES.length);
  assertEquals(calls.some((call) => call.args[0] === "-li"), false);
});

Deno.test("render: no surviving file prints nothing and exits 0", async () => {
  const { runner } = renderRunner({ files: FILES, liByTerm: {}, hits: [] });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runSearchRender(["zzz-not-anywhere"], io.context), 0);
  assertEquals(io.stdout, "");
});

// -- search run(): fzf wiring --------------------------------------------------

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

function fzfCall(calls: readonly Call[]): Call | undefined {
  return calls.find((call) => call.cmd === "fzf" && call.args.includes("--disabled"));
}

Deno.test("search runs fzf disabled+ansi with self-render reload binds", async () => {
  const { home } = await fixture();
  const { runner, calls } = searchRunner({ code: 130, stdout: "" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "search", args: ["react"] }, io.context), 0);
  const fzf = fzfCall(calls);
  assert(fzf !== undefined);
  assert(fzf.args.includes("--disabled"));
  assert(fzf.args.includes("--ansi"));
  assert(fzf.args.includes("react")); // initial --query
  const reloads = fzf.args.filter((arg) => arg.includes("reload:"));
  assertEquals(reloads.length, 2); // start + change
  for (const bind of reloads) {
    assert(bind.includes("__search-render {q}"));
  }
  assert(
    fzf.args.includes(
      "shift-up:preview-half-page-up,shift-down:preview-half-page-down,ctrl-u:clear-query",
    ),
  );
  assert(fzf.args.some((arg) => arg.startsWith("ctrl-o:execute-silent(")));
});

function previewArg(calls: readonly Call[]): string {
  const fzf = fzfCall(calls);
  if (fzf === undefined) return "";
  return String(fzf.args[fzf.args.indexOf("--preview") + 1] ?? "");
}

Deno.test("the preview self-invokes __preview, passing the bat token from the probe", async () => {
  // The default mock runner answers every probe with exit 0, so bat "exists".
  const { home } = await fixture();
  const { runner, calls } = searchRunner({ code: 130, stdout: "" });
  const io = memoryContext(runner, home, { editor: "vim" });
  assertEquals(await run({ name: "search", args: [] }, io.context), 0);
  assert(previewArg(calls).includes("__preview search bat {q} {1}"));

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
  assertEquals(await run({ name: "search", args: [] }, io2.context), 0);
  assert(previewArg(calls2).includes("__preview search nobat {q} {1}"));
});

Deno.test("ctrl-v hands the selection to config.viewer; unset viewer installs no bind", async () => {
  const { home } = await fixture({ viewer: "leaf" });
  const { runner, calls } = searchRunner({ code: 130, stdout: "" });
  const io = memoryContext(runner, home, { editor: "vim" });
  assertEquals(await run({ name: "search", args: [] }, io.context), 0);
  const bind = fzfCall(calls)?.args.find((arg) => arg.startsWith("ctrl-v:execute("));
  assert(bind !== undefined);
  assert(bind.includes('leaf "$f"'));
  // Same path resolution as the preview: display paths may lack gists/.
  assert(bind.includes('test -f "$f" || f="gists/$f"'));

  const { home: home2 } = await fixture();
  const { runner: runner2, calls: calls2 } = searchRunner({ code: 130, stdout: "" });
  const io2 = memoryContext(runner2, home2, { editor: "vim" });
  assertEquals(await run({ name: "search", args: [] }, io2.context), 0);
  assertEquals(fzfCall(calls2)?.args.some((arg) => arg.startsWith("ctrl-v:")), false);
});

Deno.test("a picked `path:line: excerpt` row opens the editor at that line", async () => {
  const { home } = await fixture();
  const { runner, calls } = searchRunner({ code: 0, stdout: "a/x.md:12: …some excerpt…\n" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "search", args: [] }, io.context), 0);
  const editor = calls.find((call) => call.cmd === "vim");
  assertEquals(editor?.args, ["+12", "gists/a/x.md"]);
  assertEquals(editor?.options?.interactive, true);
});

Deno.test("a path-only row opens without a line jump", async () => {
  const { home } = await fixture();
  const { runner, calls } = searchRunner({ code: 0, stdout: "a/x.md\n" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "search", args: [] }, io.context), 0);
  const editor = calls.find((call) => call.cmd === "vim");
  assertEquals(editor?.args, ["gists/a/x.md"]);
});

Deno.test("a stars/ pick keeps its prefix and opens read-only", async () => {
  const { home } = await fixture();
  const { runner, calls } = searchRunner({ code: 0, stdout: "stars/o/g/z.md:1: star text\n" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "search", args: [] }, io.context), 0);
  const editor = calls.find((call) => call.cmd === "vim");
  assertEquals(editor?.args, ["-R", "+1", "stars/o/g/z.md"]);
});

Deno.test("search --path prints the resolved absolute path and opens no editor", async () => {
  const { home, repo } = await fixture();
  const { runner, calls } = searchRunner({ code: 0, stdout: "a/x.md:12: hit\n" });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "search", args: ["-p"] }, io.context), 0);
  assertEquals(io.stdout, `${join(repo, "gists", "a", "x.md")}\n`);
  assertEquals(calls.some((call) => call.cmd === "vim"), false);
});

Deno.test("fzf no-match (1) and abort (130) are normal exits that open nothing", async () => {
  for (const code of [1, 130]) {
    const { home } = await fixture();
    const { runner, calls } = searchRunner({ code, stdout: "" });
    const io = memoryContext(runner, home, { editor: "vim" });

    assertEquals(await run({ name: "search", args: [] }, io.context), 0);
    assertEquals(calls.some((call) => call.cmd === "vim"), false);
  }
});

Deno.test("search requires rg and fzf", async () => {
  const { home } = await fixture();
  const runner: Runner = (cmd) =>
    Promise.resolve(
      cmd === "fzf"
        ? { code: EXIT_COMMAND_NOT_FOUND, stdout: "", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "search", args: [] }, io.context), 1);
  assert(io.stderr.includes("fzf is required for search"));
});

Deno.test("search requires init to have run", async () => {
  const home = await Deno.makeTempDir();
  const { runner } = searchRunner({ code: 0, stdout: "" });
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "search", args: [] }, io.context), 1);
  assert(io.stderr.includes("gistan root init"));
});

// -- temp file lifecycle (map file for ctrl-o + pattern file for preview) ------

/** The dirname->id map file path is embedded in the ctrl-o bind after the awk program. */
function mapFileFromArgs(args: readonly string[]): string | undefined {
  const bind = args.find((arg) => arg.startsWith("ctrl-o:execute-silent(")) ?? "";
  return bind.match(/\{print \$2\}' "([^"]+)"/)?.[1];
}

Deno.test("the map file mirrors the index and is removed after fzf exits", async () => {
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
    },
  });
  let mapFile: string | undefined;
  let contents: string | undefined;
  const runner: Runner = (cmd, args) => {
    if (cmd === "fzf" && args.includes("--disabled")) {
      mapFile = mapFileFromArgs(args);
      if (mapFile !== undefined) contents = Deno.readTextFileSync(mapFile);
      return Promise.resolve({ code: 130, stdout: "", stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "search", args: [] }, io.context), 0);
  assertEquals(contents, "alpha\tid-alpha\n");
  assert(mapFile !== undefined);
  assertEquals(await exists(mapFile), false);
});

Deno.test("the map file is removed even when fzf fails", async () => {
  const { home } = await fixture();
  let mapFile: string | undefined;
  const runner: Runner = (cmd, args) => {
    if (cmd === "fzf" && args.includes("--disabled")) {
      mapFile = mapFileFromArgs(args);
      return Promise.resolve({ code: 2, stdout: "", stderr: "boom" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "search", args: [] }, io.context), 1);
  assert(mapFile !== undefined);
  assertEquals(await exists(mapFile), false);
});
