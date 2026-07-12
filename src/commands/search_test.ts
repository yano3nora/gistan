import { assert, assertEquals } from "@std/assert";
import { EXIT_COMMAND_NOT_FOUND, type Runner, type RunOptions } from "../core/proc.ts";
import { saveState } from "../core/state.ts";
import { saveStarCache } from "../core/stars.ts";
import { FIELD_DELIMITER } from "./shared.ts";
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

// Four files across three published gist ids and one star mirror. displayPath
// hides the dirname entirely (ADR-0003), so — unlike the pre-v3 tests — the
// dirname itself can never carry a "path hit"; only the filename (and, for
// stars/, the owner segment) survive into the display string.
const FILES = ["gists/g1/one.md", "gists/g2/two.md", "gists/g3/three.md", "stars/o/g4/note.md"];

Deno.test("render: space-separated terms are a file-level AND", async () => {
  const { runner } = renderRunner({
    files: FILES,
    liByTerm: {
      foo: ["gists/g1/one.md", "gists/g2/two.md"],
      bar: ["gists/g2/two.md", "stars/o/g4/note.md"],
    },
    hits: ["gists/g2/two.md:4:some foo and bar text"],
  });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runSearchRender(["foo", "bar"], io.context), 0);
  assertEquals(stripAnsi(io.stdout), "gists/g2/two.md\t4\ttwo.md:4: some foo and bar text\n");
});

Deno.test("render: !term excludes files containing it", async () => {
  const { runner } = renderRunner({
    files: FILES,
    liByTerm: {
      foo: ["gists/g1/one.md", "gists/g2/two.md"],
      bar: ["gists/g2/two.md"],
    },
    hits: ["gists/g1/one.md:2:only foo lives here"],
  });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runSearchRender(["foo", "!bar"], io.context), 0);
  assertEquals(stripAnsi(io.stdout), "gists/g1/one.md\t2\tone.md:2: only foo lives here\n");
});

Deno.test("render: a path-only hit joins the set and renders without a line field", async () => {
  // "three" matches no content, but three.md contains it in the filename.
  const { runner } = renderRunner({ files: FILES, liByTerm: {}, hits: [] });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runSearchRender(["three"], io.context), 0);
  assertEquals(stripAnsi(io.stdout), "gists/g3/three.md\t\tthree.md\n");
});

Deno.test("render: rows sort by display path within a tier (stars/ owner kept, id stripped)", async () => {
  // "note" is in the star file's own filename, so it lands in the display-hit
  // tier; the two body-only hits follow in display-path order.
  const { runner } = renderRunner({
    files: FILES,
    liByTerm: { note: ["stars/o/g4/note.md", "gists/g3/three.md", "gists/g1/one.md"] },
    hits: [
      "stars/o/g4/note.md:1:note text",
      "gists/g3/three.md:9:a note too",
      "gists/g1/one.md:5:note here",
    ],
  });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runSearchRender(["note"], io.context), 0);
  assertEquals(
    stripAnsi(io.stdout),
    "stars/o/g4/note.md\t1\tstars/o/note.md:1: note text\n" +
      "gists/g1/one.md\t5\tone.md:5: note here\n" +
      "gists/g3/three.md\t9\tthree.md:9: a note too\n",
  );
});

Deno.test("render: display-hit files rank above content-only files, each tier path-sorted", async () => {
  // "foo" is in two filenames (foo-guide.md, foo-notes.md); only foo-guide.md
  // also mentions it in the body. one.md mentions it only in the body.
  const files = ["gists/g1/one.md", "gists/g2/foo-notes.md", "gists/g3/foo-guide.md"];
  const { runner } = renderRunner({
    files,
    liByTerm: { foo: ["gists/g1/one.md", "gists/g3/foo-guide.md"] },
    hits: [
      "gists/g1/one.md:2:body foo only",
      "gists/g3/foo-guide.md:3:foo in path and body",
    ],
  });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runSearchRender(["foo"], io.context), 0);
  assertEquals(
    stripAnsi(io.stdout),
    "gists/g3/foo-guide.md\t3\tfoo-guide.md:3: foo in path and body\n" +
      "gists/g2/foo-notes.md\t\tfoo-notes.md\n" +
      "gists/g1/one.md\t2\tone.md:2: body foo only\n",
  );
});

Deno.test("render: the excerpt windows ~60 chars around the hit with … at trimmed edges", async () => {
  const text = "x".repeat(80) + "NEEDLE" + "y".repeat(80);
  const { runner } = renderRunner({
    files: FILES,
    liByTerm: { needle: ["gists/g1/one.md"] },
    hits: [`gists/g1/one.md:7:${text}`],
  });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runSearchRender(["needle"], io.context), 0);
  assertEquals(
    stripAnsi(io.stdout),
    `gists/g1/one.md\t7\tone.md:7: …${"x".repeat(60)}NEEDLE${"y".repeat(60)}…\n`,
  );
});

