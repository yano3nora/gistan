import { assertEquals } from "@std/assert";
import { clipboardCandidates, copyToClipboard } from "./clipboard.ts";
import type { Runner } from "./proc.ts";

/** Fake runner mapping cmd -> exit code (unknown cmds = 127), recording calls. */
function fakeRunner(codes: Record<string, number>) {
  const calls: { cmd: string; args: readonly string[]; stdin?: string }[] = [];
  const runner: Runner = (cmd, args, opt) => {
    calls.push({ cmd, args, stdin: opt?.stdin });
    return Promise.resolve({ code: codes[cmd] ?? 127, stdout: "", stderr: "" });
  };
  return { runner, calls };
}

Deno.test("clipboardCandidates picks the platform tool", () => {
  assertEquals(clipboardCandidates("darwin").map((c) => c.cmd), ["pbcopy"]);
  assertEquals(clipboardCandidates("windows").map((c) => c.cmd), ["clip"]);
  assertEquals(clipboardCandidates("linux").map((c) => c.cmd), ["wl-copy", "xclip", "xsel"]);
  // Unknown OSes get the POSIX chain rather than no clipboard at all.
  assertEquals(clipboardCandidates("freebsd").map((c) => c.cmd), ["wl-copy", "xclip", "xsel"]);
});

Deno.test("copyToClipboard pipes text to the first tool that succeeds", async () => {
  const { runner, calls } = fakeRunner({ pbcopy: 0 });
  assertEquals(await copyToClipboard(runner, "https://x", "darwin"), "copied");
  assertEquals(calls, [{ cmd: "pbcopy", args: [], stdin: "https://x" }]);
});

Deno.test("copyToClipboard falls through missing tools to the next candidate", async () => {
  const { runner, calls } = fakeRunner({ xclip: 0 });
  assertEquals(await copyToClipboard(runner, "t", "linux"), "copied");
  assertEquals(calls.map((c) => c.cmd), ["wl-copy", "xclip"]);
  assertEquals(calls[1].args, ["-selection", "clipboard"]);
});

Deno.test("copyToClipboard falls through a failing tool (e.g. wl-copy under X11)", async () => {
  const { runner, calls } = fakeRunner({ "wl-copy": 1, xsel: 0 });
  assertEquals(await copyToClipboard(runner, "t", "linux"), "copied");
  assertEquals(calls.map((c) => c.cmd), ["wl-copy", "xclip", "xsel"]);
});

Deno.test("copyToClipboard reports unavailable when no tool is installed", async () => {
  const { runner } = fakeRunner({});
  assertEquals(await copyToClipboard(runner, "t", "linux"), "unavailable");
});

Deno.test("copyToClipboard reports failed when a tool exists but errors", async () => {
  const { runner } = fakeRunner({ "wl-copy": 1 });
  assertEquals(await copyToClipboard(runner, "t", "linux"), "failed");
});
