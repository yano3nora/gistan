import { assert, assertEquals } from "@std/assert";
import type { Runner } from "../core/proc.ts";
import { memoryContext } from "../testing.ts";
import { byteToCharIndex, overlaySpans, runPreviewRender, searchSpans } from "./preview_render.ts";
import { join } from "./test_helpers.ts";

const REV = "\x1b[7m";
const OFF = "\x1b[27m";

async function fileFixture(content: string): Promise<string> {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "note.md");
  await Deno.writeTextFile(path, content);
  return path;
}

function runnerWith(
  handler: (cmd: string, args: readonly string[]) => { code: number; stdout: string } | undefined,
): Runner {
  return (cmd, args) =>
    Promise.resolve({ stderr: "", ...(handler(cmd, args) ?? { code: 0, stdout: "" }) });
}

// -- unit: span math ----------------------------------------------------------

Deno.test("searchSpans finds every occurrence of every term, merged", () => {
  const spans = searchSpans(["Deno loves deno", "nothing here"], ["deno", "eno"]);
  // "eno" overlaps both "Deno" hits; merged into the wider spans.
  assertEquals(spans.get(1), [[0, 4], [11, 15]]);
  assertEquals(spans.has(2), false);
});

Deno.test("byteToCharIndex converts UTF-8 byte offsets over CJK text", () => {
  const text = "日本語 hello";
  // "日本語 " = 3*3 + 1 = 10 bytes, 4 chars.
  assertEquals(byteToCharIndex(text, 10), 4);
  assertEquals(byteToCharIndex(text, 15), 9);
  assertEquals(byteToCharIndex(text, 0), 0);
});

Deno.test("overlaySpans wraps matches in reverse video and skips ANSI codes", () => {
  assertEquals(overlaySpans("plain deno text", [[6, 10]]), `plain ${REV}deno${OFF} text`);
  // bat-style colored line: escape sequences must not advance the plain index.
  const colored = "\x1b[38;5;1mDeno\x1b[0m rocks";
  assertEquals(
    overlaySpans(colored, [[0, 4]]),
    `\x1b[38;5;1m${REV}Deno${OFF}\x1b[0m rocks`,
  );
});

// -- runPreviewRender: search mode -------------------------------------------

Deno.test("search preview emphasizes terms and starts ~5 lines above the first hit", async () => {
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
  lines[7] = "here is the deno hit"; // line 8
  const path = await fileFixture(lines.join("\n") + "\n");
  const io = memoryContext(runnerWith(() => undefined), "/tmp");

  assertEquals(await runPreviewRender(["search", "nobat", "deno", path], io.context), 0);
  const out = io.stdout.split("\n");
  assertEquals(out[0], "line 3"); // 8 - 5
  assert(io.stdout.includes(`${REV}deno${OFF}`));
});

Deno.test("search preview layers term emphasis over bat output when line counts match", async () => {
  const path = await fileFixture("alpha\nbeta deno\n");
  const batOut = "\x1b[38;5;2malpha\x1b[0m\n\x1b[38;5;2mbeta deno\x1b[0m\n";
  const runner = runnerWith((cmd, args) => {
    if (cmd === "bat" && args.includes("--color=always")) return { code: 0, stdout: batOut };
    return undefined;
  });
  const io = memoryContext(runner, "/tmp");

  assertEquals(await runPreviewRender(["search", "bat", "deno", path], io.context), 0);
  assert(io.stdout.includes("\x1b[38;5;2m")); // bat's colors survive
  assert(io.stdout.includes(`${REV}deno${OFF}`)); // emphasis layered on top
});

Deno.test("a bat output that does not map 1:1 onto the file falls back to plain text", async () => {
  const path = await fileFixture("alpha\nbeta deno\n");
  const runner = runnerWith((cmd) =>
    cmd === "bat" ? { code: 0, stdout: "\x1b[31monly-one-line\x1b[0m\n" } : undefined
  );
  const io = memoryContext(runner, "/tmp");

  assertEquals(await runPreviewRender(["search", "bat", "deno", path], io.context), 0);
  assert(!io.stdout.includes("only-one-line"));
  assert(io.stdout.includes(`beta ${REV}deno${OFF}`));
});

Deno.test("an empty or vanished path is a silent no-op", async () => {
  const io = memoryContext(runnerWith(() => undefined), "/tmp");
  assertEquals(await runPreviewRender(["search", "nobat", "q", ""], io.context), 0);
  assertEquals(await runPreviewRender(["search", "nobat", "q", "/no/such/file"], io.context), 0);
  assertEquals(io.stdout, "");
});

// -- runPreviewRender: grep mode ----------------------------------------------

function rgJsonMatch(lineNumber: number, text: string, start: number, end: number): string {
  return JSON.stringify({
    type: "match",
    data: { line_number: lineNumber, lines: { text: `${text}\n` }, submatches: [{ start, end }] },
  });
}

Deno.test("grep preview takes spans from rg --json (byte offsets, CJK-safe) and anchors on {2}", async () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  lines[11] = "日本語 deno 日本語"; // line 12; "deno" starts at byte 10, char 4
  const path = await fileFixture(lines.join("\n") + "\n");
  const runner = runnerWith((cmd, args) => {
    if (cmd === "rg" && args.includes("--json")) {
      return { code: 0, stdout: rgJsonMatch(12, lines[11], 10, 14) + "\n" };
    }
    return undefined;
  });
  const io = memoryContext(runner, "/tmp");

  assertEquals(await runPreviewRender(["grep", "nobat", "deno", path, "12"], io.context), 0);
  const out = io.stdout.split("\n");
  assertEquals(out[0], "line 7"); // 12 - 5
  assert(io.stdout.includes(`日本語 ${REV}deno${OFF} 日本語`));
});

Deno.test("grep preview with an empty query shows the whole file untouched", async () => {
  const path = await fileFixture("one\ntwo\n");
  let rgRan = false;
  const runner = runnerWith((cmd, args) => {
    if (cmd === "rg" && args.includes("--json")) rgRan = true;
    return undefined;
  });
  const io = memoryContext(runner, "/tmp");

  assertEquals(await runPreviewRender(["grep", "nobat", "", path, ""], io.context), 0);
  assertEquals(rgRan, false);
  assertEquals(io.stdout, "one\ntwo\n");
});