Deno.test("render: excerpt slicing is character-safe for CJK and surrogate pairs", async () => {
  // 𠮷 is a surrogate pair; a byte- or code-unit-based slice would tear it.
  const text = "𠮷".repeat(70) + "日本語" + "𠮷".repeat(70);
  const { runner } = renderRunner({
    files: FILES,
    liByTerm: { 日本語: ["gists/g1/one.md"] },
    hits: [`gists/g1/one.md:3:${text}`],
  });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runSearchRender(["日本語"], io.context), 0);
  const line = stripAnsi(io.stdout);
  const prefix = "gists/g1/one.md\t3\tone.md:3: ";
  assert(line.startsWith(prefix));
  const excerptPart = line.slice(prefix.length).trimEnd();
  assertEquals(excerptPart, `…${"𠮷".repeat(60)}日本語${"𠮷".repeat(60)}…`);
  assertEquals(excerptPart.includes("�"), false);
});

Deno.test("render: paths stay default-colored, line/excerpt are dim, terms highlighted", async () => {
  const { runner } = renderRunner({
    files: FILES,
    liByTerm: { foo: ["gists/g1/one.md"] },
    hits: ["gists/g1/one.md:2:before foo after"],
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
    "gists/g1/one.md\t\tone.md\n" +
      "stars/o/g4/note.md\t\tstars/o/note.md\n" +
      "gists/g3/three.md\t\tthree.md\n" +
      "gists/g2/two.md\t\ttwo.md\n",
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

// -- __search-render: description matching / suffix (ADR-0003) ---------------
// loadDescriptionsSafe() reads ".gistan/state.json" relative to cwd, so these
// need a real fixture repo + chdir (restored in finally — deno test runs
// every file in one process).

Deno.test("render: a description hit joins the result set and appends a dim, highlighted suffix", async () => {
  const { repo } = await fixture();
  await saveState(repo, {
    version: 3,
    gists: {
      g1: {
        visibility: "public",
        description: "a react tutorial",
        remote_updated_at: AT,
        files: {},
      },
    },
    locals: {},
  });
  const cwd = Deno.cwd();
  Deno.chdir(repo);
  try {
    const files = ["gists/g1/one.md"];
    const { runner } = renderRunner({ files, liByTerm: {}, hits: [] });
    const io = memoryContext(runner, "/nonexistent");
    assertEquals(await runSearchRender(["react"], io.context), 0);
    assertEquals(stripAnsi(io.stdout), "gists/g1/one.md\t\tone.md  — a react tutorial\n");
    assert(io.stdout.includes("\x1b[1;31mreact\x1b[0m")); // the term is highlighted inside the desc too
  } finally {
    Deno.chdir(cwd);
  }
});

Deno.test("render: a description-only hit ranks above a content-only hit for the same query", async () => {
  const { repo } = await fixture();
  await saveState(repo, {
    version: 3,
    gists: {
      g1: { visibility: "public", description: "", remote_updated_at: AT, files: {} },
      g2: {
        visibility: "secret",
        description: "about react hooks",
        remote_updated_at: AT,
        files: {},
      },
    },
    locals: {},
  });
  const cwd = Deno.cwd();
  Deno.chdir(repo);
  try {
    const files = ["gists/g1/alpha.md", "gists/g2/beta.md"];
    const { runner } = renderRunner({
      files,
      liByTerm: { react: ["gists/g1/alpha.md"] }, // only alpha.md's body mentions react
      hits: ["gists/g1/alpha.md:3:uses react here"],
    });
    const io = memoryContext(runner, "/nonexistent");
    assertEquals(await runSearchRender(["react"], io.context), 0);
    assertEquals(
      stripAnsi(io.stdout),
      "gists/g2/beta.md\t\tbeta.md  — about react hooks\n" +
        "gists/g1/alpha.md\t3\talpha.md:3: uses react here\n",
    );
  } finally {
    Deno.chdir(cwd);
  }
});

Deno.test("render: empty query also appends description suffixes, still display-sorted", async () => {
  const { repo } = await fixture();
  await saveState(repo, {
    version: 3,
    gists: { g1: { visibility: "public", description: "d1", remote_updated_at: AT, files: {} } },
    locals: { _loc: { description: "d2" } },
  });
  await saveStarCache(repo, {
    version: 1,
    stars: { s1: { owner: "octo", description: "d3", updated_at: AT, fetched_at: AT } },
  });
  const cwd = Deno.cwd();
  Deno.chdir(repo);
  try {
    const files = ["gists/g1/a.md", "gists/_loc/b.md", "stars/octo/s1/c.md"];
    const { runner } = renderRunner({ files });
    const io = memoryContext(runner, "/nonexistent");
    assertEquals(await runSearchRender([], io.context), 0);
    assertEquals(
      stripAnsi(io.stdout),
      "gists/g1/a.md\t\ta.md  — d1\n" +
        "gists/_loc/b.md\t\tb.md  — d2\n" +
        "stars/octo/s1/c.md\t\tstars/octo/c.md  — d3\n",
    );
  } finally {
    Deno.chdir(cwd);
  }
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
      "shift-up:preview-half-page-up,shift-down:preview-half-page-down,ctrl-u:clear-query," +
        "ctrl-/:toggle-preview-wrap",
    ),
  );
  // Long prose must wrap: fzf previews cannot scroll horizontally.
  assertEquals(fzf.args[fzf.args.indexOf("--preview-window") + 1], "wrap");
  // Path-sorted rows read A->Z from the top; never inherit a bottom-up layout.
  assertEquals(fzf.args[fzf.args.indexOf("--layout") + 1], "reverse");
  assert(fzf.args.some((arg) => arg.startsWith("ctrl-o:execute-silent(")));
  assert(fzf.args.some((arg) => arg.startsWith("ctrl-y:execute-silent(")));
});

Deno.test("fzf gets the row-protocol delimiter and with-nth so ids stay hidden", async () => {
  const { home } = await fixture();
  const { runner, calls } = searchRunner({ code: 130, stdout: "" });
  const io = memoryContext(runner, home, { editor: "vim" });
  assertEquals(await run({ name: "search", args: [] }, io.context), 0);
  const fzf = fzfCall(calls);
  assert(fzf !== undefined);
  assertEquals(fzf.args[fzf.args.indexOf("--delimiter") + 1], "\t");
  assertEquals(fzf.args[fzf.args.indexOf("--with-nth") + 1], "3..");
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
  assertEquals(bind, "ctrl-v:execute(test -f {1} && leaf {1})");

  const { home: home2 } = await fixture();
  const { runner: runner2, calls: calls2 } = searchRunner({ code: 130, stdout: "" });
  const io2 = memoryContext(runner2, home2, { editor: "vim" });
  assertEquals(await run({ name: "search", args: [] }, io2.context), 0);
  assertEquals(fzfCall(calls2)?.args.some((arg) => arg.startsWith("ctrl-v:")), false);
});

Deno.test("a picked row opens the editor at its line field", async () => {
  const { home } = await fixture();
  const row = `gists/a/x.md${FIELD_DELIMITER}12${FIELD_DELIMITER}x.md:12: …some excerpt…`;
  const { runner, calls } = searchRunner({ code: 0, stdout: `${row}\n` });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "search", args: [] }, io.context), 0);
  const editor = calls.find((call) => call.cmd === "vim");
  assertEquals(editor?.args, ["+12", "gists/a/x.md"]);
  assertEquals(editor?.options?.interactive, true);
});

