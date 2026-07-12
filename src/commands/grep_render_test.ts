import { assertEquals } from "@std/assert";
import type { Runner, RunOptions } from "../core/proc.ts";
import { memoryContext } from "./test_helpers.ts";
import { runGrepRender } from "./grep_render.ts";

interface Call {
  cmd: string;
  args: readonly string[];
  options?: RunOptions;
}

/**
 * Answers the renderer's four rg call shapes (see grep_render.ts):
 * --files (enumeration), -i -- <q> over stdin (display-path hits),
 * --line-number ... (content hits), and -i --color=always -- <q> over
 * stdin (the final recolor pass, identity by default so plain-row
 * assertions still hold unless a test opts into `colorTransform`).
 */
function renderRunner(opts: {
  files?: readonly string[];
  pathMatches?: readonly string[];
  contentLines?: readonly string[];
  colorTransform?: (line: string) => string;
  /** Simulates an rg oddity: colored output has `delta` more (+) or fewer (-) lines than input. */
  colorCountDelta?: number;
}): { runner: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: Runner = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (cmd === "rg" && args[0] === "--files") {
      return Promise.resolve({
        code: 0,
        stdout: (opts.files ?? []).map((f) => `${f}\n`).join(""),
        stderr: "",
      });
    }
    if (cmd === "rg" && args[0] === "--line-number") {
      return Promise.resolve({
        code: 0,
        stdout: (opts.contentLines ?? []).map((l) => `${l}\n`).join(""),
        stderr: "",
      });
    }
    if (cmd === "rg" && args[0] === "-i" && args[1] === "--color=always") {
      const lines = (options?.stdin ?? "").split("\n").filter((l) => l !== "");
      const delta = opts.colorCountDelta ?? 0;
      const kept = delta < 0 ? lines.slice(0, Math.max(0, lines.length + delta)) : lines;
      const extra = delta > 0 ? Array.from({ length: delta }, () => "EXTRA") : [];
      const colored = [...kept, ...extra].map((l) => opts.colorTransform?.(l) ?? l);
      return Promise.resolve({
        code: 0,
        stdout: colored.map((l) => `${l}\n`).join(""),
        stderr: "",
      });
    }
    if (cmd === "rg" && args[0] === "-i") {
      // Path-hit pass: stdin is the display list, one entry per line.
      const lines = (options?.stdin ?? "").split("\n").filter((l) => l !== "");
      const matched = lines.filter((l) => (opts.pathMatches ?? []).includes(l));
      return Promise.resolve({
        code: matched.length === 0 ? 1 : 0,
        stdout: matched.map((l) => `${l}\n`).join(""),
        stderr: "",
      });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  return { runner, calls };
}

Deno.test("empty query lists every file in the row protocol, sorted by display", async () => {
  const files = ["gists/g2/two.md", "gists/g1/one.md", "stars/o/g3/note.md"];
  const { runner } = renderRunner({ files });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runGrepRender([], io.context), 0);
  assertEquals(
    io.stdout,
    "gists/g1/one.md\t\tone.md\n" +
      "stars/o/g3/note.md\t\tstars/o/note.md\n" +
      "gists/g2/two.md\t\ttwo.md\n",
  );
});

Deno.test("a display-path hit fans out to every real path that renders to it", async () => {
  // Two different gists both happen to contain a file literally named note.md
  // — displayPath hides the id, so both collapse to the same display string.
  const files = ["gists/g1/note.md", "gists/g2/note.md", "gists/g3/other.md"];
  const { runner } = renderRunner({ files, pathMatches: ["note.md"] });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runGrepRender(["note"], io.context), 0);
  const rows = io.stdout.split("\n").filter((l) => l !== "");
  assertEquals(rows.length, 2);
  assertEquals(
    new Set(rows),
    new Set(["gists/g1/note.md\t\tnote.md", "gists/g2/note.md\t\tnote.md"]),
  );
});

Deno.test("content hits are parsed from line:col:text and sorted by display then line", async () => {
  const files = ["gists/g1/apple.md", "gists/g2/banana.md"];
  const contentLines = [
    "gists/g2/banana.md:5:2:second hit in banana",
    "gists/g1/apple.md:10:1:first hit in apple",
    "gists/g1/apple.md:2:1:earlier hit in apple",
  ];
  const { runner } = renderRunner({ files, contentLines });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runGrepRender(["hit"], io.context), 0);
  assertEquals(
    io.stdout,
    "gists/g1/apple.md\t2\tapple.md:2:1:earlier hit in apple\n" +
      "gists/g1/apple.md\t10\tapple.md:10:1:first hit in apple\n" +
      "gists/g2/banana.md\t5\tbanana.md:5:2:second hit in banana\n",
  );
});

Deno.test("a path-only row (line 0) leads its file's own content hits", async () => {
  const files = ["gists/g1/query.md"];
  const { runner } = renderRunner({
    files,
    pathMatches: ["query.md"],
    contentLines: ["gists/g1/query.md:3:1:body hit"],
  });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runGrepRender(["query"], io.context), 0);
  assertEquals(
    io.stdout,
    "gists/g1/query.md\t\tquery.md\n" +
      "gists/g1/query.md\t3\tquery.md:3:1:body hit\n",
  );
});

Deno.test("a successful recolor pass (matching row count) is used verbatim", async () => {
  const files = ["gists/g1/one.md"];
  const { runner } = renderRunner({
    files,
    pathMatches: ["one.md"],
    colorTransform: (line) => `\x1b[31m${line}\x1b[0m`,
  });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runGrepRender(["o"], io.context), 0);
  assertEquals(io.stdout, "\x1b[31mgists/g1/one.md\t\tone.md\x1b[0m\n");
});

Deno.test("a colored-pass count mismatch falls back to the plain (uncolored) rows", async () => {
  const files = ["gists/g1/one.md", "gists/g2/two.md"];
  const { runner } = renderRunner({
    files,
    pathMatches: ["one.md", "two.md"],
    colorTransform: (line) => `\x1b[31m${line}\x1b[0m`,
    colorCountDelta: -1, // rg oddity: one row vanishes from the "colored" output
  });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runGrepRender(["o"], io.context), 0);
  assertEquals(
    io.stdout,
    "gists/g1/one.md\t\tone.md\n" +
      "gists/g2/two.md\t\ttwo.md\n",
  );
});

Deno.test("no path or content hits prints nothing, exits 0, and skips the recolor pass", async () => {
  const files = ["gists/g1/one.md"];
  const { runner, calls } = renderRunner({ files });
  const io = memoryContext(runner, "/nonexistent");
  assertEquals(await runGrepRender(["nomatch"], io.context), 0);
  assertEquals(io.stdout, "");
  assertEquals(calls.some((c) => c.args[0] === "-i" && c.args[1] === "--color=always"), false);
});
