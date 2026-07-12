import type { Runner } from "./proc.ts";
import { EXIT_COMMAND_NOT_FOUND } from "./proc.ts";

/**
 * "unavailable" = no candidate tool is installed. That is a legitimate setup
 * (headless Linux, minimal containers), so callers should stay silent.
 * "failed" = at least one tool exists but every attempt errored — worth a warning.
 */
export type ClipboardResult = "copied" | "unavailable" | "failed";

interface Candidate {
  readonly cmd: string;
  readonly args: readonly string[];
}

/**
 * Clipboard commands per OS, tried in order. Order is preference only: any
 * failure falls through to the next candidate, so e.g. wl-copy being installed
 * but erroring under X11 still lets xclip/xsel take over.
 */
export function clipboardCandidates(os: string): readonly Candidate[] {
  switch (os) {
    case "darwin":
      return [{ cmd: "pbcopy", args: [] }];
    case "windows":
      return [{ cmd: "clip", args: [] }];
    default:
      return [
        { cmd: "wl-copy", args: [] },
        { cmd: "xclip", args: ["-selection", "clipboard"] },
        { cmd: "xsel", args: ["--clipboard", "--input"] },
      ];
  }
}

export async function copyToClipboard(
  runner: Runner,
  text: string,
  os: string = Deno.build.os,
): Promise<ClipboardResult> {
  let sawFailure = false;
  for (const { cmd, args } of clipboardCandidates(os)) {
    const result = await runner(cmd, args, { stdin: text });
    if (result.code === 0) return "copied";
    // 127 = command not found (see proc.ts); anything else means a tool was
    // present but failed, which upgrades the final verdict to "failed".
    if (result.code !== EXIT_COMMAND_NOT_FOUND) sawFailure = true;
  }
  return sawFailure ? "failed" : "unavailable";
}