Deno.test("a path-only row (empty line field) opens without a line jump", async () => {
  const { home } = await fixture();
  const row = `gists/a/x.md${FIELD_DELIMITER}${FIELD_DELIMITER}x.md`;
  const { runner, calls } = searchRunner({ code: 0, stdout: `${row}\n` });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "search", args: [] }, io.context), 0);
  const editor = calls.find((call) => call.cmd === "vim");
  assertEquals(editor?.args, ["gists/a/x.md"]);
});

Deno.test("a stars/ pick keeps its real path and opens read-only", async () => {
  const { home } = await fixture();
  const row = `stars/o/g/z.md${FIELD_DELIMITER}1${FIELD_DELIMITER}stars/o/z.md:1: star text`;
  const { runner, calls } = searchRunner({ code: 0, stdout: `${row}\n` });
  const io = memoryContext(runner, home, { editor: "vim" });

  assertEquals(await run({ name: "search", args: [] }, io.context), 0);
  const editor = calls.find((call) => call.cmd === "vim");
  assertEquals(editor?.args, ["-R", "+1", "stars/o/g/z.md"]);
});

Deno.test("search --path prints the resolved absolute path (real, id-bearing) and opens no editor", async () => {
  const { home, repo } = await fixture();
  const row = `gists/a/x.md${FIELD_DELIMITER}12${FIELD_DELIMITER}x.md:12: hit`;
  const { runner, calls } = searchRunner({ code: 0, stdout: `${row}\n` });
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
